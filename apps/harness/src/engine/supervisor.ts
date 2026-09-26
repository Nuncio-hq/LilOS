import type { EngineConnection } from "./client";
import type {
  EngineLauncher,
  EngineProcess,
  LaunchedEngine,
} from "./launcher";
import type { Logger } from "../log";

/**
 * Engine lifecycle supervision (AC-2): start the engine, restart it on crash
 * with bounded backoff, report state. Socket drops reconnect against the same
 * endpoint (the engine's orphan grace keeps sessions); process exits relaunch.
 */

export const ENGINE_HOST_STATES = [
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
  private starting?: Promise<void>;

  constructor(options: EngineSupervisorOptions) {
    this.opts = {
      minBackoffMs: 250,
      maxBackoffMs: 15_000,
      reconnectAttempts: 5,
      stableAfterMs: 30_000,
      maxConsecutiveCrashes: 5,
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

  /** Self-heal on demand (e.g. a new user message lands while down). */
  ensureRunning(): void {
    const s = this.state.current;
    if (s === "failed" || s === "stopped") void this.start();
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
    proc.exited.then((code) => {
      this.procAlive = false;
      if (this.stopping || this.state.current === "stopped") return;
      const uptime = Date.now() - this.startedAt;
      if (uptime > this.opts.stableAfterMs) this.crashCount = 0;
      else this.crashCount += 1;
      this.opts.log.warn("engine process exited", {
        code,
        uptimeMs: uptime,
        crashCount: this.crashCount,
      });
      this.state.conn?.close();
      if (this.crashCount >= this.opts.maxConsecutiveCrashes) {
        this.set("failed", `engine exited x${this.crashCount} (code ${code})`);
        return;
      }
      this.relaunchAfter(this.backoff(), `engine exited (code ${code})`);
    });
  }

  private onConnected(conn: EngineConnection, reconnect: boolean) {
    this.startedAt = Date.now();
    this.state.conn = conn;
    conn.onClose((reason) => {
      if (this.stopping) return;
      this.opts.log.warn("engine socket dropped", { reason });
      if (this.procAlive && this.launched?.url) {
        void this.reconnect(this.launched.url);
      } else if (!this.starting) {
        // Proc already reported dead (or external engine); relaunch path.
        this.relaunchAfter(this.backoff(), "connection lost");
      }
    });
    this.set("running", this.opts.launcher.name);
    this.opts.onConnection(conn, reconnect);
  }

  /** Socket dropped but the process is alive: bounded reconnect on same url. */
  private async reconnect(url: string): Promise<void> {
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
    // Socket is dead but the process is alive: count it as a crash and relaunch.
    this.crashCount += 1;
    if (this.crashCount >= this.opts.maxConsecutiveCrashes) {
      this.set("failed", "engine unreachable after reconnect budget");
      return;
    }
    this.relaunchAfter(this.backoff(), "reconnect budget exhausted");
  }

  private relaunchAfter(waitMs: number, detail: string) {
    this.set("restarting", detail);
    const t = setTimeout(() => {
      if (this.stopping) return;
      void this.start();
    }, waitMs);
    t.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
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
