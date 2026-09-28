import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ContentBlock,
  EngineRequest,
  McpServer,
  SessionStartParams,
} from "@lilos/contracts/engine";
import { acpOfferedOutcomes, acpPickOptionId } from "./acp-permissions.js";
import type { HermesEngine } from "./engine.js";
import type { Session } from "./session.js";

/**
 * ACP transport driver — the path #23's verdict settled on for session-scoped
 * MCP servers (WS `session.create` has no `mcp_servers`). One `hermes acp`
 * stdio child per LilOS session: `session/new {cwd, mcpServers}` does the
 * attach. Turn events arrive as `session/update` notifications; tool
 * approvals arrive as `session/request_permission`; compression rotation is
 * reported via `session_info_update`'s `_meta.hermes.sessionProvenance`
 * (acp_adapter/provenance.py).
 */
export interface AcpOptions {
  /** Path to the `hermes` binary. */
  bin: string;
  /** Extra argv after `acp` (e.g. ["--profile", "lilos7"]). */
  args?: string[];
  /** Extra env for the child (e.g. HERMES_HOME for an isolated profile). */
  env?: Record<string, string>;
}

interface QueuedTurn {
  turnId: string;
  content: ContentBlock[];
  /** True for steer-queued turns — the engine mints turn.started at activation. */
  implicit: boolean;
  resolve: () => void;
  reject: (e: unknown) => void;
}

export class AcpDriver {
  private proc?: ChildProcess;
  private conn?: acp.ClientConnection;
  private sessionId = "";
  private queue: QueuedTurn[] = [];
  private pumping = false;

  private session?: Session;

  constructor(
    private opts: AcpOptions,
    private engine: HermesEngine,
  ) {}

