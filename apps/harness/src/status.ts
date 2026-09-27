import { spawnSync } from "node:child_process";
import type { HarnessStatusReport } from "@lilos/contracts/app";
import type { DescribeResult, ModelsListResult } from "@lilos/contracts/engine";
import type { EngineConnection } from "./engine/client";
import type { EngineHostState } from "./engine/supervisor";
import type { Logger } from "./log";

/**
 * Status telemetry reporter (issue #33): folds the supervisor's lifecycle
 * state, a live `describe` probe, the supervised pid's RSS, and the harness
 * log tail into `harness.report` — the only place this data crosses, since
 * the harness is the component supervising the engine process.
 *
 * `SupervisorView` is the narrow surface this needs: the real
 * `EngineSupervisor` satisfies it structurally (`process` is the small
 * hook this slice added for RSS).
 */
export interface SupervisorView {
  state: {
    current: EngineHostState;
    detail?: string;
    conn?: EngineConnection;
  };
  process?: { pid?: number };
}

export interface StatusReporterOptions {
  /** Sends `harness.report` — the relay client's `request` bound. */
  send: (params: {
    engine: { state: EngineHostState; detail?: string };
    status: HarnessStatusReport;
  }) => Promise<unknown>;
  supervisor: SupervisorView;
  /** Harness build version reported to the relay. */
  version: string;
  /** Model the harness launches sessions with. */
  model?: string;
  /** Live session count — the harness's session registry supplies this. */
  liveSessions?: () => number;
  logTail?: () => string[];
  /** Deadline for the engine `describe` probe (default 2s). */
  probeTimeoutMs?: number;
  /** RSS reader — injectable for tests; default shells `ps`. */
  readRssBytes?: (pid: number) => number | undefined;
  now?: () => number;
}

/** Resident set size of `pid` in bytes via `ps` (macOS + Linux). */
export function readRssBytesPs(pid: number): number | undefined {
  try {
    const out = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    });
    const kb = Number.parseInt(out.stdout.trim(), 10);
    return Number.isFinite(kb) && kb >= 0 ? kb * 1024 : undefined;
  } catch {
    return undefined;
  }
}

export class StatusReporter {
  private readonly opts;
  private lastProbe?: { at: number; result: DescribeResult };
  /** The engine's `models.list` answer — only probed when `models` is declared. */
  private lastModels?: ModelsListResult;

  constructor(options: StatusReporterOptions) {
    this.opts = {
      probeTimeoutMs: 2_000,
      readRssBytes: readRssBytesPs,
      now: () => Date.now(),
      ...options,
    };
  }

  /** Build + send one `harness.report` with current telemetry. */
  async reportOnce(): Promise<void> {
    const { supervisor } = this.opts;
    const conn =
      supervisor.state.current === "running"
        ? supervisor.state.conn
        : undefined;
    if (conn) {
      try {
        const result = (await withTimeout(
          conn.request<DescribeResult>("describe", {}),
          this.opts.probeTimeoutMs,
        )) as DescribeResult;
        this.lastProbe = { at: this.opts.now(), result };
        // The picker reads models off this report (issue #30): probe
        // models.list only when the engine declares the capability.
        if (result.capabilities.some((c) => c.id === "models")) {
          try {
            this.lastModels = await withTimeout(
              conn.request<ModelsListResult>("models.list", {}),
              this.opts.probeTimeoutMs,
            );
          } catch {
            this.lastModels = undefined;
          }
        } else {
          this.lastModels = undefined;
        }
      } catch {
        // A wedged probe still lets the heartbeat below carry state.
      }
    }

    const pid = supervisor.process?.pid;
    const engineRssBytes =
      supervisor.state.current === "running" && pid !== undefined
        ? this.opts.readRssBytes(pid)
        : undefined;
    const status: HarnessStatusReport = {
      harnessVersion: this.opts.version,
      model: this.opts.model,
      engineName: this.lastProbe?.result.name,
      engineVersion: this.lastProbe?.result.version,
      engineProtocol: this.lastProbe?.result.protocol.version,
      capabilities: this.lastProbe?.result.capabilities,
      models: this.lastModels?.models,
      providers: this.lastModels?.providers,
      defaultModel: this.lastModels?.default,
      defaultProvider: this.lastModels?.defaultProvider,
      engineRssBytes,
      sessions: this.opts.liveSessions?.(),
      probedAt: this.lastProbe?.at,
      logTail: this.opts.logTail?.().slice(-100),
    };
    await this.opts.send({
      engine: {
        state: supervisor.state.current,
        detail: supervisor.state.detail,
      },
      status,
    });
  }

  /**
   * Report immediately, then every `intervalMs` (default 10s — inside the
   * relay's heartbeat freshness window). Returns a stopper.
   */
  start(intervalMs = 10_000): () => void {
    void this.reportOnce().catch(() => {});
    const timer = setInterval(() => {
      void this.reportOnce().catch(() => {});
    }, intervalMs);
    return () => clearInterval(timer);
  }
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("probe timed out")), ms),
    ),
  ]);

/**
 * Mirror a Logger into a fixed-size in-memory tail so `logTail` answers
 * without reopening log files (issue #33).
 */
export function teeLogger(
  inner: Logger,
  capacity = 200,
): Logger & { lines: string[] } {
  const lines: string[] = [];
  const write =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string, fields?: Record<string, unknown>) => {
      lines.push(
        `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}` +
          (fields && Object.keys(fields).length
            ? ` ${JSON.stringify(fields)}`
            : ""),
      );
      if (lines.length > capacity) lines.splice(0, lines.length - capacity);
      inner[level](message, fields);
    };
  return {
    lines,
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    close: () => inner.close(),
  };
}
