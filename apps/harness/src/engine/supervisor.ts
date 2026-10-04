import type { Logger } from "../log";
import { type EngineConnection, engineErrorCode } from "./client";
import {
  type EngineExit,
  type EngineLauncher,
  type EngineProcess,
  isFatalEngineStart,
  type LaunchedEngine,
} from "./launcher";

/**
 * Engine lifecycle supervision (AC-2): start the engine, restart it on crash
 * with bounded backoff, report state. Socket drops reconnect against the same
 * endpoint (the engine's orphan grace keeps sessions); process exits relaunch.
 */

const ENGINE_HOST_STATES = [
  "starting",
  "running",
  "restarting",
  "failed",
  "stopped",
] as const;
export type EngineHostState = (typeof ENGINE_HOST_STATES)[number];

export interface EngineSupervisorOptions {
  launcher: EngineLauncher;
  /** Open a protocol connection to a url the launcher produced. */
  connect: (url: string) => Promise<EngineConnection>;
  /** Every successful connect/reconnect delivers the fresh connection. */
  onConnection: (conn: EngineConnection, reconnect: boolean) => void;
  onState?: (state: EngineHostState, detail?: string) => void;
  log: Logger;
  /** First crash delay; doubles each crash until maxBackoffMs. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Reconnect budget against a still-alive engine before treating as crash. */
  reconnectAttempts?: number;
  /** A process alive this long resets the crash counter. */
  stableAfterMs?: number;
  /** Consecutive fast crashes before the supervisor gives up. */
  maxConsecutiveCrashes?: number;
  /* #482: liveness probe — a cheap `describe` every probeIntervalMs with
     probeTimeoutMs deadline. An adapter whose backend died answers with
     `backend.state` restarting/failed (mapped into host state — the
     adapter itself stays up and self-heals); an adapter that stops
     answering at all is restarted after probeMissesBeforeRestart
     consecutive misses. */
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  probeMissesBeforeRestart?: number;
}

export class EngineSupervisor {
  readonly state: {
    current: EngineHostState;
    detail?: string;
    conn?: EngineConnection;
  } = { current: "stopped" };

  private readonly opts;
  private launched?: LaunchedEngine;
  private procAlive = false;
  private stopping = false;
  private crashCount = 0;
  private startedAt = 0;
  private reconnecting = false;
  private starting?: Promise<void>;
  private probeTimer?: ReturnType<typeof setInterval>;
  private relaunchTimer?: ReturnType<typeof setTimeout>;
  private probeMisses = 0;
  /** Probe-driven not-running state — cleared on the next healthy probe. */
  private probeDown = false;

  constructor(options: EngineSupervisorOptions) {
    this.opts = {
      minBackoffMs: 250,
      maxBackoffMs: 15_000,
      reconnectAttempts: 5,
      stableAfterMs: 30_000,
      maxConsecutiveCrashes: 5,
      probeIntervalMs: 2_000,
      probeTimeoutMs: 1_500,
      probeMissesBeforeRestart: 2,
      ...options,
    };
  }

  private set(state: EngineHostState, detail?: string) {
    this.state.current = state;
    this.state.detail = detail;
    this.opts.onState?.(state, detail);
    this.opts.log.info("engine state", { state, detail });
  }