  /**
   * Spawn `hermes acp`, initialize, `session/new` with the mcpServers.
   * Handlers bound here reference `this.session` lazily — `bind()` sets it
   * once the engine has created the Session object from this call's result.
   */
  async open(
    p: SessionStartParams,
  ): Promise<{ runtimeSid: string; ref: string }> {
    const env = {
      ...(process.env as Record<string, string>),
      ...this.opts.env,
    };
    // `agent` is the Hermes profile: `hermes acp --profile <name>` runs the
    // session under it (WS sessions use `session.create {profile}` instead).
    this.proc = spawn(
      this.opts.bin,
      ["acp", "--profile", p.agent, ...(this.opts.args ?? [])],
      {
        env,
        cwd: p.cwd,
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    const proc = this.proc;
    if (!proc.stdin || !proc.stdout)
      throw new Error("hermes acp stdio not piped");
    const stdin = Writable.toWeb(proc.stdin);
    const stdout = Readable.toWeb(proc.stdout);
    const stream = acp.ndJsonStream(stdin as never, stdout as never);

    const app = acp
      .client({ name: "lilos/engine-hermes" })
      .onRequest("session/request_permission", async (ctx) => {
        const s = this.session;
        if (!s) return { outcome: { outcome: "cancelled" as const } };
        return this.onPermission(s, ctx.params);
      })
      .onNotification("session/update", (ctx) => {
        if (this.session) this.onUpdate(this.session, ctx.params);
      });
    this.conn = app.connect(stream);

    await this.conn.agent.request("initialize", {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "lilos", version: "0" },
      // No fs/terminal delegation: the agent keeps its own file/terminal tools.
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    const res = (await this.conn.agent.request("session/new", {
      cwd: p.cwd,
      mcpServers: (p.mcpServers ?? []).map(toAcpMcp),
      _meta: {
        lilos: { agent: p.agent, ...(p.model ? { model: p.model } : {}) },
      },
    })) as { sessionId: string };
    this.sessionId = res.sessionId;
    return { runtimeSid: res.sessionId, ref: res.sessionId };
  }

  /** Called by the engine right after `open` resolves. */
  bind(s: Session) {
    this.session = s;
  }

  /** Enqueue a prompt turn; resolves once the agent accepted the request. */
  submit(
    s: Session,
    turnId: string,
    content: ContentBlock[],
    implicit = false,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ turnId, content, implicit, resolve, reject });
      void this.pump(s);
    });
  }

  private async pump(s: Session) {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const job = this.queue[0];
        if (!job || !this.conn) return;
        if (job.implicit) this.engine.beginTurn(s, job.turnId);
        const res = (await this.conn.agent.request("session/prompt", {
          sessionId: this.sessionId,
          prompt: job.content.map(toAcpContent),
        })) as acp.PromptResponse;
        this.queue.shift();
        job.resolve();
        this.engine.endAcpTurn(
          s,
          job.turnId,
          res.stopReason,
          res.usage ?? undefined,
        );
      }
    } catch (e) {
      const job = this.queue.shift();
      job?.reject(e);
    } finally {
      this.pumping = false;
    }
  }

  async interrupt(_s: Session): Promise<boolean> {
    if (!this.conn || !this.sessionId) return false;
    await this.conn.agent.notify("session/cancel", {
      sessionId: this.sessionId,
    });
    return true;
  }

  /**
   * ACP has no mid-turn injection: a steer while a turn runs is queued as the
   * next `session/prompt` — same outcome as engine-fake's idle-steer pump.
   */
  async steer(
    s: Session,
    text: string,
    mintTurnId: () => string,
  ): Promise<"steered" | "not_running"> {
    if (!s.turn || !this.conn) return "not_running";
    await this.submit(s, mintTurnId(), [{ type: "text", text }], true);
    return "steered";
  }

  async close(_s: Session): Promise<void> {
    try {
      if (this.conn && this.sessionId) {
        await this.conn.agent.request("session/close", {
          sessionId: this.sessionId,
        });
      }
    } catch {
      /* the agent may not advertise session.close */
    }
    try {
      this.conn?.close();
    } catch {
      /* already closed */
    }
    if (this.proc && this.proc.exitCode === null) this.proc.kill("SIGTERM");
  }

  // ── agent -> client frames ────────────────────────────────────────────────

  private static reqCounter = 0;

  private async onPermission(
    s: Session,
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const options = params.options ?? [];
    // Hermes sends two `allow_always`-kind options — allow_session is
    // session-scoped, not offerable as LilOS "always" (#133).
    const lilos = acpOfferedOutcomes(options);
    const tc = params.toolCall;
    const command =
      (typeof tc?.title === "string" && tc.title) ||
      (typeof tc?.name === "string" && tc.name) ||
      JSON.stringify(tc?.rawInput ?? {});
    const request: EngineRequest = {
      kind: "approval",
      command,
      options: lilos,
    };
    const wireId = `acp-${++AcpDriver.reqCounter}`;
    // No wire send: the promise return IS the answer.
    const answered = this.engine.openAsk(
      s,
      wireId,
      request,
      "approval",
      () => {},
    );
    const { outcome } = await answered;
    if (outcome === "cancel") return { outcome: { outcome: "cancelled" } };
    // Exact optionId first, kind fallback for unknown ids only; an
    // unanswerable outcome falls back to deny, never to "whatever came first"
    // (#133 — that first option was session-scoped allow_session).
    const optionId =
      acpPickOptionId(options, outcome) ??
      acpPickOptionId(options, "deny") ??
      options[0]?.optionId ??
      "";
    return {
      outcome: {
        outcome: "selected",
        optionId,
      },
    };
  }

  private onUpdate(s: Session, n: acp.SessionNotification) {
    const u = n.update as Record<string, unknown>;
    const turnId = s.turn?.turnId ?? s.lastTurnId;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const c = u.content as { text?: string } | undefined;
        if (c?.text)
          s.emit("turn.delta", { turnId, stream: "text", delta: c.text });
        if (s.turn) s.turn.phase = "text";
        break;
      }
      case "agent_thought_chunk": {
        const c = u.content as { text?: string } | undefined;
        if (c?.text)
          s.emit("turn.delta", { turnId, stream: "reasoning", delta: c.text });
        if (s.turn) s.turn.phase = "reasoning";
        break;
      }
      case "tool_call": {
        if (s.turn) s.turn.phase = "tools";
        s.emit("tool.started", {
          turnId,
          toolCallId: String(u.toolCallId ?? ""),
          tool:
            (typeof u.name === "string" && u.name) ||
            (typeof u.title === "string" && u.title) ||
            "tool",
          input:
            typeof u.rawInput === "object" && u.rawInput !== null
              ? (u.rawInput as Record<string, unknown>)
              : {},
        });
        break;
      }
      case "tool_call_update": {
        const status = u.status;
        if (status !== "completed" && status !== "failed") break;
        const out = u.rawOutput;
        s.emit("tool.completed", {
          turnId,
          toolCallId: String(u.toolCallId ?? ""),
          tool:
            (typeof u.name === "string" && u.name) ||
            (typeof u.title === "string" && u.title) ||
            "tool",
          status: status === "failed" ? "failed" : "completed",
          ...(out !== undefined && out !== null
            ? {
                output:
                  typeof out === "string"
                    ? out
                    : JSON.stringify(out).slice(0, 4000),
              }
            : {}),
        });
        break;
      }
      case "session_info_update": {
        const meta = u._meta as
          | {
              hermes?: {
                sessionProvenance?: { currentHermesSessionId?: string };
              };
            }
          | undefined;
        const ref = meta?.hermes?.sessionProvenance?.currentHermesSessionId;
        if (ref && ref !== s.ref) this.engine.bumpRef(s, ref);
        break;
      }
      case "usage_update": {
        const used = typeof u.used === "number" ? u.used : 0;
        const prev = s.usage ?? { input: 0, output: 0, reasoning: 0, cache: 0 };
        s.usage = { ...prev, input: used };
        break;
      }
      default:
        break;
    }
  }
}

function toAcpContent(b: ContentBlock): acp.ContentBlock {
  if (b.type === "image")
    return { type: "image", data: b.data, mimeType: b.mimeType, uri: b.uri };
  return { type: "text", text: b.text };
}

function toAcpMcp(m: McpServer): acp.McpServer {
  if ("type" in m) {
    return {
      type: m.type,
      name: m.name,
      url: m.url,
      headers: m.headers,
    } as never;
  }
  return {
    name: m.name,
    command: m.command,
    args: m.args,
    env: m.env,
  } as never;
}
