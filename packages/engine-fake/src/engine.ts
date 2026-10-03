import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AgentDescriptor,
  type AgentsCreateParams,
  type AgentsDescribeParams,
  type AgentsUpdateParams,
  APPROVAL_POLICY_CAPABILITY,
  type ApprovalOption,
  type ApprovalOutcome,
  type ApprovalPolicy,
  type ApprovalsSetPolicyParams,
  BACKGROUND_JOBS_CAPABILITY,
  type Capability,
  type ContentBlock,
  type ConversationAccess,
  ENGINE_METHODS,
  ENGINE_PROTOCOL,
  type EngineEvent,
  type EngineEventType,
  type EventsSinceParams,
  type FileDiff,
  IMAGE_PROMPT_CAPABILITY,
  type InterruptParams,
  type JobStatus,
  type JobsListParams,
  type JobsStopParams,
  type KnownCapability,
  type ModelsListParams,
  PLAN_CAPABILITY,
  type PlanStep,
  type PromptParams,
  REWIND_CAPABILITY,
  type RequestRespondParams,
  RPC_ERRORS,
  SESSION_META_CAPABILITY,
  type SessionRewindParams,
  type SessionSetAccessParams,
  type SessionSetHiddenParams,
  type SessionSetModelParams,
  type SessionSetTitleParams,
  type SessionStartParams,
  type SessionState,
  type SessionSteerParams,
  type SessionStopParams,
  STEER_CAPABILITY,
  SUBAGENTS_CAPABILITY,
  type Usage,
} from "@lilos/contracts/engine";
import {
  DEFAULT_MODEL,
  type FakeAgent,
  type FakeModel,
  MODEL_CATALOG,
  REFRESH_MODEL,
  SEED_AGENTS,
} from "./catalog.js";
import { type McpClient, startMcpHttp, startMcpServer } from "./mcp.js";
import {
  type FakeScript,
  type FakeStep,
  type FakeSubagent,
  scriptFor,
} from "./script.js";

/* ── subagents + background jobs (#179) ────────────────────────────────── */

/** Live state of one background process the fake leaves running. */
interface FakeJob {
  jobId: string;
  command: string;
  status: JobStatus;
  startedAt: number;
  /** Set when the job exits — jobs.list freezes uptimeSeconds at it. */
  endedAt?: number;
  exitCode?: number;
  url?: string;
  by?: string;
  /** Rolling ~4KB tail — job.output replaces, never appends. */
  tail: string;
  /** Script lines still to pump. */
  lines: string[];
  /** Emit job.exited with this code once lines drain; absent = runs forever. */
  exitCodeOnDrain?: number;
  timer?: ReturnType<typeof setInterval>;
}

/** Transport-agnostic failure; the transports translate it into a JSON-RPC error object. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

interface PendingAsk {
  turnId: string;
  requestId: string;
  request: Extract<
    EngineEvent,
    { type: "request.opened" }
  >["payload"]["request"];
  seq: number;
  resolve: (outcome: { outcome: ApprovalOutcome; answer?: string }) => void;
}

/** First localhost-ish URL in a job tail — the "URL (when printed)" the
    Background tab shows (AC-4). */
const firstLocalUrl = (tail: string) =>
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\/?/.exec(
    tail,
  )?.[0];

/** Base64 length -> decoded bytes, without pulling node:buffer into packages. */
const decodedBytes = (base64: string) => {
  let n = Math.floor((base64.length * 3) / 4);
  if (base64.endsWith("==")) n -= 2;
  else if (base64.endsWith("=")) n -= 1;
  return n;
};

interface FakeTurn {
  turnId: string;
  phase: "reasoning" | "tools" | "text" | "waiting";
  interrupted: boolean;
}

interface FakeSession {
  id: string;
  /** Durable external ref (the engine's stored-session-id analogue); init = id. */
  ref: string;
  agent: string;
  cwd: string;
  model?: string;
  /** The rest of the session's pick (issue #92): provider, effort, fast. */
  provider?: string;
  effort?: string;
  fast?: boolean;
  /** A pick taken mid-turn — model/provider/effort apply at the next turn
      (#92 AC-4); fast is already live on the session (engines mutate the
      running tier, no deferral). */
  pendingPick?: {
    model: string;
    provider?: string;
    effort?: string;
  };
  mcpServers: unknown[];
  /** Spawned lazily on first mcp__<server>__<tool> step — a session that never drives surfaces costs zero children. */
  mcpClients: Map<string, McpClient>;
  branch: string;
  seq: number;
  log: EngineEvent[];
  state: SessionState;
  openRequests: Map<string, PendingAsk>;
  /** session_meta (#28): user-visible title + archive flag, mirrored from LilOS. */
  title: string;
  hidden: boolean;
  /** #137: once `session.setTitle` lands, the title is user-provenance —
      derived/llm stages never overwrite it. */
  titleUserSet: boolean;
  /** #106: the conversation's access level stamped at start / by
      session.setAccess — recorded only (the harness enforces `full`). */
  access: ConversationAccess;
  /** #106: "This session" grants — the command asks again in a NEW session. */
  sessionGranted: Set<string>;
  usage: Usage;
  steers: { text: string; ref?: string }[];
  /** #134: every user input the session heard (prompt + accepted steer),
      in order — `session.rewind {toTurn}` truncates this list. */
  userTurns: string[];
  turn?: FakeTurn;
  turnCount: number;
  toolCounter: number;
  requestCounter: number;
  /** #179: background processes this session left running (jobs.* + job.*). */
  jobs: Map<string, FakeJob>;
  jobCounter: number;
  subCounter: number;
  /** #400: `LILOS_TURN_HOLD` parks the turn past `turn.started` until this
      releases it (interrupt or session stop) — a test asserting the running
      state never races the script's length. */
  holdTurn?: () => void;
  /** #309: async helpers whose subagent.completed waits past turn end. */
  pendingSubagentClose: {
    subagentId: string;
    status: FakeSubagent["status"];
    result?: string;
    durationMs?: number;
    /** #400: held entries flush only when the next turn intake arrives —
        the tick drain leaves them parked. */
    hold?: boolean;
  }[];
}

export interface FakeEngineOptions {
  /** Base delay per boundary in ms; tests pass ~2, the WS script can stay default. */
  tick?: number;
  /**
   * Capability switches, on by default — `{ steer: false }` serves an engine
   * that does not declare `steer`: `describe` omits it and `session.steer`
   * answers METHOD_NOT_FOUND.
   */
  capabilities?: Partial<Record<KnownCapability, boolean>>;
  /**
   * Session-id namespace for this engine run, defaults to a random token per
   * instance: a restarted process can never re-issue an id a previous run
   * already used (#61 — an `events.since` on a stale id then misses instead of
   * aliasing a stranger's session). Pass a fixed value when a test needs
   * deterministic ids.
   */
  sessionNamespace?: string;
}

/**
 * The deterministic stand-in engine: the prototype's canned turns driven over
 * the wire protocol. Sessions are always edit-capable (a synthetic branch per
 * session, mirroring the prototype's "Start work" worktree), so an edit-ask
 * prompt produces a mutating step that asks for approval — the conformance
 * suite exercises that path.
 */
export class FakeEngine {
  private readonly tick: number;
  private sessions = new Map<string, FakeSession>();
  /** The fake's agent catalog — created agents persist for the process life. */
  private agents = new Map<string, FakeAgent>(
    SEED_AGENTS.map((a) => [a.id, a]),
  );
  private listeners = new Set<(e: EngineEvent) => void>();
  /**
   * Permanent approval grants — `${agent}\n${command}` recorded on every
   * "always" answer (#133). A real engine's permanent allow writes the
   * command to a profile allowlist that outlives the session; a
   * session-scoped flag (the old `alwaysApproved`) mimicked the
   * `allow_session` bug instead — a new session must NOT re-ask a granted
   * command, and MUST still ask for a different one.
   */
  private alwaysGranted = new Set<string>();
  /** #106: the engine's global approval policy — `approvals.setPolicy`
      writes it and `describe` reports it as `detail.current`. */
  private policy: ApprovalPolicy = "smart";
  private readonly sessionNamespace: string;
  private sessionCounter = 0;
  private refCounter = 0;
  private turnCounter = 0;
  private hexCounter = 0;

