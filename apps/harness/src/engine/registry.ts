import type { RuntimeStatusRow } from "@lilos/contracts/app";
import { probeAcpSpec } from "@lilos/engine-acp/shims/registry";
import type { Logger } from "../log";
import type { EngineConnection } from "./client";
import { DEFAULT_RUNTIME, type RuntimeSpec } from "./runtimes";
import type { EngineGapCause, EngineHostState } from "./supervisor";
import { EngineSupervisor } from "./supervisor";

/**
 * D-#761 — one supervised engine instance per runtime, ported from T3's
 * ProviderInstanceRegistry as plain TS (instances keyed by id).
 *
 * Per-instance invariants this preserves (the #482/#834 supervisor does
 * the work — the registry only holds one of them per row):
 *   - each runtime has its own supervisor, probe, restart budget, and
 *     event subscription — a restart of `acp:devin` never touches a turn
 *     running on `hermes`;
 *   - the default runtime starts at boot (today's boot path, unchanged);
 *     every other row starts lazily on first demand and may sit `idle`
 *     forever on an install that never hires a coding agent;
 *   - one in-flight launch per runtime — `ensureRunning` is already
 *     idempotent inside the supervisor, and `ensure`'s waiters share the
 *     first delivered connection, so a double-bind cannot spawn two
 *     engines.
 *
 * Not: a job/thread table (children stay conversations), a vendor switch
 * (catalog rows come from `runtimes.ts`), or a resync owner (the harness
 * walks bindings per runtime after reattach).
 */
export interface RuntimeHooks {
  /** A live connection appeared (first start or post-crash reconnect). */
  onConnection(
    runtime: string,
    conn: EngineConnection,
    reconnect: boolean,
    gapCause: EngineGapCause,
  ): void;
  /** Supervisor lifecycle flip — rides to relay as harness.report. */
  onStateChange(runtime: string, state: EngineHostState, detail?: string): void;
  /** Availability probes finished — refresh the status report. */
  onStatusChange?(): void;
}

export interface RuntimeInstance {
  spec: RuntimeSpec;
  /** Live connection; absent before first start / between crashes. */
  conn?: EngineConnection;
  supervisor?: EngineSupervisor;
  /** Last reported lifecycle state ("stopped" before ever started). */
  state: EngineHostState | "idle";
  detail?: string;
  /** Install probe: false = recipe's binary missing — not hirable. */
  available?: boolean;
  /** When the supervisor last reached `failed` — the demand-side
      cooldown clock (see `ensure`). */
  failedAt?: number;
  /** Callers parked in `ensure` until the next connection lands. */
  waiters: {
    resolve: (conn: EngineConnection) => void;
    reject: (err: Error) => void;
  }[];
}

/** Drop keys whose value is `undefined` — `{...defaults, ...opts}` treats
    an explicit undefined as a real value and erases the default. */
const pickDefined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;

export class EngineRegistry {
  private instances = new Map<string, RuntimeInstance>();
  private stopped = false;

  constructor(
    specs: RuntimeSpec[],
    private opts: {
      connect: (url: string) => Promise<EngineConnection>;
      log: Logger;
      /** Tunables forwarded to each supervisor (tests shrink them). */
      probeIntervalMs?: number;
      probeTimeoutMs?: number;
      probeMissesBeforeRestart?: number;
      minBackoffMs?: number;
      maxBackoffMs?: number;
      reconnectAttempts?: number;
      stableAfterMs?: number;
      maxConsecutiveCrashes?: number;
      /** How long a `failed` row answers `ensure` with the recorded
          reason before a new demand earns one fresh bounded start
          cycle (D-#761 review — the packaged-missing-adapter loop). */
      failedRetryCooldownMs?: number;
      hooks: RuntimeHooks;
    },
  ) {
    for (const spec of specs) {
      this.instances.set(spec.id, {
        spec,
        state: "idle",
        waiters: [],
      });
    }
  }

  has(id: string): boolean {
    return this.instances.has(id);
  }

  get(id: string): RuntimeInstance | undefined {
    return this.instances.get(id);
  }

  list(): RuntimeInstance[] {
    return [...this.instances.values()];
  }

  /** The live connection for a runtime — the supervisor owns the socket's
      liveness (it clears state.conn the moment it drops), so its conn is
      the only one worth handing out. */
  connFor(id: string): EngineConnection | undefined {
    return this.instances.get(id)?.supervisor?.state.conn;
  }

