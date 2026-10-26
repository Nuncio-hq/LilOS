import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { ContentBlock, SessionStartParams } from "@lilos/contracts/engine";
import {
  type AcpUpdateHooks,
  acpApprovalRequest,
  acpPermissionAnswer,
  handleAcpUpdate,
  toAcpContent,
  toAcpMcp,
} from "@lilos/engine-acp";
import type { HermesEngine } from "./engine.js";
import { mapSubagentStatus, parseToolResultJson } from "./mapping.js";
import type { Session } from "./session.js";

/**
 * ACP transport driver — the path #23's verdict settled on for session-scoped
 * MCP servers (WS `session.create` has no `mcp_servers`). One `hermes acp`
 * stdio child per LilOS session: `session/new {cwd, mcpServers}` does the
 * attach. Turn events arrive as `session/update` notifications; tool
 * approvals arrive as `session/request_permission`; compression rotation is
 * reported via `session_info_update`'s `_meta.hermes.sessionProvenance`
 * (acp_adapter/provenance.py).
 *
 * D-#764 — the wire translation itself lives in packages/engine-acp:
 * `handleAcpUpdate` maps update kinds -> engine events, `acpApprovalRequest`
 * / `acpPermissionAnswer` map permission asks (optionId-first — the #133
 * allow_session/allow_always trap). What stays here is Hermes-only surface:
 * the spawn argv (`hermes acp --profile`), the access -> mode ids Hermes
 * uses (`accept_edits`/`dont_ask`), `_meta.lilos` provenance on
 * `session/new`, and the hooks that synthesize subagent.* rows off
 * delegate_task calls and process rows off terminal calls.
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
    /* #106 AC-5: Ask maps to `accept_edits` so ordinary workspace edits
       don't start asking once sessions move to ACP; Full maps to
       `dont_ask`. Hint only — the harness enforces access itself. */
    await this.setAccess(p.access ?? "ask");
    return { runtimeSid: res.sessionId, ref: res.sessionId };
  }

  /** `session/set_mode` for the conversation's access level (best-effort). */
  async setAccess(access: "ask" | "full"): Promise<void> {
    if (!this.conn || !this.sessionId) return;
    try {
      await this.conn.agent.request("session/set_mode", {
        sessionId: this.sessionId,
        modeId: access === "full" ? "dont_ask" : "accept_edits",
      });
    } catch {
      /* Builds without set_mode keep harness-side enforcement. */
    }
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
    if ((!s.turn && !s.legTurnId) || !this.conn) return "not_running";
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

  /**
   * `session/request_permission` -> LilOS approval ask via the shared map
   * (D-#764): the optionId — not the kind — carries the real answer;
   * Hermes sends two `allow_always`-kind options where `allow_session` is
   * session-scoped, not offerable as LilOS "always" (#133).
   */
  private async onPermission(
    s: Session,
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const request = acpApprovalRequest(params);
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
    return acpPermissionAnswer(params, outcome).response;
  }

  private onUpdate(s: Session, n: acp.SessionNotification) {
    handleAcpUpdate(s, n, hermesHooks(this.engine));
  }
}

/** Hermes-only layers over the shared update map (D-#764): subagent row
    synthesis off delegate_task calls (#179/#309/#327), process tracking
    off terminal calls, and `_meta.hermes.sessionProvenance` ref bumps. */
function hermesHooks(engine: HermesEngine): AcpUpdateHooks<Session> {
  return {
    onToolCall(s, _u, { callId, tool, input }) {
      const turnId = s.turn?.turnId ?? s.lastTurnId;
      /* #179: ACP drops subagent.* frames — synthesize flat rows off the
         delegate call's task list; per-task status arrives on its update. */
      if (tool === "delegate_task") {
        s.delegateStack.push(callId);
        const tasks = Array.isArray(input.tasks) ? input.tasks : [];
        tasks.forEach((t, i) => {
          const subagentId = s.subagentId(`${callId}:${i}`);
          s.emit("subagent.started", {
            turnId,
            subagentId,
            name: `task ${i + 1}`,
            task:
              typeof (t as { goal?: unknown })?.goal === "string"
                ? ((t as { goal: string }).goal as string)
                : "",
            parentToolCallId: callId,
            startedAt: Date.now(),
          });
        });
      }
      if (tool === "terminal")
        s.terminalCalls.set(
          callId,
          typeof input.command === "string" ? input.command : "",
        );
    },
    onToolCallUpdate(s, _u, { callId, tool, status, out }) {
      /* #179: close the synthesized rows — per-task statuses parse off the
         formatted "Task N: ✅/✗/⏱/⚠" lines, else the call's own status.
         #309: an async delegate's tool call closes with a dispatch
         receipt ({status:"dispatched"}) — the children keep running;
         closing their rows here would lie. ACP relays no native
         subagent.completed, so a dispatched row could never close —
         #327 marks it untracked instead, and Session.setState settles
         it stopped once the session leaves "running" (a real close
         lands only over the WS event path). */
      const dispatched = (() => {
        /* The receipt arrives as a JSON string or an already-parsed
           object — either way `status:"dispatched"` means the children
           keep running. */
        const status = (() => {
          if (typeof out === "string") {
            try {
              return (JSON.parse(out) as { status?: unknown }).status;
            } catch {
              return undefined;
            }
          }
          if (out !== null && typeof out === "object") {
            return (out as { status?: unknown }).status;
          }
          return undefined;
        })();
        return status === "dispatched";
      })();
      if (s.delegateStack.includes(callId)) {
        s.delegateStack = s.delegateStack.filter((id) => id !== callId);
        const text = typeof out === "string" ? out : "";
        const perTask = new Map<number, string>();
        for (const m of text.matchAll(/[✅✗⏱⚠]\s*Task (\d+):\s*(\w+)/g))
          perTask.set(Number(m[1]), m[2]);
        if (!dispatched)
          s.subagentsForCall(callId).forEach((subagentId, i) => {
            const word = perTask.get(i + 1);
            s.emit("subagent.completed", {
              subagentId,
              status: word
                ? mapSubagentStatus(word)
                : status === "failed"
                  ? "failed"
                  : "done",
            });
          });
        else
          for (const id of s.subagentsForCall(callId)) {
            s.untrackedSubagents.add(id);
          }
      }
      const command = s.terminalCalls.get(callId);
      s.terminalCalls.delete(callId);
      if (tool === "terminal" && status === "completed") {
        const result = parseToolResultJson(out);
        const procId =
          typeof result?.session_id === "string" ? result.session_id : "";
        const pid = typeof result?.pid === "number" ? result.pid : undefined;
        if (procId) engine.startJob(s, procId, command ?? "", pid);
      }
    },
    onSessionInfo(s, u) {
      const meta = (u as { _meta?: unknown })._meta as
        | {
            hermes?: {
              sessionProvenance?: { currentHermesSessionId?: string };
            };
          }
        | undefined;
      const ref = meta?.hermes?.sessionProvenance?.currentHermesSessionId;
      if (ref && ref !== s.ref) engine.bumpRef(s, ref);
    },
  };
}
