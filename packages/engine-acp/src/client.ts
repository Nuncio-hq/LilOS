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
   * Bound on session-scoped requests (`session/new`, `session/load`,
   * config writes, `session/close`) (D-#866): an agent whose spawned
   * child never finishes init leaves the ACP request pending forever —
   * the reviewer's installed-app failure was exactly this, one wedged
   * `claude` child per harness retry. The bound turns a wedge into an
   * error for THAT call — never an adapter teardown: the process group
   * hosts every live session, so one wedged start must not SIGKILL
   * healthy turns. The wedged session is abandoned, not restarted
   * (r6 review).
   */
  createTimeoutMs?: number;
  /**
   * The adapter died — process exit or `close()`. The engine marks
   * every session suspended: the next use re-creates it on the fresh
   * adapter via the normal resume path instead of refusing prompts on
   * a stale ACP session id (D-#866 r6).
   */
  onDead?: () => void;
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
  /** Set when the child exited or close() ran. */
  private gone = false;
  /** Fires once when the adapter goes away — see `onDead`. */
  private deadNotified = false;
  /** The adapter's own process-group id — survives `proc` exit so a
      close() can still reach children that outlived their parent. */
  private pgid?: number;
  /** Serialized prompt pump — ACP runs one `session/prompt` per session at
     a time; queued sends become the next turn (#308's queued-steer leg). */
  private promptQueues = new Map<string, Promise<unknown>>();
  /** Sessions with a prompt in flight or queued — interrupt must still
     cancel a send that has not reached the wire yet. */
  private promptBusy = new Map<string, number>();
  /** A session-creating RPC that outlived its bound and is still in
     flight. While it is, another `session/new` would stack a second
     agent child behind the same wedge — subsequent creates fail fast
     with the same error instead (r7 nit: up to 6 leaked `claude`
     children per stuck send). Clears when the RPC settles; teardown
     drops it with the process. */
  private wedgedCreate?: { req: Promise<unknown>; message: string };
  /** Creates still in flight — includes a wedged one until it settles.
     The engine counts these plus live sessions before reaping a wedged
     adapter, so teardown never kills a create that might still answer. */
  private readonly pendingCreates = new Set<Promise<unknown>>();

  private constructor(
    readonly initializeResult: acp.InitializeResponse,
    private readonly handlers: AcpConnectionOptions["handlers"],
    private readonly createTimeoutMs: number,
    private readonly onDead?: () => void,
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

  /** The adapter is gone — flip `dead` and notify once. */
  private markDead() {
    this.gone = true;
    if (this.deadNotified) return;
    this.deadNotified = true;
    try {
      this.onDead?.();
    } catch {
      /* a listener throw must not swallow the death itself */
    }
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
      opts.onDead,
    );
    c.proc = proc;
    c.conn = conn;
    /* `detached` made the adapter its own group leader — remember the
       group past the proc handle so close() reaches orphaned children. */
    if (process.platform !== "win32") c.pgid = proc.pid;
    proc.on("exit", () => {
      c.markDead();
      c.conn = undefined;
      c.proc = undefined;
    });
    return c;
  }

  /** What `initialize` negotiated — the capability truth source (D-#764). */
  get agentCapabilities(): acp.AgentCapabilities | undefined {
    return this.initializeResult.agentCapabilities;
  }

  /** Effective bound for a session-scoped call — the caller may only
      shrink it (the engine's start budget counts down through a chain
      of RPCs so it lands inside the harness's 60s wait, D-#866 r6). */
  private bound(timeoutMs?: number): number {
    return Math.min(timeoutMs ?? this.createTimeoutMs, this.createTimeoutMs);
  }

  /** Shared bound for the session-creating RPCs. The callers check
      `wedgedCreate` BEFORE building `req` — once the RPC is on the wire
      the child already exists, so the guard lives ahead of it. A
      timeout (when `arm`) raises the guard: while the abandoned RPC is
      still in flight, every later create rejects fast with the same
      message rather than stacking another agent child behind the wedge
      (r7 nit). A late answer's orphaned ACP session is closed on settle. */
  private create<T>(
    req: Promise<T>,
    ms: number,
    reason: () => string,
    arm: boolean,
  ): Promise<T> {
    req.catch(() => {});
    this.pendingCreates.add(req);
    const settle = (res?: T) => {
      this.pendingCreates.delete(req);
      if (this.wedgedCreate?.req !== req) return;
      this.wedgedCreate = undefined;
      /* The wedge answered after we abandoned it — the ACP session it
         created has no owner; close it so the late child doesn't leak
         (the adapter stays — it may still hold live work). */
      const id = (res as { sessionId?: string } | undefined)?.sessionId;
      if (id && this.conn)
        void Promise.resolve(this.conn.closeSession({ sessionId: id })).catch(
          () => {},
        );
    };
    void req.then(settle, () => settle());
    return withTimeout(req, ms, reason, () => {
      /* Abandoned: no caller waits on it anymore, so it stops counting
         as a live create (a late answer still takes the settle path). */
      this.pendingCreates.delete(req);
      if (arm) this.wedgedCreate = { req, message: reason() };
    });
  }

  /** A create whose caller still waits is in flight — teardown would
      kill a session the engine has not registered yet, so its "no live
      sessions" check would lie. */
  hasLiveCreates(): boolean {
    return this.pendingCreates.size > 0;
  }

  /** `session/new` — the agent attaches the given MCP servers.
      A wedge here rejects THIS call only — the adapter multiplexes all
      sessions over one process group, so a per-session timeout must
      never tear it down (r6 review): one wedged start would otherwise
      SIGKILL every healthy turn sharing the process. */
  async newSession(
    p: {
      cwd: string;
      mcpServers?: acp.McpServer[];
      meta?: Record<string, unknown>;
    },
    opts?: { timeoutMs?: number; armWedge?: boolean },
  ): Promise<acp.NewSessionResponse> {
    if (!this.conn) throw new Error("connection closed");
    /* r7 nit: a wedged create is still in flight — another session/new
       would stack a second child behind it. Fail fast before the wire
       call, with the same error, until the wedged RPC settles. */
    if (this.wedgedCreate) throw new Error(this.wedgedCreate.message);
    const req = this.conn.newSession({
      cwd: p.cwd,
      mcpServers: p.mcpServers ?? [],
      ...(p.meta ? { _meta: p.meta } : {}),
    });
    const ms = this.bound(opts?.timeoutMs);
    return this.create(
      req,
      ms,
      () => `agent did not answer session/new in ${ms}ms`,
      opts?.armWedge !== false,
    );
  }

  /** `session/load` — resume a stored session (loadSession capability).
      Same non-fatal bound as `newSession` (r6). */
  async loadSession(
    p: {
      sessionId: string;
      cwd: string;
      mcpServers?: acp.McpServer[];
      meta?: Record<string, unknown>;
    },
    opts?: { timeoutMs?: number; armWedge?: boolean },
  ): Promise<acp.LoadSessionResponse> {
    if (!this.conn) throw new Error("connection closed");
    if (this.wedgedCreate) throw new Error(this.wedgedCreate.message);
    const req = this.conn.loadSession({
      sessionId: p.sessionId,
      cwd: p.cwd,
      mcpServers: p.mcpServers ?? [],
      ...(p.meta ? { _meta: p.meta } : {}),
    });
    const ms = this.bound(opts?.timeoutMs);
    return this.create(
      req,
      ms,
      () => `agent did not answer session/load in ${ms}ms`,
      opts?.armWedge !== false,
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
  async setMode(
    sessionId: string,
    modeId: string,
    opts?: { timeoutMs?: number },
  ): Promise<void> {
    if (!this.conn) return;
    const req = this.conn.setSessionMode({ sessionId, modeId });
    req.catch(() => {});
    const ms = this.bound(opts?.timeoutMs);
    await withTimeout(
      req,
      ms,
      () => `agent did not answer session/set_mode in ${ms}ms`,
    );
  }

  /** `session/set_config_option` — models/efforts/modes/config picks. */
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
    opts?: { timeoutMs?: number },
  ): Promise<acp.SetSessionConfigOptionResponse> {
    if (!this.conn) throw new Error("connection closed");
    const req = this.conn.setSessionConfigOption({
      sessionId,
      configId,
      value,
    });
    req.catch(() => {});
    const ms = this.bound(opts?.timeoutMs);
    return withTimeout(
      req,
      ms,
      () => `agent did not answer session/set_config_option in ${ms}ms`,
    );
  }

  /** `session/close` when advertised — best-effort, and never fatal:
      a wedged close leaves the adapter serving its live sessions (r6). */
  async closeSession(sessionId: string): Promise<void> {
    if (!this.conn) return;
    const req = this.conn.closeSession({ sessionId });
    req.catch(() => {});
    try {
      await withTimeout(
        req,
        this.createTimeoutMs,
        () => `agent did not answer session/close in ${this.createTimeoutMs}ms`,
      );
    } catch {
      /* the agent may not advertise session.close, or wedged — either
         way the caller only wanted it gone */
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
    this.markDead();
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
    }
    /* The group outlives the adapter: an adapter can answer TERM with a
       clean exit-0 while its session child ignores the signal (the r6
       repro left exactly that orphan reparented to launchd). SIGKILL the
       group whenever we had one — the proc's own exit code is irrelevant
       to its descendants. */
    if (process.platform === "win32") {
      if (proc && proc.exitCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    } else if (this.pgid !== undefined) {
      try {
        process.kill(-this.pgid, "SIGKILL");
      } catch {
        /* group already empty */
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
