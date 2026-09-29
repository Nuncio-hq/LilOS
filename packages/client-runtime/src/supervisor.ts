import { atom, type WritableAtom } from "nanostores";
import { RelayError } from "./client";

/**
 * The one transport retry owner (#154) — ported from T3 Code
 * `packages/client-runtime/src/connection/supervisor.ts` (MIT), minus the
 * Effect runtime. A signal-driven run loop owns every reconnect: nothing
 * outside it ever redials. The policy values are the mobile contract —
 * backoff ladder [3,4,8,16]s, the ladder resets after 30s of a healthy
 * connection, a dead socket on foreground reconnects without the first rung,
 * and a socket that survived >5min in the background is always replaced.
 *
 * Runtime-neutral by construction: `connect`, `probe`, and the OS signals
 * (`setOnline`, `appForegrounded`) are injected — React Native's
 * AppState/NetInfo adapt in apps/mobile, a browser can adapt later.
 */

export const RETRY_DELAYS_MS = [3_000, 4_000, 8_000, 16_000] as const;
export const BACKOFF_RESET_AFTER_MS = 30_000;
export const CONNECT_TIMEOUT_MS = 15_000;
export const PROBE_TIMEOUT_MS = 3_000;
export const REPLACE_AFTER_BACKGROUND_MS = 5 * 60_000;

/** A live connection the supervisor is holding. Opaque to the supervisor. */
export interface SupervisedConnection {
  /** Resolves when the transport drops on its own; rejects on error. */
  readonly closed: Promise<unknown>;
  /** Deliberate teardown — idle means the close is wanted. */
  close(): void;
}

export type SupervisorPhase =
  /** `disconnect()`ed — nothing wanted. */
  | "idle"
  /** An establishment attempt is in flight (open + handshake). */
  | "connecting"
  /** Holding a live lease. */
  | "connected"
  /** Sleeping until `retryAt` before the next attempt. */
  | "backoff"
  /** No network — parked until a change instead of burning retries. */
  | "offline"
  /** A failure retries can't fix (bad credential, protocol mismatch). */
  | "blocked";

export interface SupervisorState {
  readonly phase: SupervisorPhase;
  /** 1-based attempt number of the current or last attempt. */
  readonly attempt: number;
  /** Epoch ms the next attempt fires — set only while `backoff`. */
  readonly retryAt?: number;
  /** Last failure's message — what the UI surfaces under "Details". */
  readonly lastError?: string;
}

type SupervisorSignal =
  | { readonly tag: "connect" }
  | { readonly tag: "disconnect" }
  | { readonly tag: "retry" }
  | { readonly tag: "network"; readonly online: boolean }
  /** Foreground wakeup; `backgroundedMs` = time spent suspended. */
  | { readonly tag: "foreground"; readonly backgroundedMs: number };

type AttemptOutcome =
  | {
      readonly tag: "interrupted";
      readonly established: boolean;
      readonly stable: boolean;
      readonly resetRetry: boolean;
    }
  | {
      readonly tag: "failure";
      readonly established: boolean;
      readonly stable: boolean;
      readonly error: unknown;
    };

type EstablishmentEvent =
  | { readonly tag: "ok"; readonly lease: SupervisedConnection }
  | { readonly tag: "error"; readonly error: unknown }
  | { readonly tag: "interrupted"; readonly resetRetry: boolean }
  | { readonly tag: "timeout" };

type ConnectedEvent =
  | { readonly tag: "dropped"; readonly error?: unknown }
  | { readonly tag: "interrupt"; readonly resetRetry: boolean }
  | { readonly tag: "replace" }
  | { readonly tag: "probeFailed"; readonly error: unknown };

const ABORTED = new Error("supervisor wait aborted");