  /** The row's supervisor, created on demand (boot + status readers). */
  supervisorFor(id: string): EngineSupervisor {
    const inst = this.instances.get(id);
    if (!inst) throw new Error(`unknown runtime "${id}"`);
    return this.buildSupervisor(inst);
  }

  /**
   * Lazy start (D-#761): the default row's supervisor may already be
   * running from boot; any other row builds one here on first demand.
   * The supervisor owns the process/conn lifecycle — `ensure` only parks
   * the caller until `onConnection` delivers (or the row goes failed).
   *
   * A row that cannot ever launch (adapter not in this build) or whose
   * supervisor already exhausted its crash budget does NOT re-drive a
   * start cycle per demand — each `ensure` used to spawn a fresh
   * `starting→restarting→failed` round (the packaged-app hot loop,
   * ~22% harness CPU). Missing adapters fail plainly forever; a failed
   * row answers with the recorded reason until `failedRetryCooldownMs`
   * passes — then one new demand earns one fresh bounded budget.
   */
  ensure(id: string): Promise<EngineConnection> {
    const inst = this.instances.get(id);
    if (!inst) return Promise.reject(new Error(`unknown runtime "${id}"`));
    const live = inst.supervisor?.state.conn;
    if (live) return Promise.resolve(live);
    if (this.stopped) return Promise.reject(new Error("registry stopped"));
    const detail = inst.detail ?? `engine ${inst.spec.label} is not available`;
    if (inst.spec.adapterPresent && !inst.spec.adapterPresent()) {
      /* The recipe exists but the binary does not (a build that never
         shipped the adapter). No supervisor cycle could help — the
         verdict is recorded so the row reads `failed` in status and
         the caller fails plainly. */
      if (inst.state !== "failed") {
        inst.state = "failed";
        inst.detail = `${inst.spec.label} adapter is not part of this build`;
        inst.failedAt = Date.now();
        this.opts.hooks.onStateChange(inst.spec.id, "failed", inst.detail);
      }
      return Promise.reject(new Error(inst.detail ?? detail));
    }
    /* The cooldown gate exists for lazily-started coding runtimes. The
       default engine keeps main's semantics: demand on a `failed` row
       falls through to `ensureRunning`, which re-drives ONE bounded
       attempt on the same supervisor (its crashCount persists past the
       budget, so the attempt re-fails instantly — bounded, but a
       transient cause that cleared still gets its retry). */
    if (inst.state === "failed" && inst.spec.id !== DEFAULT_RUNTIME) {
      const cooldown = this.opts.failedRetryCooldownMs ?? 30_000;
      if (
        inst.failedAt === undefined ||
        Date.now() - inst.failedAt < cooldown
      ) {
        return Promise.reject(new Error(detail));
      }
      /* Cooldown over: fresh demand earns a fresh supervisor (a new
         crash budget), not another lap on the exhausted one. */
      inst.supervisor = undefined;
      inst.failedAt = undefined;
      inst.state = "idle";
    }
    const p = new Promise<EngineConnection>((resolve, reject) => {
      inst.waiters.push({ resolve, reject });
    });
    this.buildSupervisor(inst).ensureRunning();
    return p;
  }

  /**
   * Stop supervising a failed non-default row once nothing needs it
   * (D-#761 review — the loop kept burning after the only employee on
   * the runtime was removed). The row returns to `idle`; the next real
   * demand rebuilds a supervisor with a full crash budget.
   */
  async release(id: string): Promise<void> {
    if (id === DEFAULT_RUNTIME) return;
    const inst = this.instances.get(id);
    if (!inst) return;
    if (inst.state !== "failed" && inst.state !== "stopped") return;
    /* A row that can never launch (adapter not in this build) has no
       supervisor to free — releasing it would flip failed→idle on every
       demand cycle and re-report the failure each time. It stays
       `failed`: `ensure` answers cheaply from the recorded verdict. */
    if (inst.spec.adapterPresent && !inst.spec.adapterPresent()) return;
    await inst.supervisor?.stop();
    inst.supervisor = undefined;
    inst.conn = undefined;
    inst.state = "idle";
    this.opts.hooks.onStatusChange?.();
  }

  /** Boot only the default runtime — today's engines-up order, unchanged.
      Drives the supervisor directly (not `ensure`'s waiter path): a boot
      that lands `failed` resolves here the way `supervisor.start()` did
      on main — callers never see an unhandled rejection. */
  async start(): Promise<void> {
    const inst = this.instances.get(DEFAULT_RUNTIME);
    if (!inst) throw new Error(`unknown runtime "${DEFAULT_RUNTIME}"`);
    await this.buildSupervisor(inst).start();
  }