  constructor(opts: FakeEngineOptions = {}) {
    this.tick = opts.tick ?? 25;
    this.caps = opts.capabilities ?? {};
    this.sessionNamespace = opts.sessionNamespace ?? randomNamespace();
  }

  private readonly caps: Partial<Record<KnownCapability, boolean>>;
  /** `models.list {refresh:true}` was served at least once — the refresh-only
      model has joined the catalog for every later read + validation (#140). */
  private servedRefresh = false;

  /** A capability is on unless the options explicitly set it false. */
  private capOn(cap: string): boolean {
    return this.caps[cap as KnownCapability] !== false;
  }

  /** The catalog the engine currently offers: the seed rows, plus
      REFRESH_MODEL once a refresh surfaced it (a live fetch updates the
      gateway's cache the same way — a model the account just offered stays
      offerable, #140 AC-2). */
  private catalog(): FakeModel[] {
    return this.servedRefresh
      ? [...MODEL_CATALOG, REFRESH_MODEL]
      : MODEL_CATALOG;
  }

  /** Subscribe to every session's event stream (notifications out). */
  onEvent(fn: (e: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Rotate a session's durable ref — engines rotate their stored id on
   * non-in-place compression; the transport sessionId stays stable, only the
   * external resume token moves. Emits `session.ref.changed {ref, previousRef}`.
   * Returns the new ref, or null for an unknown session.
   */
  rotateSessionRef(sessionId: string): string | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    const previousRef = s.ref;
    s.ref = `${s.ref}-r${++this.refCounter}`;
    this.emit(s, "session.ref.changed", { ref: s.ref, previousRef });
    return s.ref;
  }

  async dispatch(method: string, params: unknown): Promise<unknown> {
    const contract = ENGINE_METHODS[method];
    if (!contract)
      throw new RpcError(
        RPC_ERRORS.METHOD_NOT_FOUND,
        `unknown method: ${method}`,
      );
    // A method gated by a capability the engine did not declare behaves as absent.
    if (contract.capability && !this.capOn(contract.capability))
      throw new RpcError(
        RPC_ERRORS.METHOD_NOT_FOUND,
        `capability not declared: ${contract.capability}`,
      );
    const parsed = contract.params.safeParse(params ?? {});
    if (!parsed.success)
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        `invalid params: ${parsed.error.message}`,
      );
    switch (method) {
      case "describe":
        return this.describe();
      case "session.start":
        return this.sessionStart(parsed.data as SessionStartParams);
      case "prompt":
        return this.prompt(parsed.data as PromptParams);
      case "interrupt":
        return this.interrupt(parsed.data as InterruptParams);
      case "request.respond":
        return this.requestRespond(parsed.data as RequestRespondParams);
      case "events.since":
        return this.eventsSince(parsed.data as EventsSinceParams);
      case "session.stop":
        return this.sessionStop(parsed.data as SessionStopParams);
      case "session.steer":
        return this.sessionSteer(parsed.data as SessionSteerParams);
      case "session.rewind":
        return this.sessionRewind(parsed.data as SessionRewindParams);
      case "agents.list":
        return this.agentsList();
      case "agents.describe":
        return this.agentsDescribe(parsed.data as AgentsDescribeParams);
      case "agents.create":
        return this.agentsCreate(parsed.data as AgentsCreateParams);
      case "agents.update":
        return this.agentsUpdate(parsed.data as AgentsUpdateParams);
      case "models.list":
        return this.modelsList(parsed.data as ModelsListParams);
      case "session.setModel":
        return this.sessionSetModel(parsed.data as SessionSetModelParams);
      case "session.setTitle":
        return this.sessionSetTitle(parsed.data as SessionSetTitleParams);
      case "session.setHidden":
        return this.sessionSetHidden(parsed.data as SessionSetHiddenParams);
      /* ── background jobs (#179) ── */
      case "jobs.list":
        return this.jobsList(parsed.data as JobsListParams);
      case "jobs.stop":
        return this.jobsStop(parsed.data as JobsStopParams);
      case "approvals.setPolicy":
        return this.approvalsSetPolicy(parsed.data as ApprovalsSetPolicyParams);
      case "session.setAccess":
        return this.sessionSetAccess(parsed.data as SessionSetAccessParams);
      default:
        throw new RpcError(
          RPC_ERRORS.METHOD_NOT_FOUND,
          `unhandled method: ${method}`,
        );
    }
  }

  // ── methods ──────────────────────────────────────────────────────────────

  private describe() {
    const capabilities: Capability[] = [
      ...(this.capOn("steer") ? [STEER_CAPABILITY] : []),
      ...(this.capOn("image_prompt") ? [IMAGE_PROMPT_CAPABILITY] : []),
      {
        id: "mcp_servers",
        name: "MCP servers",
        description:
          "Accepts stdio + streamable-HTTP MCP servers on session.start (ACP shape).",
        detail: { transports: ["stdio", "http"] },
      },
      {
        id: "agents",
        name: "Hireable agents",
        description:
          "List, describe, create and update engine profiles; sessions start as one.",
        methods: [
          "agents.list",
          "agents.describe",
          "agents.create",
          "agents.update",
        ],
        detail: {
          // Every persona field is writable here (D-#19).
          updatable: ["name", "description", "soul", "model"],
        },
      },
      ...(this.capOn("models")
        ? [
            {
              id: "models",
              name: "Model picker",
              description:
                "List selectable models and pin a session's model for its next turn.",
              methods: ["models.list", "session.setModel"],
              /* #92: the picker shows Refresh / effort / ⚡Fast only when the
                 engine declares them — the fake declares all three. */
              detail: { refreshable: true, effort: true, fast: true },
            },
          ]
        : []),
      ...(this.capOn("session_meta") ? [SESSION_META_CAPABILITY] : []),
      ...(this.capOn("rewind") ? [REWIND_CAPABILITY] : []),
      ...(this.capOn("plan") ? [PLAN_CAPABILITY] : []),
      /* ── #179: declared only while the switch is on (AC-5). ── */
      ...(this.capOn("subagents") ? [SUBAGENTS_CAPABILITY] : []),
      ...(this.capOn("background_jobs") ? [BACKGROUND_JOBS_CAPABILITY] : []),
      /* #106: the policy the Settings Approvals section writes via
         approvals.setPolicy — `current` reports the live value. */
      ...(this.capOn("approval_policy")
        ? [
            {
              ...APPROVAL_POLICY_CAPABILITY,
              detail: {
                options: ["smart", "manual", "off"],
                current: this.policy,
              },
            },
          ]
        : []),
    ];
    return {
      name: "engine-fake",
      version: "0.0.0",
      protocol: ENGINE_PROTOCOL,
      capabilities,
    };
  }

