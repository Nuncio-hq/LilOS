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
  /** Extra env for the child — merged over process.env. */
  env?: Record<string, string>;
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
export class AcpConnection {
  private proc?: ChildProcess;
  private conn?: acp.ClientSideConnection;
  /** Serialized prompt pump — ACP runs one `session/prompt` per session at
     a time; queued sends become the next turn (#308's queued-steer leg). */
  private promptQueues = new Map<string, Promise<unknown>>();
  /** Sessions with a prompt in flight or queued — interrupt must still
     cancel a send that has not reached the wire yet. */
  private promptBusy = new Map<string, number>();

  private constructor(
    readonly initializeResult: acp.InitializeResponse,
    private readonly handlers: AcpConnectionOptions["handlers"],
  ) {}

  /** Spawn the agent, wire the stream, run `initialize`. */
  static async open(opts: AcpConnectionOptions): Promise<AcpConnection> {
    /* D-#412: the agent child gets the allow-listed env — PATH, HOME and
       the proxies/provider keys a signed-in CLI needs pass through;
       LILOS_* internal state (relay token, state dirs) never crosses the
       spawn boundary. Explicit grants still merge after the scrub. */
    const env = {
      ...scrubLilosEnv(process.env),
      ...opts.env,
    } as Record<string, string>;
    const [bin, ...args] = opts.command;
    const proc = spawn(bin, args, {
      env,
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "inherit"],
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
    const init = await conn.initialize({
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
    const c = new AcpConnection(init, opts.handlers);
    c.proc = proc;
    c.conn = conn;
    return c;
  }

  /** What `initialize` negotiated — the capability truth source (D-#764). */
  get agentCapabilities(): acp.AgentCapabilities | undefined {
    return this.initializeResult.agentCapabilities;
  }

  /** `session/new` — the agent attaches the given MCP servers. */
  async newSession(p: {
    cwd: string;
    mcpServers?: acp.McpServer[];
    meta?: Record<string, unknown>;
  }): Promise<acp.NewSessionResponse> {
    if (!this.conn) throw new Error("connection closed");
    return this.conn.newSession({
      cwd: p.cwd,
      mcpServers: p.mcpServers ?? [],
      ...(p.meta ? { _meta: p.meta } : {}),
    });
  }

  /** `session/load` — resume a stored session (loadSession capability). */
  async loadSession(p: {
    sessionId: string;
    cwd: string;
    mcpServers?: acp.McpServer[];
  }): Promise<acp.LoadSessionResponse> {
    if (!this.conn) throw new Error("connection closed");
    return this.conn.loadSession({
      sessionId: p.sessionId,
      cwd: p.cwd,
      mcpServers: p.mcpServers ?? [],
    });
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
    await this.conn.setSessionMode({ sessionId, modeId });
  }

  /** `session/set_config_option` — models/efforts/modes/config picks. */
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    if (!this.conn) throw new Error("connection closed");
    return this.conn.setSessionConfigOption({ sessionId, configId, value });
  }

  /** `session/close` when advertised — best-effort. */
  async closeSession(sessionId: string): Promise<void> {
    if (!this.conn) return;
    try {
      await this.conn.closeSession({ sessionId });
    } catch {
      /* the agent may not advertise session.close */
    }
  }

  /** Tear down the connection and the child process. */
  async close(): Promise<void> {
    try {
      /* ClientSideConnection has no close() — killing the child ends the
         stream and rejects `closed`; the process kill IS the teardown. */
      void this.conn?.closed;
    } catch {
      /* already closed */
    }
    if (this.proc && this.proc.exitCode === null) this.proc.kill("SIGTERM");
    this.proc = undefined;
    this.conn = undefined;
    this.promptQueues.clear();
  }
}
