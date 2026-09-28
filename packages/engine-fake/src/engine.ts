import {
  type AgentDescriptor,
  type AgentsCreateParams,
  type AgentsDescribeParams,
  type AgentsUpdateParams,
  type ApprovalOption,
  type ApprovalOutcome,
  type Capability,
  type ContentBlock,
  ENGINE_METHODS,
  ENGINE_PROTOCOL,
  type EngineEvent,
  type EngineEventType,
  type EventsSinceParams,
  IMAGE_PROMPT_CAPABILITY,
  type InterruptParams,
  type KnownCapability,
  type ModelsListParams,
  PLAN_CAPABILITY,
  type PlanStep,
  type PromptParams,
  type RequestRespondParams,
  RPC_ERRORS,
  SESSION_META_CAPABILITY,
  type SessionSetHiddenParams,
  type SessionSetModelParams,
  type SessionSetTitleParams,
  type SessionStartParams,
  type SessionState,
  type SessionSteerParams,
  type SessionStopParams,
  STEER_CAPABILITY,
  type Usage,
} from "@lilos/contracts/engine";
import {
  DEFAULT_MODEL,
  type FakeAgent,
  MODEL_CATALOG,
  REFRESH_MODEL,
  SEED_AGENTS,
} from "./catalog.js";
import { type McpClient, startMcpServer } from "./mcp.js";
import { type FakeScript, type FakeStep, scriptFor } from "./script.js";

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
  usage: Usage;
  steers: string[];
  turn?: FakeTurn;
  turnCount: number;
  toolCounter: number;
  requestCounter: number;
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
  /** A capability is on unless the options explicitly set it false. */
  private capOn(cap: string): boolean {
    return this.caps[cap as KnownCapability] !== false;
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
        description: "Accepts stdio MCP servers on session.start (ACP shape).",
        detail: { transports: ["stdio"] },
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
      ...(this.capOn("plan") ? [PLAN_CAPABILITY] : []),
    ];
    return {
      name: "engine-fake",
      version: "0.0.0",
      protocol: ENGINE_PROTOCOL,
      capabilities,
    };
  }

  private sessionStart(p: SessionStartParams) {
    if ((p.mcpServers ?? []).some((s) => "type" in s)) {
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        "engine-fake accepts stdio mcpServers only",
      );
    }
    const spec = this.agents.get(p.agent);
    if (!spec)
      throw new RpcError(
        RPC_ERRORS.AGENT_NOT_FOUND,
        `no agent ${p.agent} — hire it via agents.create first`,
      );
    const id = `s-${this.sessionNamespace}-${++this.sessionCounter}`;
    const picked = MODEL_CATALOG.find((m) => m.id === (p.model ?? spec.model));
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
      usage: { input: 0, output: 0, reasoning: 0, cache: 0 },
      steers: [],
      turnCount: 0,
      toolCounter: 0,
      requestCounter: 0,
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
    return this.runTurn(s, text, images, p.ref);
  }

  private interrupt(p: InterruptParams) {
    const s = this.require(p.sessionId);
    if (!s.turn) return { interrupted: false };
    s.turn.interrupted = true;
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
        "an approval takes once/always/deny/cancel, not answer",
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
    s.openRequests.delete(p.requestId);
    this.emit(s, "request.resolved", {
      requestId: p.requestId,
      outcome: p.outcome,
      answer: p.answer,
    });
    ask.resolve({ outcome: p.outcome, answer: p.answer });
    return { accepted: true as const };
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
    for (const ask of s.openRequests.values())
      ask.resolve({ outcome: "cancel" });
    for (const c of s.mcpClients.values()) c.close();
    s.mcpClients.clear();
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
    s.steers.push(p.text);
    return { status: "steered" as const };
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
    if (p.model !== undefined && !MODEL_CATALOG.some((m) => m.id === p.model))
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
    if (
      p.model !== undefined &&
      ![...MODEL_CATALOG, REFRESH_MODEL].some((m) => m.id === p.model)
    )
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
       testable (#92 AC-6). */
    const catalog = p.refresh
      ? [...MODEL_CATALOG, REFRESH_MODEL]
      : MODEL_CATALOG;
    return {
      models: catalog.map((m) => ({ ...m })),
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
       "/" (issue #92 AC-8); `provider` is a separate field end to end. */
    const m = [...MODEL_CATALOG, REFRESH_MODEL].find((x) => x.id === p.model);
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
    const m = [...MODEL_CATALOG, REFRESH_MODEL].find((x) => x.id === p.model);
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

  // ── the turn loop (ports the prototype's runTurn) ─────────────────────────

  private async runTurn(
    s: FakeSession,
    promptText: string,
    images?: { mimeType: string; sizeBytes: number }[],
    ref?: string,
  ) {
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
        return await this.runPlanTurn(
          s,
          turnId,
          planMode[1].toLowerCase() === "propose",
          promptText,
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
        const granted = this.alwaysGranted.has(
          `${s.agent}\n${FakeEngine.stepCommand(step)}`,
        );
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
        // mcp__<server>__<tool> steps really run: the fake spawns the attached
        // stdio MCP server (lazily) and calls it over the wire.
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
        this.emit(s, "tool.completed", {
          turnId,
          toolCallId,
          tool: step.tool,
          status: "completed",
          output: step.output,
          diff: step.diff,
          commit: step.commit,
        });
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
      this.pumpSteers(s);
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
        await this.sleep(s);
        await this.sleep(s);
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
    s.usage = {
      input: s.usage.input + 9000 + promptText.length * 4,
      output: s.usage.output + Math.floor(script.text.length / 4),
      reasoning: s.usage.reasoning + Math.floor(script.reasoning.length / 4),
      cache: s.usage.cache + 6000,
    };
    // Clear the turn BEFORE turn.completed — observers reacting to the
    // event (e.g. draining a queued prompt) must see the session free.
    s.turn = undefined;
    this.emit(s, "turn.completed", { turnId, stopReason, usage: s.usage });
    if (s.state !== "closed") this.setState(s, "idle");
    this.autoTitle(s, "llm", promptText);
    // A steer that never hit a boundary becomes the next turn's input — never lost.
    this.pumpSteers(s);
    return { turnId, stopReason, usage: s.usage };
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
      if (next !== undefined) void this.runTurn(s, next);
    }
  }

  private drainSteers(s: FakeSession, turnId: string) {
    for (const text of s.steers.splice(0))
      this.emit(s, "turn.steered", { turnId, text });
  }

  private async mcpClient(s: FakeSession, name: string): Promise<McpClient> {
    const existing = s.mcpClients.get(name);
    if (existing) return existing;
    const spec = (s.mcpServers as { name?: string }[]).find(
      (x) => x.name === name,
    );
    if (!spec || "type" in spec)
      throw new Error(`session has no stdio mcp server '${name}'`);
    const client = await startMcpServer(spec as never);
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
      options: ["once", "always", "deny"] as ApprovalOption[],
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

const PLAN_PROMPT = /^\s*plan:\s*(propose|tasks)\b/i;

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