  private sessionStart(p: SessionStartParams) {
    if (
      (p.mcpServers ?? []).some(
        (s) => "type" in s && (s as { type?: unknown }).type !== "http",
      )
    ) {
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        "engine-fake accepts stdio + http mcpServers only",
      );
    }
    const spec = this.agents.get(p.agent);
    if (!spec)
      throw new RpcError(
        RPC_ERRORS.AGENT_NOT_FOUND,
        `no agent ${p.agent} — hire it via agents.create first`,
      );
    const id = `s-${this.sessionNamespace}-${++this.sessionCounter}`;
    const picked = this.catalog().find((m) => m.id === (p.model ?? spec.model));
    const s: FakeSession = {
      ref: id,
      id,
      agent: p.agent,
      cwd: p.cwd,
      model: p.model ?? spec.model,
      provider: p.provider ?? picked?.provider,
      effort: p.effort ?? picked?.defaultEffort,
      fast: p.fast,
      mcpServers: p.mcpServers ?? [],
      mcpClients: new Map(),
      branch: `work/${p.agent}-${id}`,
      seq: 0,
      log: [],
      state: "idle",
      openRequests: new Map(),
      title: "",
      hidden: false,
      titleUserSet: false,
      access: p.access ?? "ask",
      sessionGranted: new Set(),
      usage: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: 0,
        /* The window the session runs in, resolved at start like a real
           engine's (picked row reports none -> field stays absent). */
        ...(picked?.contextWindow
          ? { contextWindow: picked.contextWindow }
          : {}),
      },
      steers: [],
      userTurns: [],
      turnCount: 0,
      toolCounter: 0,
      requestCounter: 0,
      jobs: new Map(),
      jobCounter: 0,
      pendingSubagentClose: [],
      subCounter: 0,
    };
    this.sessions.set(id, s);
    this.emit(s, "session.started", {
      agent: p.agent,
      cwd: p.cwd,
      model: s.model,
      provider: s.provider,
      effort: s.effort,
      fast: s.fast,
    });
    this.setState(s, "idle");
    return { sessionId: id };
  }

  private prompt(p: PromptParams) {
    const s = this.require(p.sessionId);
    if (s.state === "closed")
      throw new RpcError(RPC_ERRORS.INVALID_STATE, `session ${s.id} is closed`);
    if (s.turn)
      throw new RpcError(
        RPC_ERRORS.INVALID_STATE,
        `session ${s.id} already has a running turn`,
      );
    const imageBlocks = p.content.filter(
      (b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image",
    );
    if (imageBlocks.length && !this.capOn("image_prompt")) {
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        "image blocks require the image_prompt capability",
      );
    }
    const text = p.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const images = imageBlocks.map((b) => ({
      mimeType: b.mimeType,
      sizeBytes: decodedBytes(b.data),
    }));
    s.userTurns.push(text);
    return this.runTurn(s, text, images, p.ref);
  }

  private interrupt(p: InterruptParams) {
    const s = this.require(p.sessionId);
    if (!s.turn) return { interrupted: false };
    s.turn.interrupted = true;
    s.holdTurn?.();
    for (const ask of s.openRequests.values())
      ask.resolve({ outcome: "cancel" });
    return { interrupted: true };
  }

  private requestRespond(p: RequestRespondParams) {
    const s = this.require(p.sessionId);
    const ask = s.openRequests.get(p.requestId);
    if (!ask)
      throw new RpcError(
        RPC_ERRORS.REQUEST_NOT_FOUND,
        `no open request ${p.requestId}`,
      );
    if (ask.request.kind === "approval" && p.outcome === "answer") {
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        "an approval takes once/session/always/deny/cancel, not answer",
      );
    }
    if (
      ask.request.kind === "approval" &&
      !(ask.request.options as ApprovalOutcome[]).includes(p.outcome)
    ) {
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        `outcome ${p.outcome} not in offered options`,
      );
    }
    if (
      ask.request.kind === "question" &&
      p.outcome !== "answer" &&
      p.outcome !== "cancel"
    ) {
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        "a question takes answer or cancel",
      );
    }
    /* #180 — a plan ask takes approve / reject / change (the change text in
       `answer`) or cancel. Double-answering is already refused by the
       openRequests lookup above (the id is gone once resolved). */
    if (
      ask.request.kind === "plan" &&
      !(
        p.outcome === "approve" ||
        p.outcome === "reject" ||
        p.outcome === "change" ||
        p.outcome === "cancel"
      )
    ) {
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        "a plan request takes approve, reject, change or cancel",
      );
    }
    if (
      ask.request.kind === "plan" &&
      p.outcome === "change" &&
      !p.answer?.trim()
    ) {
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        "a plan change needs the change text in answer",
      );
    }
    if (p.outcome === "answer" && p.answer === undefined) {
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        "outcome answer needs an answer field",
      );
    }
    if (ask.request.kind === "approval" && p.outcome === "always")
      this.alwaysGranted.add(`${s.agent}\n${ask.request.command}`);
    /* #106 AC-4: "This session" records the same command on the session —
       it stops repeats here and nowhere else: a new session asks again. */
    if (ask.request.kind === "approval" && p.outcome === "session")
      s.sessionGranted.add(ask.request.command);
    s.openRequests.delete(p.requestId);
    this.emit(s, "request.resolved", {
      requestId: p.requestId,
      outcome: p.outcome,
      answer: p.answer,
    });
    ask.resolve({ outcome: p.outcome, answer: p.answer });
    return { accepted: true as const };
  }

  /* ── #106 approval modes ───────────────────────────────────────────── */

  private approvalsSetPolicy(p: ApprovalsSetPolicyParams) {
    this.policy = p.policy;
    return { policy: this.policy };
  }

  private sessionSetAccess(p: SessionSetAccessParams) {
    const s = this.require(p.sessionId);
    s.access = p.access;
    return { access: s.access };
  }

  private eventsSince(p: EventsSinceParams) {
    const s = this.require(p.sessionId);
    return {
      events: s.log.filter((e) => e.seq > p.after),
      latestSeq: s.seq,
      truncated: false,
      openRequests: [...s.openRequests.values()].map((a) => ({
        requestId: a.requestId,
        turnId: a.turnId,
        request: a.request,
        seq: a.seq,
      })),
      snapshot: this.snapshot(s),
    };
  }

  private sessionStop(p: SessionStopParams) {
    const s = this.require(p.sessionId);
    if (s.state === "closed") return { stopped: false };
    const t = s.turn;
    if (t) t.interrupted = true;
    s.holdTurn?.();
    for (const ask of s.openRequests.values())
      ask.resolve({ outcome: "cancel" });
    for (const c of s.mcpClients.values()) c.close();
    s.mcpClients.clear();
    /* #179: a closed session stops its pumps; running rows settle stopped. */
    for (const job of s.jobs.values()) {
      if (job.timer) clearInterval(job.timer);
      if (job.status === "running") {
        job.status = "stopped";
        job.exitCode = 15;
        this.emit(s, "job.exited", {
          jobId: job.jobId,
          status: "stopped",
          exitCode: 15,
        });
      }
    }
    s.state = "closed";
    this.emit(s, "session.state", { state: "closed" });
    return { stopped: true };
  }

  /** Every attached MCP child across sessions — test cleanup + shutdown. */
  closeAllMcp() {
    for (const s of this.sessions.values()) {
      for (const c of s.mcpClients.values()) c.close();
      s.mcpClients.clear();
    }
  }

  private sessionSteer(p: SessionSteerParams) {
    const s = this.require(p.sessionId);
    if (s.state === "closed")
      throw new RpcError(RPC_ERRORS.INVALID_STATE, `session ${s.id} is closed`);
    if (!s.turn)
      // not_running consumes nothing — the client sends the text as prompt.
      return { status: "not_running" as const };
    /* `ref` rides along so a steer pumped into a fresh turn still echoes
       it on `turn.started` — rewind filtering keys off it (#134). */
    s.steers.push({ text: p.text, ref: p.ref });
    /* A steer is a user turn the agent heard mid-run — counted so a rewind
       drops it like a prompt (#134). */
    s.userTurns.push(p.text);
    return { status: "steered" as const };
  }

  /**
   * `session.rewind` (#134): drop every user turn after `toTurn` — the
   * memory half of "Rewind to here" (the folder restore is the harness's
   * checkpoint store). Refuses while a turn runs, like a real engine.
   */
  private sessionRewind(p: SessionRewindParams) {
    const s = this.require(p.sessionId);
    if (s.state === "closed")
      throw new RpcError(RPC_ERRORS.INVALID_STATE, `session ${s.id} is closed`);
    if (s.turn)
      throw new RpcError(
        RPC_ERRORS.INVALID_STATE,
        `session ${s.id} has a running turn — interrupt it first`,
      );
    const removed = Math.max(0, s.userTurns.length - p.toTurn);
    if (removed > 0) {
      s.userTurns.length = p.toTurn;
      s.turnCount = s.userTurns.length;
      /* Queued steers always post-date the rewind target (they were accepted
         inside a turn the rewind now removes). */
      s.steers.length = 0;
    }
    return { removed };
  }

  private agentsList() {
    // Roster rows stay light: the persona text is describe-only.
    const agents = [...this.agents.values()].map(
      ({ soul: _soul, ...row }): AgentDescriptor => row,
    );
    return { agents };
  }

  private agentsDescribe(p: AgentsDescribeParams) {
    const a = this.agents.get(p.id);
    if (!a) throw new RpcError(RPC_ERRORS.AGENT_NOT_FOUND, `no agent ${p.id}`);
    return { agent: { ...a } satisfies AgentDescriptor };
  }

  private agentsCreate(p: AgentsCreateParams) {
    if (this.agents.has(p.name))
      throw new RpcError(
        RPC_ERRORS.INVALID_STATE,
        `agent ${p.name} already exists`,
      );
    if (p.model !== undefined && !this.catalog().some((m) => m.id === p.model))
      throw new RpcError(RPC_ERRORS.MODEL_NOT_FOUND, `no model ${p.model}`);
    const agent: FakeAgent = {
      id: p.name,
      name: p.name,
      description: p.description ?? "",
      model: p.model ?? DEFAULT_MODEL,
      skillCount: 0,
      soul: p.soul ?? "",
    };
    this.agents.set(agent.id, agent);
    return { agent: { ...agent } satisfies AgentDescriptor };
  }

  /**
   * Rewrite the agent's persona fields in place — the id never moves. New
   * sessions read the updated row at `session.start`; sessions already
   * running keep the snapshot they took (#123 AC-4).
   */
  private agentsUpdate(p: AgentsUpdateParams) {
    const a = this.agents.get(p.id);
    if (!a) throw new RpcError(RPC_ERRORS.AGENT_NOT_FOUND, `no agent ${p.id}`);
    if (p.model !== undefined && !this.catalog().some((m) => m.id === p.model))
      throw new RpcError(
        RPC_ERRORS.MODEL_NOT_FOUND,
        `no model ${p.model} — see models.list`,
      );
    if (p.name !== undefined) a.name = p.name;
    if (p.description !== undefined) a.description = p.description;
    if (p.soul !== undefined) a.soul = p.soul;
    if (p.model !== undefined) a.model = p.model;
    return { agent: { ...a } satisfies AgentDescriptor };
  }

  private modelsList(p: ModelsListParams) {
    /* refresh:true re-probes the catalog — the fake gains REFRESH_MODEL
       deterministically so "a new model appears without restart" is
       testable (#92 AC-6); once served it stays in the catalog, like the
       gateway's updated cache (#140 AC-2). */
    if (p.refresh) this.servedRefresh = true;
    return {
      models: this.catalog().map((m) => ({ ...m })),
      default: DEFAULT_MODEL,
      defaultProvider: "fake",
      providers: [{ id: "fake", name: "Fake" }],
    };
  }

  private sessionSetModel(p: SessionSetModelParams) {
    const s = this.require(p.sessionId);
    if (s.state === "closed")
      throw new RpcError(RPC_ERRORS.INVALID_STATE, `session ${s.id} is closed`);
    /* Model ids are opaque — `p.model` is matched verbatim, never split on
       "/" (issue #92 AC-8); `provider` is a separate field end to end. The
       pick validates against the catalog the engine currently offers — a
       refresh-only model is accepted only once a refresh served it (#140
       AC-2 — the gate a real adapter applies). */
    const m = this.catalog().find((x) => x.id === p.model);
    if (!m)
      throw new RpcError(
        RPC_ERRORS.MODEL_NOT_FOUND,
        `no model ${p.model} — see models.list`,
      );
    if (p.effort !== undefined && !(m.efforts ?? []).includes(p.effort))
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        `model ${p.model} has no effort level "${p.effort}"`,
      );
    if (p.fast === true && !m.fast)
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        `model ${p.model} has no fast tier`,
      );
    /* A pick mid-turn defers the model leg to the next turn — the ack
       carries the requested values plus `deferred` (issue #92 AC-4). The
       fast leg applies LIVE (engines that support fast mutate the running
       session's tier — no running check), so `s.fast` moves now; the stash
       carries it so the deferred apply can't drop it at turn start. */
    if (s.turn) {
      s.pendingPick = {
        model: p.model,
        ...(p.provider !== undefined ? { provider: p.provider } : {}),
        ...(p.effort !== undefined ? { effort: p.effort } : {}),
      };
      if (p.fast !== undefined) s.fast = p.fast;
      return {
        model: p.model,
        ...(p.provider !== undefined
          ? { provider: p.provider }
          : m.provider !== undefined
            ? { provider: m.provider }
            : {}),
        ...(p.effort !== undefined ? { effort: p.effort } : {}),
        ...(p.fast !== undefined ? { fast: p.fast } : {}),
        deferred: true,
      };
    }
    return this.applyPick(s, p);
  }

  /* Apply a validated pick to the session — a bare model switch resets
     effort/fast to the picked model's defaults (the old model's levels
     don't transfer); an explicit pick wins. */
  private applyPick(
    s: FakeSession,
    p: {
      model: string;
      provider?: string;
      effort?: string;
      fast?: boolean;
    },
  ) {
    const m = this.catalog().find((x) => x.id === p.model);
    if (!m)
      throw new RpcError(
        RPC_ERRORS.MODEL_NOT_FOUND,
        `no model ${p.model} — see models.list`,
      );
    if (p.effort !== undefined && !(m.efforts ?? []).includes(p.effort))
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        `model ${p.model} has no effort level "${p.effort}"`,
      );
    if (p.fast === true && !m.fast)
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        `model ${p.model} has no fast tier`,
      );
    const prevModel = s.model;
    s.model = p.model;
    /* The resolved window follows the model — a pick onto a row that
       reports none drops the field, so the meter can't reuse a stale
       number the new model never claimed (#294). */
    if (m.contextWindow) s.usage.contextWindow = m.contextWindow;
    else delete s.usage.contextWindow;
    s.provider = p.provider ?? m.provider;
    s.effort = p.effort ?? m.defaultEffort;
    s.fast =
      p.fast !== undefined
        ? p.fast
        : p.model === prevModel
          ? s.fast
          : undefined;
    return {
      model: s.model,
      provider: s.provider,
      effort: s.effort,
      fast: s.fast,
    };
  }

  private sessionSetTitle(p: SessionSetTitleParams) {
    const s = this.require(p.sessionId);
    s.title = p.title;
    s.titleUserSet = true;
    return { title: s.title };
  }

  private sessionSetHidden(p: SessionSetHiddenParams) {
    const s = this.require(p.sessionId);
    s.hidden = p.hidden;
    return { hidden: s.hidden };
  }

  /* ── subagents + background jobs (#179) ────────────────────────────────── */

  /** The engine's jobs view — what `jobs.list` answers (D-#179: no LilOS
      job table; the engine is the only source). */
  private jobsList(p: JobsListParams) {
    const s = this.require(p.sessionId);
    const now = Date.now();
    return {
      jobs: [...s.jobs.values()].map((j) => ({
        jobId: j.jobId,
        command: j.command,
        status: j.status,
        startedAt: j.startedAt,
        uptimeSeconds: Math.floor(((j.endedAt ?? now) - j.startedAt) / 1000),
        ...(j.endedAt !== undefined ? { endedAt: j.endedAt } : {}),
        ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}),
        ...(j.url ? { url: j.url } : {}),
        ...(j.by ? { by: j.by } : {}),
        ...(j.tail ? { tail: j.tail } : {}),
      })),
    };
  }

  private jobsStop(p: JobsStopParams) {
    const s = this.require(p.sessionId);
    const job = s.jobs.get(p.jobId);
    if (job?.status !== "running") return { stopped: false };
    this.stopJob(s, job, "stopped");
    return { stopped: true };
  }

  private stopJob(
    s: FakeSession,
    job: FakeJob,
    status: Extract<JobStatus, "exited" | "failed" | "stopped">,
  ) {
    if (job.timer) clearInterval(job.timer);
    job.timer = undefined;
    job.status = status;
    if (job.exitCode === undefined)
      job.exitCode = status === "stopped" ? 15 : 0;
    job.endedAt = Date.now();
    this.emit(s, "job.exited", {
      jobId: job.jobId,
      status,
      exitCode: job.exitCode,
      endedAt: job.endedAt,
    });
  }

  /** AC-3: a helper declared as another employee links to their newest live
      session — the row opens that session, never a copy of its turns
      (D-#25). No live session -> no link, the row stays a plain helper. */
  private employeeLink(
    employeeRef: string,
  ): { employeeRef: string; sessionRef: string } | undefined {
    if (!this.agents.has(employeeRef)) return undefined;
    const live = [...this.sessions.values()].filter(
      (x) => x.agent === employeeRef && x.state !== "closed",
    );
    const newest = live.at(-1);
    return newest ? { employeeRef, sessionRef: newest.id } : undefined;
  }

  /** Pump one job's scripted output into job.output, one line per tick, then
      emit job.exited when the script says it ends. */
  private startJobPump(s: FakeSession, job: FakeJob) {
    job.timer = setInterval(() => {
      if (s.state === "closed" || job.status !== "running") {
        if (job.timer) clearInterval(job.timer);
        job.timer = undefined;
        return;
      }
      const line = job.lines.shift();
      if (line !== undefined) {
        job.tail = `${job.tail}${line}\n`.slice(-4000);
        const url = job.url ?? firstLocalUrl(job.tail);
        if (url && !job.url) job.url = url;
        this.emit(s, "job.output", {
          jobId: job.jobId,
          tail: job.tail,
          ...(job.url ? { url: job.url } : {}),
        });
      }
      if (job.lines.length === 0 && job.exitCodeOnDrain !== undefined) {
        const code = job.exitCodeOnDrain;
        job.exitCode = code;
        this.stopJob(s, job, code === 0 ? "exited" : "failed");
      } else if (job.lines.length === 0 && job.timer) {
        /* A server with no more scripted lines stays running — quiet but
           listed by jobs.list until jobs.stop lands. */
        clearInterval(job.timer);
        job.timer = undefined;
      }
    }, this.tick);
  }

  /** Emit the whole subagent arc inside one delegate step: subagent.started,
      its nested tool calls (parentToolCallId), then subagent.completed. */
  private async runSubagents(
    s: FakeSession,
    turnId: string,
    toolCallId: string,
    subs: FakeSubagent[],
  ) {
    for (const sub of subs) {
      if (s.turn?.interrupted) return;
      const subagentId = sub.id ?? `sa-${++s.subCounter}`;
      const employee = sub.employee
        ? this.employeeLink(sub.employee)
        : undefined;
      this.emit(s, "subagent.started", {
        turnId,
        subagentId,
        name: sub.name,
        task: sub.task,
        parentToolCallId: toolCallId,
        startedAt: Date.now(),
        ...(employee ? { employee } : {}),
      });
      for (const ns of sub.steps) {
        const nestedId = `c${++s.toolCounter}`;
        this.emit(s, "tool.started", {
          turnId,
          toolCallId: nestedId,
          tool: ns.tool,
          input: ns.input,
          parentToolCallId: subagentId,
        });
        await this.sleep(s);
        /* #179 AC-2: a helper's write lands in the same checkout — the fake
           materializes its `diff` into s.cwd so Workbench → Changes
           (git.diff) lists it, like a real helper's edit does. */
        if (ns.diff && s.cwd) applyFakeDiffToCwd(s.cwd, ns.diff);
        this.emit(s, "tool.completed", {
          turnId,
          toolCallId: nestedId,
          tool: ns.tool,
          status: "completed",
          output: ns.output,
          diff: ns.diff,
          commit: ns.commit,
          parentToolCallId: subagentId,
        });
      }
      /* #309: an async helper's close lands after the parent's
         turn.completed — finishTurn drains the queue. */
      if (sub.outlivesTurn) {
        s.pendingSubagentClose.push({
          subagentId,
          status: sub.status,
          result: sub.result,
          durationMs: sub.durationMs,
          hold: sub.holdClose,
        });
        continue;
      }
      this.emit(s, "subagent.completed", {
        subagentId,
        status: sub.status,
        result: sub.result,
        durationMs: sub.durationMs,
      });
    }
  }

  // ── the turn loop (ports the prototype's runTurn) ─────────────────────────

  private async runTurn(
    s: FakeSession,
    promptText: string,
    images?: { mimeType: string; sizeBytes: number }[],
    ref?: string,
  ) {
    /* #400: a test's follow-up prompt is the release signal for held async
       helpers — their close lands here, while the session is still idle. */
    this.flushHeldCloses(s);
    // A pick deferred while the previous turn ran lands before the new turn
    // reads model/effort/fast for `turn.started` (#92 AC-4). Every turn path
    // funnels here — `prompt` and steered follow-ups via `pumpSteers`. The
    // fast tier was already applied at pick time — pass it through so the
    // apply can't reset it. If the stashed model no longer applies (it left
    // the catalog), post a note and run the turn on the current model — a
    // failed deferred apply must not jam or fail the prompt (#92 review).
    if (s.pendingPick) {
      const pick = s.pendingPick;
      s.pendingPick = undefined;
      try {
        this.applyPick(s, { ...pick, fast: s.fast });
      } catch {
        this.emit(s, "session.note", {
          text: `Couldn't switch to ${pick.model} — staying on ${s.model ?? "the default model"}.`,
        });
      }
    }
    const turnId = `t${++this.turnCounter}`;
    const script = scriptFor(
      s.agent,
      promptText,
      s.turnCount > 0,
      s.branch,
      this.nextHex,
      "Nuncio-hq/LilOS",
      s.cwd,
      images,
      /* Earlier turns the session still remembers — the recall: probe echoes
         them. The current input is userTurns' last entry on the prompt path;
         for a pumped steer it sits earlier, so drop it by match either way. */
      s.userTurns.filter((_, i) => i !== s.userTurns.lastIndexOf(promptText)),
    );
    s.turn = { turnId, phase: "reasoning", interrupted: false };
    s.turnCount += 1;
    this.emit(s, "turn.started", {
      turnId,
      model: s.model,
      provider: s.provider,
      effort: s.effort,
      fast: s.fast,
      ...(ref ? { ref } : {}),
    });
    this.setState(s, "running");
    this.autoTitle(s, "derived", promptText);
    try {
      /* #400: `LILOS_TURN_HOLD` parks the turn while it reads as running —
         an interrupt (or the session stopping) releases it, so an Esc/Stop
         test never races a short script finishing first. */
      if (/\bLILOS_TURN_HOLD\b/i.test(promptText))
        await new Promise<void>((resolve) => {
          s.holdTurn = resolve;
        });
      // Deterministic failure path (#32): a prompt starting with "fail" ends
      // the turn as a refusal with an error, so failure surfaces are testable.
      // Reasoning is paced over ~2s like a real turn — an instant failure
      // races clients that suppress notifications for the in-view session.
      if (/^\s*fail\b/i.test(promptText)) {
        for (const w of words(
          "Reading the workspace to find the right files. Applying the change on the branch. Rebuilding the project and running the checks. Several checks came back red and the build output looks broken. Retrying once, then giving up. ",
        )) {
          await this.sleep(s);
          this.emit(s, "turn.delta", {
            turnId,
            stream: "reasoning",
            delta: w,
          });
        }
        const error = `engine-fake: scripted failure for "${promptText}"`;
        this.emit(s, "turn.completed", {
          turnId,
          stopReason: "refusal",
          error,
        });
        if (s.state !== "closed") this.setState(s, "idle");
        s.turn = undefined;
        this.pumpSteers(s);
        return { turnId, stopReason: "refusal" as const };
      }
      /* Plans & task lists (#180): `plan:` prompts drive the plan
         capability — `plan: tasks` plays the agent's own working list as
         ticking `plan.updated` snapshots (kind "tasks", never asks),
         `plan: propose` opens a `plan` request (approve → the steps tick;
         reject → nothing runs; change → the next version asks again). */
      const planMode = PLAN_PROMPT.exec(promptText);
      if (planMode) {
        const mode = planMode[1].toLowerCase();
        return await this.runPlanTurn(
          s,
          turnId,
          mode === "propose",
          promptText,
          mode === "slow",
        );
      }
      for (const w of words(script.reasoning)) {
        await this.sleep(s);
        this.emit(s, "turn.delta", { turnId, stream: "reasoning", delta: w });
      }
      s.turn.phase = "tools";
      for (const step of script.steps) {
        this.drainSteers(s, turnId);
        const toolCallId = `c${++s.toolCounter}`;
        this.emit(s, "tool.started", {
          turnId,
          toolCallId,
          tool: step.tool,
          input: step.input,
        });
        const mcpMatch = /^mcp__(\w+)__(\w+)$/.exec(step.tool);
        const command = FakeEngine.stepCommand(step);
        const granted =
          this.alwaysGranted.has(`${s.agent}\n${command}`) ||
          s.sessionGranted.has(command);
        const outcome =
          this.needsApproval(step) && !granted && !mcpMatch
            ? await this.awaitApproval(s, turnId, step)
            : "once";
        if (outcome === "deny" || outcome === "cancel") {
          this.emit(s, "tool.completed", {
            turnId,
            toolCallId,
            tool: step.tool,
            status: outcome === "deny" ? "denied" : "cancelled",
          });
          if (outcome === "cancel") throw new Interrupted();
          return this.finishTurn(s, turnId, "end_turn", script, promptText);
        }
        await this.sleep(s);
        // mcp__<server>__<tool> steps really run: the fake spawns/connects
        // the attached MCP server (lazily) and calls it over the wire.
        if (mcpMatch) {
          try {
            const client = await this.mcpClient(s, mcpMatch[1]);
            step.output = await client.callTool(mcpMatch[2], step.input);
          } catch (e) {
            this.emit(s, "tool.completed", {
              turnId,
              toolCallId,
              tool: step.tool,
              status: "failed",
              output: e instanceof Error ? e.message : String(e),
            });
            continue;
          }
        }
        /* #179: a delegate step emits the subagent arc under its own call id
           before the call itself completes (result = per-helper summary). */
        if (step.subagents?.length && this.capOn("subagents")) {
          await this.runSubagents(s, turnId, toolCallId, step.subagents);
          this.emit(s, "tool.completed", {
            turnId,
            toolCallId,
            tool: step.tool,
            status: "completed",
            output: step.subagents
              .map(
                (x) =>
                  `${x.name}: ${x.status}${x.result ? ` — ${x.result}` : ""}`,
              )
              .join("\n"),
          });
          continue;
        }
        this.emit(s, "tool.completed", {
          turnId,
          toolCallId,
          tool: step.tool,
          status: "completed",
          output: step.output,
          diff: step.diff,
          commit: step.commit,
        });
        /* #179: a job the step left running starts after its call completes —
           job.* events are session-scoped and outlive the turn. */
        if (step.job && this.capOn("background_jobs")) {
          const jobId = step.job.id ?? `job-${++s.jobCounter}`;
          const job: FakeJob = {
            jobId,
            command:
              step.job.command ??
              String(step.input.command ?? "background task"),
            status: "running",
            startedAt: Date.now(),
            by: step.job.by,
            tail: "",
            lines: [...step.job.outputLines],
            exitCodeOnDrain: step.job.exitCode,
          };
          s.jobs.set(jobId, job);
          this.emit(s, "job.started", {
            jobId,
            command: job.command,
            startedAt: job.startedAt,
            ...(job.by ? { by: job.by } : {}),
          });
          this.startJobPump(s, job);
        }
      }
      this.drainSteers(s, turnId);
      s.turn.phase = "text";
      for (const w of words(script.text)) {
        await this.sleep(s);
        this.emit(s, "turn.delta", { turnId, stream: "text", delta: w });
      }
      return this.finishTurn(s, turnId, "end_turn", script, promptText);
    } catch (e) {
      if (!(e instanceof Interrupted)) throw e;
      this.cancelOpen(s);
      // Clear the turn BEFORE turn.completed — observers reacting to the
      // event (e.g. draining a queued prompt) must see the session free.
      s.turn = undefined;
      this.emit(s, "turn.completed", { turnId, stopReason: "cancelled" });
      if (s.state !== "closed") this.setState(s, "idle");
      /* #315: pending steers die with a stopped turn — nothing auto-runs
         after a Stop; the harness parks them in the not-sent tray. */
      s.steers.length = 0;
      return { turnId, stopReason: "cancelled" as const };
    }
  }

  /* ------------------------- #180 plan turns --------------------------- */

  /**
   * A `plan:` turn. `tasks`: emit one snapshot per item — the i-th marks
   * item i in_progress and i-1 completed, with a real tool step between —
   * then a final all-completed snapshot; every snapshot is interruptible
   * (`sleep` throws Interrupted), which is the stopped-card path.
   * `propose`: emit the v1 proposal, open a `plan` request, and loop —
   * change emits the next version and asks again; approve ticks the steps
   * as the run works through them; reject finishes with nothing run.
   */
  private async runPlanTurn(
    s: FakeSession,
    turnId: string,
    proposal: boolean,
    promptText: string,
    /* `plan: slow` = tasks pacing stretched per step so a UI-level stop
       lands inside an item deterministically (#180 AC-2 e2e). */
    slow = false,
  ) {
    const planId = `plan-${turnId}`;
    const reasoning = `Working a ${proposal ? "plan for approval" : "task list"} — steps appear as I go.`;
    for (const w of words(reasoning)) {
      await this.sleep(s);
      this.emit(s, "turn.delta", { turnId, stream: "reasoning", delta: w });
    }
    if (s.turn) s.turn.phase = "tools";

    if (!proposal) {
      const items = PLAN_TASKS;
      let version = 0;
      const snap = (mark: number) =>
        items.map((it, j) => ({
          text: it.text,
          files: it.files,
          status:
            j < mark
              ? ("completed" as const)
              : j === mark
                ? ("in_progress" as const)
                : ("pending" as const),
        }));
      this.emit(s, "plan.updated", {
        turnId,
        planId,
        kind: "tasks",
        version: ++version,
        steps: snap(-1),
      });
      for (let i = 0; i < items.length; i++) {
        this.drainSteers(s, turnId);
        this.emit(s, "plan.updated", {
          turnId,
          planId,
          kind: "tasks",
          version: ++version,
          steps: snap(i),
        });
        const toolCallId = `c${++s.toolCounter}`;
        this.emit(s, "tool.started", {
          turnId,
          toolCallId,
          tool: items[i].tool,
          input: items[i].input,
        });
        const stepTicks = slow ? 60 : 2;
        for (let k = 0; k < stepTicks; k++) await this.sleep(s);
        this.emit(s, "tool.completed", {
          turnId,
          toolCallId,
          tool: items[i].tool,
          status: "completed",
          output: items[i].output,
        });
      }
      this.emit(s, "plan.updated", {
        turnId,
        planId,
        kind: "tasks",
        version: ++version,
        steps: snap(items.length),
      });
      const text = `Worked the list — all ${items.length} items done. Read the client, wired the backoff, and the checks pass.`;
      for (const w of words(text)) {
        await this.sleep(s);
        this.emit(s, "turn.delta", { turnId, stream: "text", delta: w });
      }
      return this.finishTurn(
        s,
        turnId,
        "end_turn",
        { reasoning, steps: [], text },
        promptText,
      );
    }

    /* ── proposal: versions are revisions; the plan request gates each ── */
    const goal = `Reconnect the relay client on its own after a drop — "${promptText.trim()}"`;
    let steps: PlanStep[] = PLAN_PROPOSAL_STEPS.map((x) => ({ ...x }));
    const risks = [...PLAN_PROPOSAL_RISKS];
    let version = 0;
    const emitProposal = () =>
      this.emit(s, "plan.updated", {
        turnId,
        planId,
        kind: "plan",
        version: ++version,
        goal,
        steps,
        risks,
      });
    emitProposal();
    for (;;) {
      const { outcome, answer } = await this.awaitPlanDecision(
        s,
        turnId,
        planId,
      );
      if (outcome === "cancel") throw new Interrupted();
      if (outcome === "reject") {
        const text =
          "Plan rejected — nothing ran. The proposal stays on the card if you change your mind.";
        for (const w of words(text)) {
          await this.sleep(s);
          this.emit(s, "turn.delta", { turnId, stream: "text", delta: w });
        }
        return this.finishTurn(
          s,
          turnId,
          "end_turn",
          { reasoning, steps: [], text },
          promptText,
        );
      }
      if (outcome === "change") {
        /* The answer folds in as a real revision: the tail step moves after
           a new "your change" step, every status resets to pending. */
        const change = (answer ?? "").trim();
        steps = [
          ...steps
            .slice(0, -1)
            .map((x) => ({ ...x, status: "pending" as const })),
          {
            text: `Your change: ${change}`,
            files: ["packages/client-runtime/src/retry-log.ts"],
            status: "pending" as const,
          },
          { ...steps[steps.length - 1], status: "pending" as const },
        ];
        emitProposal();
        continue;
      }
      // approve — run the steps, ticking the snapshot in place (same version).
      for (let i = 0; i < steps.length; i++) {
        this.drainSteers(s, turnId);
        steps = steps.map((x, j) => ({
          ...x,
          status: j === i ? ("in_progress" as const) : x.status,
        }));
        this.emit(s, "plan.updated", {
          turnId,
          planId,
          kind: "plan",
          version,
          goal,
          steps,
          risks,
        });
        const toolCallId = `c${++s.toolCounter}`;
        this.emit(s, "tool.started", {
          turnId,
          toolCallId,
          tool: "patch",
          input: {
            path:
              steps[i].files?.[0] ?? "packages/client-runtime/src/retry-log.ts",
          },
        });
        await this.sleep(s);
        this.emit(s, "tool.completed", {
          turnId,
          toolCallId,
          tool: "patch",
          status: "completed",
          output: "step done",
        });
        steps = steps.map((x, j) => ({
          ...x,
          status: j <= i ? ("completed" as const) : x.status,
        }));
        this.emit(s, "plan.updated", {
          turnId,
          planId,
          kind: "plan",
          version,
          goal,
          steps,
          risks,
        });
      }
      const text = `Plan v${version} ran to the end — ${steps.length} steps done. The reconnect backoff is wired, resume replays from the last seq, and tests pass.`;
      for (const w of words(text)) {
        await this.sleep(s);
        this.emit(s, "turn.delta", { turnId, stream: "text", delta: w });
      }
      return this.finishTurn(
        s,
        turnId,
        "end_turn",
        { reasoning, steps: [], text },
        promptText,
      );
    }
  }

  /** The `plan` ask behind a proposal — same lifecycle as awaitApproval. */
  private async awaitPlanDecision(
    s: FakeSession,
    turnId: string,
    planId: string,
  ): Promise<{ outcome: ApprovalOutcome; answer?: string }> {
    const requestId = `r${++s.requestCounter}`;
    const request = { kind: "plan" as const, planId };
    const promise = new Promise<{ outcome: ApprovalOutcome; answer?: string }>(
      (resolve) => {
        s.openRequests.set(requestId, {
          turnId,
          requestId,
          request,
          seq: s.seq + 1,
          resolve,
        });
      },
    );
    this.emit(s, "request.opened", { turnId, requestId, request });
    const t = s.turn;
    if (t) t.phase = "waiting";
    this.setState(s, "waiting");
    const res = await promise;
    if (s.turn && !s.turn.interrupted) {
      s.turn.phase = "tools";
      this.setState(s, "running");
    }
    return res;
  }

  private finishTurn(
    s: FakeSession,
    turnId: string,
    stopReason: "end_turn" | "cancelled",
    script: FakeScript,
    promptText: string,
  ) {
    const input = s.usage.input + 9000 + promptText.length * 4;
    const output = s.usage.output + Math.floor(script.text.length / 4);
    s.usage = {
      input,
      output,
      reasoning: s.usage.reasoning + Math.floor(script.reasoning.length / 4),
      cache: s.usage.cache + 6000,
      /* Live occupancy (#415): the fake runs one call per turn, so the whole
         billed sum stays in context — clamped to the resolved window like a
         real compressor keeps it. */
      context: s.usage.contextWindow
        ? Math.min(input + output, s.usage.contextWindow)
        : input + output,
      /* The resolved window rides the session across turns (#294). */
      ...(s.usage.contextWindow
        ? { contextWindow: s.usage.contextWindow }
        : {}),
    };
    // Clear the turn BEFORE turn.completed — observers reacting to the
    // event (e.g. draining a queued prompt) must see the session free.
    s.turn = undefined;
    this.emit(s, "turn.completed", { turnId, stopReason, usage: s.usage });
    if (s.state !== "closed") this.setState(s, "idle");
    this.autoTitle(s, "llm", promptText);
    // A steer that never hit a boundary becomes the next turn's input — never
    // lost. Except on an interrupt (#315): Stop discards pending steers so
    // nothing auto-runs after it — the harness parks them in the not-sent
    // tray instead.
    if (stopReason === "cancelled") s.steers.length = 0;
    else this.pumpSteers(s);
    /* #309: async helpers close a tick after the turn — their frames stamp
       no turnId, so a client must key them session-wide, not per-turn. */
    if (s.pendingSubagentClose.length) void this.drainSubagentCloses(s);
    /* #308: a `leg:` script arms an engine-initiated follow-up — minted
       after the settle so observers see it open past turn end. */
    if (script.leg) void this.runLeg(s, script.leg);
    return { turnId, stopReason, usage: s.usage };
  }

  /* #308: an agent-initiated leg — the engine's own follow-up turn opened
     past turn end (queued-steer drain / result delivery): its own minted
     id, initiatedBy:"agent", no ref. A steer mid-leg queues (never lands
     inside it) and drains as the next user turn. */
  private async runLeg(s: FakeSession, text: string) {
    await this.sleep(s);
    if (s.turn || !this.isOpen(s)) return;
    const turnId = `t${++this.turnCounter}`;
    s.turn = { turnId, phase: "reasoning", interrupted: false };
    s.turnCount += 1;
    this.emit(s, "turn.started", {
      turnId,
      model: s.model,
      provider: s.provider,
      effort: s.effort,
      fast: s.fast,
      initiatedBy: "agent",
    });
    this.setState(s, "running");
    for (const w of words(
      "Wrapping the background run and packaging the result for delivery. ",
    )) {
      await this.sleep(s);
      if (!s.turn || s.turn.interrupted) return this.legStopped(s, turnId);
      this.emit(s, "turn.delta", {
        turnId,
        stream: "reasoning",
        delta: w,
      });
    }
    /* A couple of open ticks: a mid-leg steer has a window to queue. */
    await this.sleep(s);
    if (!s.turn || s.turn.interrupted) return this.legStopped(s, turnId);
    await this.sleep(s);
    if (!s.turn || s.turn.interrupted) return this.legStopped(s, turnId);
    s.turn.phase = "text";
    this.emit(s, "turn.delta", { turnId, stream: "text", delta: text });
    s.turn = undefined;
    this.emit(s, "turn.completed", { turnId, stopReason: "end_turn" });
    if (this.isOpen(s)) this.setState(s, "idle");
    this.pumpSteers(s);
  }

  private legStopped(s: FakeSession, turnId: string) {
    s.turn = undefined;
    this.emit(s, "turn.completed", { turnId, stopReason: "cancelled" });
    if (this.isOpen(s)) this.setState(s, "idle");
    /* #315: pending steers die with a stopped turn — nothing auto-runs
       after a Stop; the harness parks them in the not-sent tray. */
    s.steers.length = 0;
  }

  /* Read through a method so the check stays honest after a leg's own
     `state === "closed"` guard narrows `s.state` for the typechecker. */
  private isOpen(s: FakeSession) {
    return s.state !== "closed";
  }

  /* #137 AC-5: two-stage titling — a derived title (verbatim first line,
     capped at 48 chars) as the first turn opens, then an llm title as it
     settles. First turn only; a user title (session.setTitle) suppresses
     both stages. */
  private autoTitle(
    s: FakeSession,
    stage: "derived" | "llm",
    promptText: string,
  ): void {
    if (!this.capOn("session_meta") || s.titleUserSet || s.turnCount !== 1)
      return;
    const title =
      stage === "derived" ? derivedTitle(promptText) : llmTitle(promptText);
    if (!title) return;
    s.title = title;
    this.emit(s, "session.titled", { title, source: stage });
  }

  /** If the session is idle and steers are queued, the next one becomes a turn. */
  private pumpSteers(s: FakeSession) {
    if (!s.turn && s.state !== "closed" && s.steers.length) {
      const next = s.steers.shift();
      if (next !== undefined)
        void this.runTurn(s, next.text, undefined, next.ref);
    }
  }

  /** #309: async helpers' closes, one tick after their parent's turn ended
     — the frames land while the session idles, carrying no turnId (the
     live-capture shape: turn.completed … subagent.completed ~18s later). */
  private async drainSubagentCloses(s: FakeSession) {
    await this.sleep(s);
    /* #400: held closes stay parked — only the next turn intake releases
       them (flushHeldCloses), so a test controls the window. */
    const closing = s.pendingSubagentClose.filter((c) => !c.hold);
    s.pendingSubagentClose = s.pendingSubagentClose.filter((c) => c.hold);
    for (const c of closing) {
      if (s.state === "closed") return;
      this.emit(s, "subagent.completed", {
        subagentId: c.subagentId,
        status: c.status,
        result: c.result,
        durationMs: c.durationMs,
      });
    }
  }

  /** #400: a held async-helper close (LILOS_DELEGATE_ASYNC_HOLD) flushes
     when the next turn intake arrives — the test's follow-up prompt is the
     release signal. Emitted while the session is still idle, before
     turn.started; a closed session drops them like the tick drain. */
  private flushHeldCloses(s: FakeSession) {
    if (s.state === "closed") return;
    const held = s.pendingSubagentClose.filter((c) => c.hold);
    s.pendingSubagentClose = s.pendingSubagentClose.filter((c) => !c.hold);
    for (const c of held)
      this.emit(s, "subagent.completed", {
        subagentId: c.subagentId,
        status: c.status,
        result: c.result,
        durationMs: c.durationMs,
      });
  }

  private drainSteers(s: FakeSession, turnId: string) {
    for (const { text } of s.steers.splice(0))
      this.emit(s, "turn.steered", { turnId, text });
  }

  private async mcpClient(s: FakeSession, name: string): Promise<McpClient> {
    const existing = s.mcpClients.get(name);
    if (existing) return existing;
    const spec = (s.mcpServers as { name?: string; type?: string }[]).find(
      (x) => x.name === name,
    );
    if (!spec) throw new Error(`session has no mcp server '${name}'`);
    const client =
      spec.type === "http"
        ? await startMcpHttp(spec as never)
        : await startMcpServer(spec as never);
    s.mcpClients.set(name, client);
    return client;
  }

  /** The command string a step's approval card carries — the grant key body. */
  private static stepCommand(step: FakeStep): string {
    return typeof step.input.command === "string"
      ? step.input.command
      : `${step.tool} ${JSON.stringify(step.input)}`;
  }

  private async awaitApproval(
    s: FakeSession,
    turnId: string,
    step: FakeStep,
  ): Promise<ApprovalOutcome> {
    const requestId = `r${++s.requestCounter}`;
    const command = FakeEngine.stepCommand(step);
    const request = {
      kind: "approval" as const,
      command,
      description: `${step.tool} wants to run: ${command}`,
      options: ["once", "session", "always", "deny"] as ApprovalOption[],
    };
    const promise = new Promise<{ outcome: ApprovalOutcome; answer?: string }>(
      (resolve) => {
        s.openRequests.set(requestId, {
          turnId,
          requestId,
          request,
          seq: s.seq + 1,
          resolve,
        });
      },
    );
    this.emit(s, "request.opened", { turnId, requestId, request });
    const t = s.turn;
    if (t) t.phase = "waiting";
    this.setState(s, "waiting");
    const { outcome } = await promise;
    if (s.turn && !s.turn.interrupted) {
      s.turn.phase = "tools";
      this.setState(s, "running");
    }
    return outcome;
  }

  private cancelOpen(s: FakeSession) {
    for (const [requestId, ask] of s.openRequests) {
      this.emit(s, "request.resolved", {
        requestId,
        outcome: "cancel" as const,
      });
      ask.resolve({ outcome: "cancel" });
    }
    s.openRequests.clear();
  }

  private snapshot(s: FakeSession) {
    return {
      sessionId: s.id,
      state: s.state,
      turn: s.turn ? { turnId: s.turn.turnId, phase: s.turn.phase } : undefined,
      usage: s.usage,
      model: s.model,
      provider: s.provider,
      effort: s.effort,
      fast: s.fast,
      ...(s.title ? { title: s.title } : {}),
    };
  }

  private needsApproval(step: FakeStep): boolean {
    if (step.tool === "patch" || step.tool === "write_file") return true;
    if (step.tool === "terminal" && typeof step.input.command === "string") {
      return /^(git\s+(commit|push|worktree)|gh\s)/.test(step.input.command);
    }
    return false;
  }

  private async sleep(s: FakeSession): Promise<void> {
    await new Promise((r) => setTimeout(r, this.tick));
    if (s.turn?.interrupted) throw new Interrupted();
  }

  private setState(s: FakeSession, state: SessionState) {
    if (s.state === state) return;
    s.state = state;
    this.emit(s, "session.state", { state });
  }

  private emit(
    s: FakeSession,
    type: EngineEventType,
    payload: EngineEvent["payload"],
  ) {
    const event = {
      seq: ++s.seq,
      sessionId: s.id,
      type,
      payload,
    } as EngineEvent;
    s.log.push(event);
    for (const fn of this.listeners) fn(event);
  }

  private require(sessionId: string): FakeSession {
    const s = this.sessions.get(sessionId);
    if (!s)
      throw new RpcError(
        RPC_ERRORS.SESSION_NOT_FOUND,
        `no session ${sessionId}`,
      );
    return s;
  }

  private nextHex = () => (++this.hexCounter).toString(16).padStart(7, "0");
}