  /** Stop every started engine; idle rows have nothing to stop. */
  async stop() {
    this.stopped = true;
    await Promise.all(
      this.list().map(async (inst) => {
        for (const w of inst.waiters.splice(0)) {
          w.reject(new Error("registry stopped"));
        }
        await inst.supervisor?.stop();
      }),
    );
  }

  /** Sleep-wake signal fans out to every started supervisor (#834). */
  notifyWake() {
    for (const inst of this.instances.values()) {
      inst.supervisor?.notifyWake();
    }
  }

  restartForPluginRefresh(id: string = DEFAULT_RUNTIME) {
    this.instances.get(id)?.supervisor?.restartForPluginRefresh();
  }

  /** Install probe — `available` on the row; run once at boot. A
      recipe in the catalog is not availability (D-#761 review — the
      packaged app reported acp:devin hirable with no adapter in the
      build): the adapter binary must exist before the agent probe is
      even worth running. */
  async probeAvailable(env?: NodeJS.ProcessEnv) {
    await Promise.all(
      this.list().map(async (inst) => {
        if (inst.spec.adapterPresent && !inst.spec.adapterPresent()) {
          inst.available = false;
          inst.detail = `${inst.spec.label} adapter is not part of this build`;
          this.opts.log.info("runtime probe", {
            runtime: inst.spec.id,
            available: false,
            detail: inst.detail,
          });
          return;
        }
        if (!inst.spec.acpSpec) {
          inst.available = true;
          return;
        }
        const r = await probeAcpSpec(inst.spec.acpSpec, env);
        inst.available = r.ok;
        if (!r.ok) inst.detail = r.output || "not installed";
        this.opts.log.info("runtime probe", {
          runtime: inst.spec.id,
          available: r.ok,
        });
      }),
    );
    this.opts.hooks.onStatusChange?.();
  }

  /** Status rows for `harness.report.status.runtimes` (D-#761). */
  statusRows(): RuntimeStatusRow[] {
    return this.list().map((inst) => ({
      id: inst.spec.id,
      label: inst.spec.label,
      ...(inst.available === undefined ? {} : { available: inst.available }),
      ...(inst.state === "idle" ? {} : { state: inst.state }),
      ...(inst.detail ? { detail: inst.detail } : {}),
    }));
  }

  private buildSupervisor(inst: RuntimeInstance): EngineSupervisor {
    if (inst.supervisor) return inst.supervisor;
    const { opts } = this;
    const sup = new EngineSupervisor({
      launcher: inst.spec.launcher(),
      connect: opts.connect,
      log: opts.log,
      /* Optional tunables reach the supervisor ONLY when set — an
         explicit `undefined` key spreads over the supervisor's own
         defaults and erases them (NaN backoff + no crash budget → an
         instant, endless retry loop that never reports `failed` — the
         #859 e2e regressions). index.ts passes none of these. */
      ...pickDefined({
        minBackoffMs: opts.minBackoffMs,
        maxBackoffMs: opts.maxBackoffMs,
        reconnectAttempts: opts.reconnectAttempts,
        stableAfterMs: opts.stableAfterMs,
        maxConsecutiveCrashes: opts.maxConsecutiveCrashes,
        probeIntervalMs: opts.probeIntervalMs,
        probeTimeoutMs: opts.probeTimeoutMs,
        probeMissesBeforeRestart: opts.probeMissesBeforeRestart,
      }),
      onConnection: (conn, reconnect, gapCause) => {
        inst.conn = conn;
        /* A live conn clears the recorded failure — a released row that
           later comes up must not keep answering "failed" to parked
           sends (the verdict belongs to the cycle that produced it). */
        inst.failedAt = undefined;
        inst.detail = undefined;
        for (const w of inst.waiters.splice(0)) w.resolve(conn);
        opts.hooks.onConnection(inst.spec.id, conn, reconnect, gapCause);
      },
      onState: (st, detail) => {
        inst.state = st;
        inst.detail = detail;
        /* The demand-cooldown clock starts at the LAST failure — a row
           that keeps failing answers `ensure` cheaply instead of
           re-driving a doomed launch per caller. */
        if (st === "failed") inst.failedAt = Date.now();
        if (st === "failed" || st === "stopped") {
          inst.conn = undefined;
          for (const w of inst.waiters.splice(0)) {
            w.reject(new Error(detail ?? `engine ${st}`));
          }
        }
        opts.hooks.onStateChange(inst.spec.id, st, detail);
      },
    });
    inst.supervisor = sup;
    return sup;
  }
}