  /** Idempotent start; safe to call concurrently. */
  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.stopping = false;
    this.starting = this.run()
      .catch((error) => {
        this.set("failed", String(error));
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  /** The supervised engine process (undefined for external engines). */
  get process(): EngineProcess | undefined {
    return this.launched?.process;
  }

  /** Self-heal on demand (e.g. a new user message lands while down). */
  ensureRunning(): void {
    const s = this.state.current;
    if (s === "failed" || s === "stopped") return void this.start();
    /* A "restarting" flag with nothing armed behind it (no probe, no
       reconnect loop, no in-flight start, no pending relaunch) is a
       stranded engine — a user message is the demand signal to heal now. */
    if (
      s === "restarting" &&
      !this.starting &&
      !this.reconnecting &&
      !this.probeTimer &&
      !this.relaunchTimer
    )
      void this.start();
  }

  /**
   * The machine woke from sleep (SP2/#34): the socket is presumed dead —
   * close it (a deliberate close fires no onClose) and reconnect immediately
   * instead of waiting for a TCP timeout.
   */
  notifyWake(): void {
    if (this.stopping) return;
    const conn = this.state.conn;
    if (!conn) return;
    this.state.conn = undefined;
    conn.close();
    if (this.procAlive && this.launched?.url) {
      void this.reconnect(this.launched.url);
    } else if (!this.starting) {
      this.relaunchAfter(this.backoff(), "woke from sleep");
    }
  }

  private backoff(): number {
    const min = this.opts.minBackoffMs;
    const max = this.opts.maxBackoffMs;
    return Math.min(max, min * 2 ** this.crashCount);
  }

  private async run(): Promise<void> {
    this.set("starting");
    for (;;) {
      try {
        const launched = await this.opts.launcher.start();
        this.attachProcess(launched);
        const conn = await this.opts.connect(launched.url);
        this.onConnected(conn, /*reconnect*/ false);
        return;
      } catch (error) {
        if (this.stopping) return;
        // A fatal verdict (AC-1, #95) won't change on retry — fail now,
        // without counting it toward the restart budget.
        if (isFatalEngineStart(error)) {
          this.set(
            "failed",
            `engine ${this.opts.launcher.name} failed to start: ${String(error)}`,
          );
          return;
        }
        this.crashCount += 1;
        if (this.crashCount >= this.opts.maxConsecutiveCrashes) {
          this.set(
            "failed",
            `engine ${this.opts.launcher.name} failed to start x${this.crashCount}: ${String(
              error,
            )}`,
          );
          return;
        }
        const wait = this.backoff();
        this.opts.log.warn("engine start failed, retrying", {
          error: String(error),
          crashCount: this.crashCount,
          retryInMs: wait,
        });
        this.set("restarting", String(error));
        await sleep(wait, () => this.stopping);
        if (this.stopping) return;
      }
    }
  }

  private attachProcess(launched: LaunchedEngine) {
    this.launched?.process?.kill(); // never leak a stale engine process
    this.launched = launched;
    const proc: EngineProcess | undefined = launched.process;
    this.procAlive = true;
    if (!proc) return;
    proc.exited.then((exit: EngineExit) => {
      this.procAlive = false;
      if (this.stopping || this.state.current === "stopped") return;
      const uptime = Date.now() - this.startedAt;
      if (uptime > this.opts.stableAfterMs) this.crashCount = 0;
      else this.crashCount += 1;
      // #95: name the signal when one ended the child — "code null" tells
      // the user nothing; "killed by SIGKILL" points at a device policy.
      const why = exit.signal
        ? `killed by ${exit.signal}`
        : `code ${exit.code}`;
      this.opts.log.warn("engine process exited", {
        code: exit.code,
        signal: exit.signal,
        uptimeMs: uptime,
        crashCount: this.crashCount,
      });
      this.state.conn?.close();
      /* The conn is dead with the process — retire it so the probe
         stops ticking on a socket that can never answer (its misses
         would otherwise rewrite the verdict below or re-kill). */
      this.state.conn = undefined;
      this.stopProbe();
      if (this.crashCount >= this.opts.maxConsecutiveCrashes) {
        this.set("failed", `engine exited x${this.crashCount} (${why})`);
        return;
      }
      this.relaunchAfter(this.backoff(), `engine exited (${why})`);
    });
  }

  /* #482 BACKEND_DOWN (-32006): the adapter's backend is down and
     relaunching — the adapter itself is healthy, keep the conn. */
  private static readonly BACKEND_DOWN = -32006;

  private armProbe(conn: EngineConnection) {
    this.stopProbe();
    const every = this.opts.probeIntervalMs;
    if (!(every > 0)) return;
    this.probeTimer = setInterval(() => void this.probe(conn), every);
    this.probeTimer.unref?.();
  }

  private stopProbe() {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = undefined;
    this.probeMisses = 0;
    this.probeDown = false;
  }

  /**
   * #482: before this, a wedged adapter looked exactly like a healthy one —
   * the socket stayed open, state stayed `running`, and every forwarded
   * call hung until its own (longer) deadline. The probe draws the line:
   * backend-down signals map straight into host state while the adapter
   * self-heals; repeated dead air means the adapter itself is gone and the
   * process gets restarted.
   */
  private async probe(conn: EngineConnection) {
    if (this.stopping || conn !== this.state.conn) {
      this.stopProbe();
      return;
    }
    try {
      const r = await conn.request<{
        backend?: { state?: string; detail?: string };
      }>("describe", {}, this.opts.probeTimeoutMs);
      if (conn !== this.state.conn) return;
      this.probeMisses = 0;
      const b = r?.backend;
      if (b?.state === "restarting" || b?.state === "failed") {
        this.probeDown = true;
        if (this.state.current !== b.state || this.state.detail !== b.detail)
          this.set(b.state, b.detail);
        return;
      }
      if (this.probeDown) {
        this.probeDown = false;
        this.set("running", this.opts.launcher.name);
      }
    } catch (error) {
      if (conn !== this.state.conn) return;
      const code = engineErrorCode(error);
      /* Any answered frame — even an error — proves the adapter itself is
         responsive, so it resets the dead-air count and can never be
         overwritten back into a terminal "failed" verdict. */
      if (code !== undefined) this.probeMisses = 0;
      if (code === EngineSupervisor.BACKEND_DOWN) {
        this.probeDown = true;
        const detail = error instanceof Error ? error.message : String(error);
        if (
          this.state.current !== "failed" &&
          (this.state.current !== "restarting" || this.state.detail !== detail)
        )
          this.set("restarting", detail);
        return;
      }
      /* An answered error frame means the adapter is responsive — only dead
         air (transport timeout / plain Error) counts as a miss. */
      if (code !== undefined) return;
      this.probeMisses += 1;
      this.probeDown = true;
      if (this.probeMisses < this.opts.probeMissesBeforeRestart) {
        this.opts.log.warn("engine probe timeout", {
          miss: this.probeMisses,
        });
        if (
          this.state.current !== "restarting" &&
          this.state.current !== "failed"
        )
          this.set("restarting", "engine probe timeout");
        return;
      }
      this.opts.log.warn("engine probe timeout — restarting adapter", {
        misses: this.probeMisses,
      });
      this.stopProbe();
      conn.close();
      /* A launched adapter gets killed — its own exit handler accounts
         uptime and relaunches with backoff (crashCount resets past
         stableAfterMs, so a long-lived engine restarts cleanly). An
         external engine has no process to kill: the socket is already
         dropped, so reconnect it. */
      if (this.launched?.process) {
        this.launched.process.kill();
      } else if (this.launched?.url) {
        void this.reconnect(this.launched.url);
      }
    }
  }

  private onConnected(conn: EngineConnection, reconnect: boolean) {
    // A connect that resolved while the process was exiting (or while a
    // stop/failure verdict landed) must not be published — drop it.
    if (
      this.stopping ||
      (!this.procAlive && this.launched?.process !== undefined) ||
      this.state.current === "failed"
    ) {
      conn.close();
      return;
    }
    this.startedAt = Date.now();
    this.state.conn = conn;
    conn.onClose?.((reason) => {
      if (this.stopping) return;
      this.opts.log.warn("engine socket dropped", { reason });
      /* Retire the dead socket + its probe before the recovery arms — a
         probe that keeps ticking on a conn that can't answer accumulates
         dead-air misses and kills a healthy adapter mid-reconnect. A
         stale conn's drop touches nothing (a newer conn already owns
         state.conn and its probe). */
      if (this.state.conn === conn) {
        this.state.conn = undefined;
        this.stopProbe();
      }
      if (this.procAlive && this.launched?.url) {
        void this.reconnect(this.launched.url);
      } else if (!this.starting) {
        // Proc already reported dead (or external engine); relaunch path.
        this.relaunchAfter(this.backoff(), "connection lost");
      }
    });
    this.set("running", this.opts.launcher.name);
    this.armProbe(conn);
    this.opts.onConnection(conn, reconnect);
  }

  /** Socket dropped but the process is alive: bounded reconnect on same url. */
  private async reconnect(url: string): Promise<void> {
    if (this.reconnecting) return; // one reconnect loop per outage
    this.reconnecting = true;
    try {
      const attempts = this.opts.reconnectAttempts;
      for (let i = 1; i <= attempts; i++) {
        if (this.stopping || !this.procAlive) return;
        try {
          const conn = await this.opts.connect(url);
          this.opts.log.info("engine reconnected", { attempt: i });
          this.onConnected(conn, /*reconnect*/ true);
          return;
        } catch (error) {
          this.opts.log.warn("engine reconnect failed", {
            attempt: i,
            of: attempts,
            error: String(error),
          });
          if (i < attempts) {
            await sleep(this.opts.minBackoffMs, () => this.stopping);
          }
        }
      }
      if (this.stopping || !this.procAlive) return;
      // Socket dead but process alive: count it as a crash and relaunch.
      this.crashCount += 1;
      if (this.crashCount >= this.opts.maxConsecutiveCrashes) {
        this.set("failed", "engine unreachable after reconnect budget");
        return;
      }
      this.relaunchAfter(this.backoff(), "reconnect budget exhausted");
    } finally {
      this.reconnecting = false;
    }
  }

  private relaunchAfter(waitMs: number, detail: string) {
    this.set("restarting", detail);
    if (this.relaunchTimer) clearTimeout(this.relaunchTimer);
    this.relaunchTimer = setTimeout(() => {
      this.relaunchTimer = undefined;
      if (this.stopping) return;
      void this.start();
    }, waitMs);
    this.relaunchTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopProbe();
    if (this.relaunchTimer) {
      clearTimeout(this.relaunchTimer);
      this.relaunchTimer = undefined;
    }
    try {
      this.state.conn?.close();
      this.launched?.process?.kill();
      this.set("stopped");
    } finally {
      this.state.conn = undefined;
    }
  }
}

const sleep = (ms: number, aborted: () => boolean) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
    void aborted;
  });
