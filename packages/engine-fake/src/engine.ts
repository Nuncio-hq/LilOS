import {
  type AgentDescriptor,
  type AgentsCreateParams,
  type AgentsDescribeParams,
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
  type PromptParams,
  type RequestRespondParams,
  RPC_ERRORS,
  type SessionSetModelParams,
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
  mcpServers: unknown[];
  /** Spawned lazily on first mcp__<server>__<tool> step — a session that never drives surfaces costs zero children. */
  mcpClients: Map<string, McpClient>;
  branch: string;
  seq: number;
  log: EngineEvent[];
  state: SessionState;
  openRequests: Map<string, PendingAsk>;
  /** True once an approval was answered "always" — fake remembers for the session. */
  alwaysApproved: boolean;
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
      case "models.list":
        return this.modelsList();
      case "session.setModel":
        return this.sessionSetModel(parsed.data as SessionSetModelParams);
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
          "List, describe, and create engine profiles; sessions start as one.",
        methods: ["agents.list", "agents.describe", "agents.create"],
      },
      ...(this.capOn("models")
        ? [
            {
              id: "models",
              name: "Model picker",
              description:
                "List selectable models and pin a session's model for its next turn.",
              methods: ["models.list", "session.setModel"],
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
    const s: FakeSession = {
      ref: id,
      id,
      agent: p.agent,
      cwd: p.cwd,
      model: p.model ?? spec.model,
      mcpServers: p.mcpServers ?? [],
      mcpClients: new Map(),
      branch: `work/${p.agent}-${id}`,
      seq: 0,
      log: [],
      state: "idle",
      openRequests: new Map(),
      alwaysApproved: false,
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
    return this.runTurn(s, text, images);
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
    if (p.outcome === "answer" && p.answer === undefined) {
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        "outcome answer needs an answer field",
      );
    }
    if (ask.request.kind === "approval" && p.outcome === "always")
      s.alwaysApproved = true;
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

  private modelsList() {
    return {
      models: MODEL_CATALOG.map((m) => ({ ...m })),
      default: DEFAULT_MODEL,
    };
  }

  private sessionSetModel(p: SessionSetModelParams) {
    const s = this.require(p.sessionId);
    if (s.state === "closed")
      throw new RpcError(RPC_ERRORS.INVALID_STATE, `session ${s.id} is closed`);
    if (!MODEL_CATALOG.some((m) => m.id === p.model))
      throw new RpcError(
        RPC_ERRORS.MODEL_NOT_FOUND,
        `no model ${p.model} — see models.list`,
      );
    s.model = p.model;
    return { model: s.model };
  }

  // ── the turn loop (ports the prototype's runTurn) ─────────────────────────

  private async runTurn(
    s: FakeSession,
    promptText: string,
    images?: { mimeType: string; sizeBytes: number }[],
  ) {
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
    this.emit(s, "turn.started", { turnId, model: s.model });
    this.setState(s, "running");
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
        const outcome =
          this.needsApproval(step) && !s.alwaysApproved && !mcpMatch
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
      this.emit(s, "turn.completed", { turnId, stopReason: "cancelled" });
      if (s.state !== "closed") this.setState(s, "idle");
      s.turn = undefined;
      this.pumpSteers(s);
      return { turnId, stopReason: "cancelled" as const };
    }
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
    this.emit(s, "turn.completed", { turnId, stopReason, usage: s.usage });
    if (s.state !== "closed") this.setState(s, "idle");
    s.turn = undefined;
    // A steer that never hit a boundary becomes the next turn's input — never lost.
    this.pumpSteers(s);
    return { turnId, stopReason, usage: s.usage };
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

  private async awaitApproval(
    s: FakeSession,
    turnId: string,
    step: FakeStep,
  ): Promise<ApprovalOutcome> {
    const requestId = `r${++s.requestCounter}`;
    const command =
      typeof step.input.command === "string"
        ? step.input.command
        : `${step.tool} ${JSON.stringify(step.input)}`;
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

const words = (t: string) => t.split(/(?<=\s)/);

/** Runtime-neutral randomness (no process APIs — packages stay portable). */
const randomNamespace = () => crypto.randomUUID().slice(0, 8);
