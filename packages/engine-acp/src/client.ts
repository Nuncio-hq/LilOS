import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { scrubLilosEnv } from "@lilos/contracts/env";
import { ACP_PROTOCOL_VERSION } from "./pin.js";

/**
 * D-#764 — the generic ACP client seam: spawn an agent's stdio server,
 * `initialize`, `session/new`, prompt pump, cancel, close. Every engine
 * riding ACP (the shared fake, `devin acp`, engine-hermes's `hermes acp`)
 * goes through this — agent-specific argv/env stay in the engine package
 * that owns the spawn.
 */

/** What a session needs to know to run prompts against an ACP agent. */
export interface AcpConnectionOptions {
  /** The agent's stdio command (already-resolved argv; e.g. `["devin","acp"]`). */
  command: string[];
  /**
   * Bound on `session/new` / `session/load` (D-#866): an agent whose
   * spawned child never finishes init leaves the ACP request pending
   * forever — the reviewer's installed-app failure was exactly this, one
   * wedged `claude` child per harness retry. The bound turns a wedge into
   * an error plus a full adapter restart instead of a silent pile-up.
   */
  createTimeoutMs?: number;
  /** Extra env for the child — merged over process.env. */
  env?: Record<string, string>;
  /**
   * Env names removed from the inherited env before spawn — the engine
   * package's policy for names a child must not see even when the host
   * env carries them. Inherited names only; explicit `env` grants are
   * merged after and still land (D-#412 ordering).
   */
  dropEnv?: readonly string[];
  /** Spawn cwd (also sent as the session's `cwd` by newSession). */
  cwd: string;
  /** Identity reported in `initialize.clientInfo`. */
  clientInfo?: { name: string; version: string };
  /**
   * `initialize.clientCapabilities` — defaults to no fs/terminal
   * delegation. An agent whose commands run through the client's
   * terminals advertises `terminal: true` and passes `terminals` too
   * (the shim decides; the seam stays neutral, D-#845).
   */
  clientCapabilities?: acp.ClientCapabilities;
  /** `terminal/*` method handlers — required when the capability is on. */
  terminals?: {
    create(r: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse>;
    output(r: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse>;
    waitForExit(
      r: acp.WaitForTerminalExitRequest,
    ): Promise<acp.WaitForTerminalExitResponse>;
    kill(r: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse | void>;
    release(
      r: acp.ReleaseTerminalRequest,
    ): Promise<acp.ReleaseTerminalResponse | void>;
  };
  /** `session/request_permission` + `session/update` handlers. */
  handlers: {
    onPermission(
      params: acp.RequestPermissionRequest,
    ): Promise<acp.RequestPermissionResponse>;
    onUpdate(params: acp.SessionNotification): void;
  };
}

/**
 * One ACP client connection over an agent's stdio. `initialize` runs at
 * open; sessions multiplex on the same connection (`newSession`/`loadSession`
 * per session — an agent process hosts every session it advertises).
 */
/* session/new owns the agent's slow path — its first child init under a
   fresh macOS ancestry ran ~14s on the installed app; a true wedge must
   still resolve, so the bound is a multiple of the observed slow case. */
const CREATE_TIMEOUT_MS = 45_000;
/* `initialize` is the adapter's own handshake — no child init waits. */
const INIT_TIMEOUT_MS = 15_000;

export class AcpConnection {
  private proc?: ChildProcess;
  private conn?: acp.ClientSideConnection;
  /** Set when the child exited or a wedged request forced a teardown. */
  private gone = false;
  /** Serialized prompt pump — ACP runs one `session/prompt` per session at
     a time; queued sends become the next turn (#308's queued-steer leg). */
  private promptQueues = new Map<string, Promise<unknown>>();
  /** Sessions with a prompt in flight or queued — interrupt must still
     cancel a send that has not reached the wire yet. */
  private promptBusy = new Map<string, number>();

  private constructor(
    readonly initializeResult: acp.InitializeResponse,
    private readonly handlers: AcpConnectionOptions["handlers"],
    private readonly createTimeoutMs: number,
  ) {}

  /** The child exited or a wedged request tore it down — reopen instead of
      queuing behind a corpse. */
  get dead(): boolean {
    return this.gone;
  }

  /**
   * Kill the whole adapter tree, not just the adapter: agents spawn their
   * own children (claude under claude-agent-acp) and a bare `proc.kill`
   * orphans them alive — the installed-app retry loop leaked eight. The
   * spawn is `detached`, so the adapter pid IS its process group.
   */
  private killTree(signal: "SIGTERM" | "SIGKILL") {
    const proc = this.proc;
    if (!proc || proc.pid === undefined) return;
    try {
      if (process.platform === "win32") proc.kill(signal);
      else process.kill(-proc.pid, signal);
    } catch {
      try {
        proc.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }

  /** A request the agent never answered — the connection is unrecoverable:
      kill the tree so its session children die with it, then mark dead so
      the engine reopens on the next demand instead of queuing behind a
      wedge. */
  private teardown() {
    if (this.gone) return;
    this.gone = true;
    this.killTree("SIGKILL");
    this.proc = undefined;
    this.conn = undefined;
    this.promptQueues.clear();
    this.promptBusy.clear();
  }

  /** Spawn the agent, wire the stream, run `initialize`. */
  static async open(opts: AcpConnectionOptions): Promise<AcpConnection> {
    /* D-#412: the agent child gets the allow-listed env — PATH, HOME and
       the proxies/provider keys a signed-in CLI needs pass through;
       LILOS_* internal state (relay token, state dirs) never crosses the
       spawn boundary. Explicit grants still merge after the scrub. */
    const inherited = scrubLilosEnv(process.env);
    /* The engine package's own drop list applies to inherited names only —
       an explicit `env` grant merged below still wins. */
    for (const key of opts.dropEnv ?? []) delete inherited[key];
    const env = {
      ...inherited,
      ...opts.env,
    } as Record<string, string>;
    const [bin, ...args] = opts.command;
    const proc = spawn(bin, args, {
      env,
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "inherit"],
      /* Own process group — teardown kills the agent AND its session
         children together (the orphan-leak fix above). */
      detached: process.platform !== "win32",
    });
    if (!proc.stdin || !proc.stdout) {
      proc.kill("SIGTERM");
      throw new Error(`${bin} stdio not piped`);
    }
    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin) as never,
      Readable.toWeb(proc.stdout) as never,
    );
    const conn = new acp.ClientSideConnection(
      () => ({
        requestPermission: (params) => opts.handlers.onPermission(params),
        sessionUpdate: (params) => opts.handlers.onUpdate(params),
        ...(opts.terminals
          ? {
              createTerminal: (p: acp.CreateTerminalRequest) =>
                opts.terminals!.create(p),
              terminalOutput: (p: acp.TerminalOutputRequest) =>
                opts.terminals!.output(p),
              waitForTerminalExit: (p: acp.WaitForTerminalExitRequest) =>
                opts.terminals!.waitForExit(p),
              killTerminal: (p: acp.KillTerminalRequest) =>
                opts.terminals!.kill(p),
              releaseTerminal: (p: acp.ReleaseTerminalRequest) =>
                opts.terminals!.release(p),
            }
          : {}),
      }),
      stream,
    );
    const initReq = conn.initialize({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: opts.clientInfo ?? { name: "lilos", version: "0" },
      /* Default: no fs/terminal delegation — the agent keeps its own
         tools. Agents that route commands through client terminals pass
         both the capability flag and the handlers (D-#845). */
      clientCapabilities: opts.clientCapabilities ?? {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    /* The race loser is abandoned, not awaited — swallow its late settle so
       a wedged agent can't raise an unhandled rejection after teardown. */
    initReq.catch(() => {});
    let init: acp.InitializeResponse;
    try {
      init = await withTimeout(
        initReq,
        opts.createTimeoutMs === undefined
          ? INIT_TIMEOUT_MS
          : Math.min(opts.createTimeoutMs, INIT_TIMEOUT_MS),
        () => `${bin} did not answer initialize`,
      );
    } catch (e) {
      try {
        if (proc.pid !== undefined && process.platform !== "win32")
          process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      throw e;
    }
    const c = new AcpConnection(
      init,
      opts.handlers,
      opts.createTimeoutMs ?? CREATE_TIMEOUT_MS,
    );
    c.proc = proc;
    c.conn = conn;
    proc.on("exit", () => {
      c.gone = true;
      c.conn = undefined;
      c.proc = undefined;
    });
    return c;
  }

  /** What `initialize` negotiated — the capability truth source (D-#764). */
  get agentCapabilities(): acp.AgentCapabilities | undefined {
    return this.initializeResult.agentCapabilities;
  }

  /** `session/new` — the agent attaches the given MCP servers.
      `fatal:false` bounds the wait without tearing the adapter down —
      the catalog probe uses it: a wedge there is one dropped probe, not a
      reason to kill sessions the adapter is serving fine. */
  async newSession(
    p: {
      cwd: string;
      mcpServers?: acp.McpServer[];
      meta?: Record<string, unknown>;
    },
    opts?: { fatal?: boolean },
  ): Promise<acp.NewSessionResponse> {
    if (!this.conn) throw new Error("connection closed");
    const req = this.conn.newSession({
      cwd: p.cwd,
      mcpServers: p.mcpServers ?? [],
      ...(p.meta ? { _meta: p.meta } : {}),
    });
    req.catch(() => {});
    return withTimeout(
      req,
      this.createTimeoutMs,
      () => `agent did not answer session/new in ${this.createTimeoutMs}ms`,
      opts?.fatal === false ? undefined : () => this.teardown(),
    );
  }

  /** `session/load` — resume a stored session (loadSession capability). */
  async loadSession(p: {
    sessionId: string;
    cwd: string;
    mcpServers?: acp.McpServer[];
    meta?: Record<string, unknown>;
  }): Promise<acp.LoadSessionResponse> {
    if (!this.conn) throw new Error("connection closed");
    const req = this.conn.loadSession({
      sessionId: p.sessionId,
      cwd: p.cwd,
      mcpServers: p.mcpServers ?? [],
      ...(p.meta ? { _meta: p.meta } : {}),
    });
    req.catch(() => {});
    return withTimeout(
      req,
      this.createTimeoutMs,
      () => `agent did not answer session/load in ${this.createTimeoutMs}ms`,
      () => this.teardown(),
    );
  }

  /**
   * `session/prompt`, serialized per session — a queued send starts after
   * the in-flight one resolves (the ACP path's steer queue). `onStart`
   * fires when this send actually goes on the wire — the engine mints the
   * deferred leg's `turn.started` there.
   */
  prompt(
    sessionId: string,
    content: acp.ContentBlock[],
    onStart?: () => void,
  ): Promise<acp.PromptResponse> {
    const run = async () => {
      if (!this.conn) throw new Error("connection closed");
      onStart?.();
      return this.conn.prompt({ sessionId, prompt: content });
    };
    const prev = this.promptQueues.get(sessionId) ?? Promise.resolve();
    this.promptBusy.set(sessionId, (this.promptBusy.get(sessionId) ?? 0) + 1);
    const next = prev.then(run, run);
    this.promptQueues.set(
      sessionId,
      next.then(
        () => {},
        () => {},
      ),
    );
    const clear = () => {
      const n = (this.promptBusy.get(sessionId) ?? 1) - 1;
      if (n <= 0) this.promptBusy.delete(sessionId);
      else this.promptBusy.set(sessionId, n);
    };
    void next.then(clear, clear);
    return next;
  }

  /** A prompt is on the wire or queued behind one — session/cancel reaches
     it either way. */
  promptBusyFor(sessionId: string): boolean {
    return (this.promptBusy.get(sessionId) ?? 0) > 0;
  }

  /** `session/cancel` notification — best-effort abort of the live turn. */
  async cancel(sessionId: string): Promise<void> {
    if (!this.conn) return;
    try {
      await this.conn.cancel({ sessionId });
    } catch {
      /* cancel races the turn's own end — either way it is over */
    }
  }

  /** `session/set_mode` — only when the session advertised modes. */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    if (!this.conn) return;
    const req = this.conn.setSessionMode({ sessionId, modeId });
    req.catch(() => {});
    await withTimeout(
      req,
      this.createTimeoutMs,
      () =>
        `agent did not answer session/set_mode in ${this.createTimeoutMs}ms`,
      () => this.teardown(),
    );
  }

  /** `session/set_config_option` — models/efforts/modes/config picks. */
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    if (!this.conn) throw new Error("connection closed");
    const req = this.conn.setSessionConfigOption({
      sessionId,
      configId,
      value,
    });
    req.catch(() => {});
    return withTimeout(
      req,
      this.createTimeoutMs,
      () =>
        `agent did not answer session/set_config_option in ${this.createTimeoutMs}ms`,
      () => this.teardown(),
    );
  }

  /** `session/close` when advertised — best-effort. */
  async closeSession(sessionId: string): Promise<void> {
    if (!this.conn) return;
    const req = this.conn.closeSession({ sessionId });
    req.catch(() => {});
    try {
      await withTimeout(
        req,
        this.createTimeoutMs,
        () => `agent did not answer session/close in ${this.createTimeoutMs}ms`,
        () => this.teardown(),
      );
    } catch {
      /* the agent may not advertise session.close */
    }
  }

  /** Tear down the connection and the child's whole process tree. */
  async close(): Promise<void> {
    try {
      /* ClientSideConnection has no close() — killing the child ends the
         stream and rejects `closed`; the process kill IS the teardown. */
      void this.conn?.closed;
    } catch {
      /* already closed */
    }
    this.gone = true;
    const proc = this.proc;
    if (proc && proc.exitCode === null) {
      this.killTree("SIGTERM");
      /* A short grace, then SIGKILL — close() must never outlive the
         session children it exists to reap. */
      await new Promise<void>((r) => {
        const t = setTimeout(r, 400);
        proc.once("exit", () => {
          clearTimeout(t);
          r();
        });
      });
      if (proc.exitCode === null && proc.pid !== undefined) {
        try {
          if (process.platform === "win32") proc.kill("SIGKILL");
          else process.kill(-proc.pid, "SIGKILL");
        } catch {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
    }
    this.proc = undefined;
    this.conn = undefined;
    this.promptQueues.clear();
    this.promptBusy.clear();
  }
}

/** Bound one agent request; `onTimeout` runs before the rejection lands so
    a wedge is cleaned up, not just reported. */
function withTimeout<T>(
  req: Promise<T>,
  ms: number,
  reason: () => string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout?.();
      reject(new Error(reason()));
    }, ms);
    req.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