function isAbort(error: unknown): boolean {
  return error === ABORTED;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface ConnectionSupervisorOptions {
  /** One establishment attempt; reject = a transient failure, ladder eats it. */
  readonly connect: (signal: AbortSignal) => Promise<SupervisedConnection>;
  /** Health check on the held lease; reject/timeout = replace it. */
  readonly probe?: (connection: SupervisedConnection) => Promise<unknown>;
  /** A failure retries can't fix → `blocked` until a wake. Default: unauthenticated / device_revoked / protocol_version_mismatch. */
  readonly isFatal?: (error: unknown) => boolean;
  readonly retryDelaysMs?: readonly number[];
  readonly stableAfterMs?: number;
  readonly connectTimeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly replaceAfterBackgroundMs?: number;
  readonly now?: () => number;
  /** A blocked failure surfaces here (e.g. forget a revoked credential). */
  readonly onFatalError?: (error: unknown) => void;
}

const defaultIsFatal = (error: unknown): boolean =>
  error instanceof RelayError &&
  (error.code === "unauthenticated" ||
    error.code === "device_revoked" ||
    error.code === "protocol_version_mismatch");

export class ConnectionSupervisor {
  readonly state: WritableAtom<SupervisorState> = atom<SupervisorState>({
    phase: "idle",
    attempt: 0,
  });

  private readonly options;
  private desired = false;
  private online = true;
  private resetRetryPending = false;
  private wakeProbeFailed = false;
  private disposed = false;

  private readonly queue: SupervisorSignal[] = [];
  private readonly waiters = new Set<(signal: SupervisorSignal) => void>();

  constructor(options: ConnectionSupervisorOptions) {
    // `??` per key — a spread would let an explicit `undefined` clobber a
    // default and kill the run loop on the first failed attempt.
    this.options = {
      connect: options.connect,
      probe: options.probe,
      isFatal: options.isFatal ?? defaultIsFatal,
      retryDelaysMs: options.retryDelaysMs ?? RETRY_DELAYS_MS,
      stableAfterMs: options.stableAfterMs ?? BACKOFF_RESET_AFTER_MS,
      connectTimeoutMs: options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
      probeTimeoutMs: options.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
      replaceAfterBackgroundMs:
        options.replaceAfterBackgroundMs ?? REPLACE_AFTER_BACKGROUND_MS,
      now: options.now ?? Date.now,
      onFatalError: options.onFatalError,
    };
    void this.run().catch((error) => {
      // The run loop only throws on a bug inside the supervisor itself.
      if (!this.disposed) console.error("[supervisor] run loop died", error);
    });
  }

  /* ------------------------------ public API ----------------------------- */

  /** Want a connection — kicks the loop out of `idle`. */
  connect(): void {
    this.desired = true;
    this.emit({ tag: "connect" });
  }

  /** Stop wanting one — any in-flight attempt and held lease are dropped. */
  disconnect(): void {
    this.desired = false;
    this.emit({ tag: "disconnect" });
  }

  /** The manual "try again": resets the ladder and fires an attempt now. */
  retryNow(): void {
    this.resetRetryPending = true;
    this.emit({ tag: "retry" });
  }

  /** Network reachability change — offline parks the loop until `true`. */
  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    this.emit({ tag: "network", online });
  }

  /**
   * Foreground wakeup. `backgroundedMs` over `replaceAfterBackgroundMs` always
   * replaces the socket (mobile OSes suspend them without a close event);
   * shorter, the probe decides keep-vs-replace in ≤ `probeTimeoutMs`.
   */
  appForegrounded(backgroundedMs: number): void {
    this.emit({ tag: "foreground", backgroundedMs });
  }

  dispose(): void {
    this.disposed = true;
    this.desired = false;
    for (const waiter of [...this.waiters]) waiter({ tag: "disconnect" });
    this.waiters.clear();
    this.queue.length = 0;
  }

  /* ------------------------------- signals ------------------------------- */

  private emit(signal: SupervisorSignal): void {
    if (this.disposed) return;
    const waiter = this.waiters.values().next().value;
    if (waiter) {
      this.waiters.delete(waiter);
      waiter(signal);
    } else {
      this.queue.push(signal);
    }
  }

  private takeSignal(abort?: AbortSignal): Promise<SupervisorSignal> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (abort?.aborted) return Promise.reject(ABORTED);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.waiters.delete(waiter);
        reject(ABORTED);
      };
      const waiter = (signal: SupervisorSignal) => {
        abort?.removeEventListener("abort", onAbort);
        resolve(signal);
      };
      this.waiters.add(waiter);
      abort?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private sleep(ms: number, abort?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (abort?.aborted) {
        reject(ABORTED);
        return;
      }
      const timer = setTimeout(() => {
        abort?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(ABORTED);
      };
      abort?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /* --------------------------------- waits ------------------------------- */

  /**
   * Signals that abandon an in-flight establishment. Resolves with
   * `resetRetry`: a long-background resume skips the ladder; everything else
   * just re-loops and re-reads intent.
   */
  private async waitForEstablishmentInterrupt(
    abort: AbortSignal,
  ): Promise<boolean> {
    for (;;) {
      const signal = await this.takeSignal(abort);
      switch (signal.tag) {
        case "disconnect":
        case "retry":
          return false;
        case "network":
          if (!signal.online) return false;
          break;
        case "connect":
          break;
        case "foreground":
          if (signal.backgroundedMs > this.options.replaceAfterBackgroundMs) {
            return true;
          }
          break;
      }
    }
  }

  /**
   * Signals against a live lease: an interrupt drops it, a long background
   * replaces it, a short one probes first and keeps it only if it answers.
   */
  private async monitorConnected(
    connection: SupervisedConnection,
    abort: AbortSignal,
  ): Promise<ConnectedEvent> {
    for (;;) {
      const signal = await this.takeSignal(abort);
      switch (signal.tag) {
        case "disconnect":
        case "retry":
          return { tag: "interrupt", resetRetry: false };
        case "network":
          if (!signal.online) return { tag: "interrupt", resetRetry: false };
          break;
        case "connect":
          break;
        case "foreground": {
          if (signal.backgroundedMs > this.options.replaceAfterBackgroundMs) {
            return { tag: "replace" };
          }
          const probed = this.probe(connection);
          // Probe-scoped abort: when the probe settles, the in-flight
          // takeSignal below must be cancelled or it would swallow the next
          // real signal (its waiter outlives the lost race).
          const probeAbort = new AbortController();
          const abortProbeTake = () => probeAbort.abort();
          abort.addEventListener("abort", abortProbeTake, { once: true });
          try {
            for (;;) {
              const race = await Promise.race([
                probed.then(
                  (): { tag: "done"; error?: unknown } => ({ tag: "done" }),
                  (error) => ({ tag: "done" as const, error }),
                ),
                this.takeSignal(probeAbort.signal).then(
                  (sig): { tag: "signal"; sig: SupervisorSignal } => ({
                    tag: "signal",
                    sig,
                  }),
                ),
              ]);
              if (race.tag === "done") {
                if (race.error !== undefined) {
                  return { tag: "probeFailed", error: race.error };
                }
                break; // probe answered — keep the lease, back to monitoring
              }
              const sig = race.sig;
              switch (sig.tag) {
                case "disconnect":
                case "retry":
                  return { tag: "interrupt", resetRetry: false };
                case "network":
                  if (!sig.online)
                    return { tag: "interrupt", resetRetry: false };
                  break;
                case "foreground":
                  if (
                    sig.backgroundedMs > this.options.replaceAfterBackgroundMs
                  ) {
                    return { tag: "replace" };
                  }
                  break;
                case "connect":
                  break;
              }
              // Non-interrupting signal — keep waiting on the same probe.
            }
          } finally {
            probeAbort.abort();
            abort.removeEventListener("abort", abortProbeTake);
          }
          break;
        }
      }
    }
  }

  /** Backoff wait; resolves true when an app-foreground wake should skip the ladder. */
  private async waitForRetrySignal(delayMs: number): Promise<boolean> {
    // Abort on timeout: the losing takeSignal would otherwise park a stale
    // waiter that swallows the next real signal.
    const ac = new AbortController();
    try {
      return await Promise.race([
        this.sleep(delayMs).then(() => false),
        this.takeSignal(ac.signal).then(
          (signal) => signal.tag === "foreground",
        ),
      ]);
    } finally {
      ac.abort();
    }
  }

  /** Idle/offline/blocked wait: take one signal; a foreground wake resets the ladder. */
  private async waitForSignal(): Promise<boolean> {
    const signal = await this.takeSignal();
    return signal.tag === "foreground";
  }

  /* ------------------------------ the run loop ---------------------------- */

  private probe(connection: SupervisedConnection): Promise<unknown> {
    const fn = this.options.probe;
    if (!fn) return Promise.resolve();
    return Promise.race([
      Promise.resolve().then(() => fn(connection)),
      this.sleep(this.options.probeTimeoutMs).then(() => {
        throw new RelayError("connection probe timed out", "timeout");
      }),
    ]);
  }

  private retryDelayMs(failureCount: number): number {
    const ladder = this.options.retryDelaysMs;
    return ladder[Math.min(failureCount, ladder.length - 1)] ?? 16_000;
  }

  private setState(
    phase: SupervisorPhase,
    extra: Partial<SupervisorState> = {},
  ): void {
    this.state.set({
      phase,
      attempt: extra.attempt ?? this.state.get().attempt,
      ...extra,
    });
  }

  private async runAttempt(attempt: number): Promise<AttemptOutcome> {
    this.setState("connecting", { attempt, retryAt: undefined });
    const estAbort = new AbortController();
    const monitorAbort = new AbortController();
    let lease: SupervisedConnection | undefined;
    try {
      const established = Promise.resolve()
        .then(() => this.options.connect(estAbort.signal))
        .then(
          (l): EstablishmentEvent => ({ tag: "ok", lease: l }),
          (error): EstablishmentEvent => ({ tag: "error", error }),
        );
      const interrupted = this.waitForEstablishmentInterrupt(
        estAbort.signal,
      ).then(
        (resetRetry): EstablishmentEvent => ({
          tag: "interrupted",
          resetRetry,
        }),
      );
      const timedOut = this.sleep(
        this.options.connectTimeoutMs,
        estAbort.signal,
      ).then((): EstablishmentEvent => ({ tag: "timeout" }));
      const first = await Promise.race([established, interrupted, timedOut]);
      estAbort.abort();
      if (first.tag === "interrupted") {
        // The abandoned attempt may still produce a lease — close it late.
        void established.then((r) => {
          if (r.tag === "ok") r.lease.close();
        });
        return {
          tag: "interrupted",
          established: false,
          stable: false,
          resetRetry: first.resetRetry,
        };
      }
      if (first.tag === "timeout") {
        void established.then((r) => {
          if (r.tag === "ok") r.lease.close();
        });
        return {
          tag: "failure",
          established: false,
          stable: false,
          error: new RelayError(
            `no connection within ${this.options.connectTimeoutMs} ms`,
            "connect_timeout",
          ),
        };
      }
      if (first.tag === "error") {
        return {
          tag: "failure",
          established: false,
          stable: false,
          error: first.error,
        };
      }

      lease = first.lease;
      if (!this.desired || !this.online) {
        return {
          tag: "interrupted",
          established: false,
          stable: false,
          resetRetry: false,
        };
      }
      const connectedAt = this.options.now();
      this.setState("connected", { attempt, lastError: undefined });

      const dropped = lease.closed.then(
        (): ConnectedEvent => ({ tag: "dropped" }),
        (error): ConnectedEvent => ({ tag: "dropped", error }),
      );
      const monitored = this.monitorConnected(lease, monitorAbort.signal);
      const next = await Promise.race([dropped, monitored]);
      const stable =
        this.options.now() - connectedAt >= this.options.stableAfterMs;
      if (next.tag === "dropped") {
        return next.error !== undefined
          ? { tag: "failure", established: true, stable, error: next.error }
          : {
              tag: "interrupted",
              established: true,
              stable,
              resetRetry: false,
            };
      }
      switch (next.tag) {
        case "interrupt":
          return {
            tag: "interrupted",
            established: true,
            stable,
            resetRetry: next.resetRetry,
          };
        case "replace":
          return {
            tag: "interrupted",
            established: true,
            stable,
            resetRetry: true,
          };
        case "probeFailed":
          this.wakeProbeFailed = true;
          return {
            tag: "failure",
            established: true,
            stable,
            error: next.error,
          };
      }
      throw new Error("unreachable monitor result");
    } finally {
      estAbort.abort();
      monitorAbort.abort();
      lease?.close();
    }
  }

  private async run(): Promise<void> {
    let failureCount = 0;
    const resetLadder = () => {
      failureCount = 0;
      this.resetRetryPending = false;
    };
    try {
      for (;;) {
        if (this.disposed) return;
        if (this.resetRetryPending) {
          failureCount = 0;
          this.resetRetryPending = false;
        }
        if (!this.desired) {
          resetLadder();
          this.setState("idle", { attempt: 0, retryAt: undefined });
          await this.waitForSignal();
          continue;
        }
        if (!this.online) {
          this.setState("offline", { attempt: failureCount + 1 });
          if (await this.waitForSignal()) resetLadder();
          continue;
        }
        const attempt = failureCount + 1;
        const outcome = await this.runAttempt(attempt);
        // Consumed every iteration so a stale marker can't leak into an
        // unrelated later failure.
        const failedWakeProbe = this.wakeProbeFailed;
        this.wakeProbeFailed = false;
        if (outcome.tag === "interrupted") {
          if (outcome.stable) resetLadder();
          if (outcome.resetRetry) resetLadder();
          continue;
        }
        if (outcome.established && outcome.stable) resetLadder();
        const error = outcome.error;
        if (this.options.isFatal(error)) {
          this.setState("blocked", { attempt, lastError: describe(error) });
          this.options.onFatalError?.(error);
          if (await this.waitForSignal()) resetLadder();
          continue;
        }
        if (failedWakeProbe) {
          // A wake probe found the dead transport while the user is returning
          // to the app — reconnect immediately instead of paying the first
          // backoff rung. Only this first attempt skips; if it fails too,
          // normal backoff resumes.
          resetLadder();
          this.setState("connecting", { attempt: 1 });
          continue;
        }
        failureCount += 1;
        const delayMs = this.retryDelayMs(failureCount - 1);
        this.setState("backoff", {
          attempt,
          retryAt: this.options.now() + delayMs,
          lastError: describe(error),
        });
        if (await this.waitForRetrySignal(delayMs)) resetLadder();
      }
    } catch (error) {
      if (this.disposed || isAbort(error)) return;
      throw error;
    }
  }
}