class Interrupted extends Error {}

/** #179 AC-2: write a scripted diff into the session checkout — the fake's
    `+` lines become the file's content, so git.diff picks it up exactly like
    a real helper's `write_file`/`patch` does. */
function applyFakeDiffToCwd(cwd: string, diff: FileDiff) {
  if (diff.status === "deleted") return;
  const path = join(cwd, diff.path);
  const body = (diff.patch ?? "")
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body.endsWith("\n") || !body ? body : `${body}\n`);
  } catch {
    /* An unwritable cwd must not fail the turn — the step still reports. */
  }
}

/** Instant-title rule: first line, whitespace-collapsed, ≤48 chars. */
const MAX_DERIVED_TITLE_CHARS = 48;

function derivedTitle(promptText: string): string {
  const clean = promptText.split("\n")[0].replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_DERIVED_TITLE_CHARS) return clean;
  return `${clean.slice(0, MAX_DERIVED_TITLE_CHARS - 1).trimEnd()}…`;
}

/** Deterministic stand-in for the small-model rewrite: Title Case the
    first clause (up to 8 words), so it always differs from `derived`. */
function llmTitle(promptText: string): string {
  const clause = (promptText.split(/[:;.!\n]/)[0] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return clause
    .split(" ")
    .slice(0, 8)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

const words = (t: string) => t.split(/(?<=\s)/);

/* ── #180 plan scripts ──────────────────────────────────────────────────
   `plan: tasks` = the agent's own working list, ticks live and never asks.
   `plan: propose` = a plan gated by a `plan` request —
   approve / reject / change (the next version asks again). */

const PLAN_PROMPT = /^\s*plan:\s*(propose|tasks|slow)\b/i;

const PLAN_TASKS: {
  text: string;
  files: string[];
  tool: string;
  input: Record<string, unknown>;
  output: string;
}[] = [
  {
    text: "Read the relay client and its reconnect path",
    files: ["packages/client-runtime/src/client.ts"],
    tool: "read_file",
    input: { path: "packages/client-runtime/src/client.ts" },
    output: "96 lines",
  },
  {
    text: "Add the reconnect backoff and wire the socket",
    files: ["packages/client-runtime/src/socket.ts"],
    tool: "patch",
    input: { path: "packages/client-runtime/src/socket.ts" },
    output: "reconnect loop uses backoff()",
  },
  {
    text: "Resume from the last seq and run the checks",
    files: ["packages/client-runtime/src/sync.ts"],
    tool: "terminal",
    input: { command: "bun test packages/client-runtime" },
    output: "3 pass · 0 fail",
  },
];

const PLAN_PROPOSAL_STEPS = [
  {
    text: "Add a backoff helper (250ms → 30s, with jitter)",
    files: ["packages/client-runtime/src/backoff.ts"],
    status: "pending" as const,
  },
  {
    text: "Use it in the socket's reconnect loop",
    files: ["packages/client-runtime/src/socket.ts"],
    status: "pending" as const,
  },
  {
    text: "Resume from the last seq after reconnect",
    files: ["packages/client-runtime/src/sync.ts"],
    status: "pending" as const,
  },
  {
    text: "Tests: drop → retry → resume",
    files: ["packages/client-runtime/test/reconnect.test.ts"],
    status: "pending" as const,
  },
];

const PLAN_PROPOSAL_RISKS = [
  "Reconnect storms if many clients drop at once — jitter added to the backoff.",
  "Touches the client used by web and mobile — both need a reload test.",
];

/** Runtime-neutral randomness (no process APIs — packages stay portable). */
const randomNamespace = () => crypto.randomUUID().slice(0, 8);
