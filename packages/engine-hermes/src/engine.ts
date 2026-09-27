import {
  type AgentsCreateParams,
  type AgentsDescribeParams,
  type ApprovalOutcome,
  type Capability,
  type ContentBlock,
  ENGINE_METHODS,
  ENGINE_PROTOCOL,
  type EngineEvent,
  type EngineRequest,
  type EventsSinceParams,
  type InterruptParams,
  type ModelsListParams,
  type PromptParams,
  type RequestRespondParams,
  RPC_ERRORS,
  type SessionSetHiddenParams,
  type SessionSetModelParams,
  type SessionSetTitleParams,
  type SessionStartParams,
  type SessionSteerParams,
  type SessionStopParams,
  type StopReason,
  type Usage,
} from "@lilos/contracts/engine";
import { AcpDriver, type AcpOptions } from "./acp.js";
import {
  createAgent,
  describeAgent,
  listAgents,
  listModels,
  requireAgent,
  setSessionModel,
} from "./catalog.js";
import { RpcError } from "./errors.js";
import type { GatewayLike } from "./gateway.js";
import {
  approvalOutcomeToResult,
  mapApprovalParams,
  mapClarifyParams,
  mapStopReason,
  mapToolStatus,
  mapUsage,
} from "./mapping.js";
import {
  cancelAllAsks,
  cancelAsk,
  type PendingAsk,
  requestNotFound,
  resolveOutcomeValid,
  Session,
} from "./session.js";

/**
 * Oldest Hermes build the engine is verified against (#50 AC-4): v0.21.5 on
 * the 2026.9.24 release line — the build Oscar's Mac runs. Newer optional
 * `session.create` fields are negotiated per gateway, so a build between the
 * minimum and current keeps working; anything older is unverified.
 */
export const MIN_HERMES_VERSION = "v0.21.5 (2026.9.24)";

/**
 * `session.create` params a gateway may not declare: its Params models are
 * `extra="forbid"` and answer JSON-RPC `4000` "invalid params for
 * session.create: <field>: Extra inputs are not permitted". Dropping these
 * degrades metadata/precedence hints, not session semantics. Fields that
 * carry meaning — `profile`, `cwd`, `model`, `provider` — are never dropped:
 * a gateway refusing them fails the start instead of running a wrong one.
 */
const DROPPABLE_CREATE_FIELDS = new Set([
  "cwd_explicit",
  "source",
  "title",
  "close_on_disconnect",
]);
const EXTRA_FORBIDDEN_RE =
  /invalid params for [\w.]+: ([\w.]+): Extra inputs are not permitted/i;

/** The field a Hermes extra_forbidden rejection names (4000 or -32602). */
function extraForbiddenField(e: unknown): string | undefined {
  if (!(e instanceof RpcError)) return undefined;
  if (e.code !== 4000 && e.code !== RPC_ERRORS.INVALID_PARAMS) return undefined;
  return EXTRA_FORBIDDEN_RE.exec(e.message)?.[1];
}

export interface HermesEngineOptions {
  /** Connected `hermes serve` gateway (ws path). */
  gateway: GatewayLike;
  /** Provider override passed to `session.create` (e.g. "custom:stub"). */
  provider?: string;
  /** Model override passed to `session.create` when the request omits one. */
  model?: string;
  /** How to spawn `hermes acp` for sessions carrying mcpServers (#23 verdict). */
  acp?: AcpOptions;
  version?: string;
}

/**
 * `engine-hermes`: the LilOS engine protocol over a live Hermes backend.
 * WS sessions go through `hermes serve` `/api/ws`; sessions carrying
 * `mcpServers` spawn `hermes acp` per #23 (the WS `session.create` has no
 * `mcp_servers` field — verified on spike/23-mcp-attach).
 */
export class HermesEngine {
  private sessions = new Map<string, Session>();
  private byRuntimeSid = new Map<string, Session>();
  private listeners = new Set<(e: EngineEvent) => void>();
  private sessionCounter = 0;
  private turnCounter = 0;
  private acpDrivers = new Map<string, AcpDriver>();
  /** #50 AC-1 — `session.create` fields this gateway already refused. */
  private droppedCreateFields = new Set<string>();
  /** Build the gateway advertised in `session.create`'s `info` (#50 AC-4). */
  private gatewayInfo: { version?: string; releaseDate?: string } = {};

  constructor(private opts: HermesEngineOptions) {
    opts.gateway.onEvent((e) => this.onGatewayEvent(e));
    opts.gateway.onRequest((r) => this.onServerRequest(r));
    opts.gateway.onCancel((c) => this.onServerCancel(c));
  }

  onEvent(fn: (e: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emitAll(e: EngineEvent) {
    for (const fn of this.listeners) fn(e);
  }

  async dispatch(method: string, params: unknown): Promise<unknown> {
    const contract = ENGINE_METHODS[method];
    if (!contract)
      throw new RpcError(
        RPC_ERRORS.METHOD_NOT_FOUND,
        `unknown method: ${method}`,
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
        return listAgents(this.opts.gateway);
      case "agents.describe":
        return describeAgent(
          this.opts.gateway,
          (parsed.data as AgentsDescribeParams).id,
        );
      case "agents.create":
        return createAgent(
          this.opts.gateway,
          parsed.data as AgentsCreateParams,
        );
      case "models.list":
        return listModels(this.opts.gateway, {
          refresh: (parsed.data as ModelsListParams).refresh,
        });
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
      {
        id: "steer",
        name: "Session steer",
        description:
          "Mid-turn text is queued as a correction (hermes `session.steer`) or a queued prompt on ACP sessions.",
        methods: ["session.steer"],
      },
      {
        id: "image_prompt",
        name: "Image prompts",
        description:
          "Image blocks attach via `image.attach_bytes` (WS) or native ACP blocks.",
        methods: ["prompt"],
      },
      {
        id: "usage",
        name: "Usage accounting",
        description: "turn.completed carries Hermes token usage.",
      },
      {
        id: "agents",
        name: "Hireable agents",
        description:
          "Agents are Hermes profiles: agents.list/describe/create map to profiles.*; session.start runs under the profile.",
        methods: ["agents.list", "agents.describe", "agents.create"],
      },
      {
        id: "models",
        name: "Model picker",
        description:
          "models.list flattens model.options (all providers, refreshable); session.setModel runs config.set model/fast — session-scoped, next turn picks it up.",
        methods: ["models.list", "session.setModel"],
        /* #92: Refresh button / effort slider / ⚡Fast render only on engines
           that declare them here. */
        detail: { refreshable: true, effort: true, fast: true },
      },
      {
        id: "session_meta",
        name: "Session metadata",
        description:
          "session.setTitle/setHidden map to hermes session.title / session.set_hidden (live id first, else stored key).",
        methods: ["session.setTitle", "session.setHidden"],
      },
    ];
    if (this.opts.acp) {
      capabilities.push({
        id: "mcp_servers",
        name: "MCP servers",
        description:
          "session.start mcpServers ride `hermes acp` session/new (#23 verdict); WS path refuses them.",
        detail: { transports: ["stdio", "http", "sse"], transport: "acp" },
        methods: ["session.start"],
      });
    }
    capabilities.push({
      id: "hermes_gateway",
      name: "Hermes gateway",
      description: `Requires Hermes ${MIN_HERMES_VERSION} or newer; newer session.create fields are negotiated per gateway.`,
      detail: {
        minVersion: MIN_HERMES_VERSION,
        ...(this.gatewayInfo.version
          ? { gatewayVersion: this.gatewayInfo.version }
          : {}),
        ...(this.gatewayInfo.releaseDate
          ? { releaseDate: this.gatewayInfo.releaseDate }
          : {}),
        droppedCreateFields: [...this.droppedCreateFields],
      },
    });
    return {
      name: "engine-hermes",
      version: this.opts.version ?? "0.0.0",
      protocol: ENGINE_PROTOCOL,
      capabilities,
    };
  }

  private async sessionStart(p: SessionStartParams) {
    const id = `s${++this.sessionCounter}`;
    const mcp = p.mcpServers ?? [];
    // The LilOS `agent` is a Hermes profile name: refuse unknown ones up front
    // (AGENT_NOT_FOUND) and run the session under that profile.
    await requireAgent(this.opts.gateway, p.agent);
    /* #92 AC-8: `p.model` is an opaque id — it may itself contain `/`
       (aggregator ids like `devin/claude-opus-5`); it is never split into a
       `provider/model` pair. `p.provider` is a separate wire field. */
    const model = p.model ?? this.opts.model;
    const provider = p.provider ?? this.opts.provider;
    const effort = p.effort;
    const fast = p.fast;
    if (mcp.length === 0) {
      const r = (await this.createSessionCompat({
        profile: p.agent,
        title: `${p.agent} · LilOS`,
        cwd: p.cwd,
        cwd_explicit: true,
        source: "lilos",
        close_on_disconnect: true,
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
        ...(effort ? { reasoning_effort: effort } : {}),
        ...(fast !== undefined ? { fast } : {}),
      })) as { session_id?: unknown; stored_session_id?: unknown };
      if (typeof r.session_id !== "string" || !r.session_id)
        throw new RpcError(
          RPC_ERRORS.INTERNAL_ERROR,
          "session.create returned no session_id",
        );
      const s = new Session(
        id,
        p.agent,
        p.cwd,
        // effective model (what session.create got), not the bare request —
        // the ambient default still answers `turn.started.model` (#30).
        model,
        mcp,
        provider,
        effort,
        fast,
        "ws",
        r.session_id,
        typeof r.stored_session_id === "string" ? r.stored_session_id : "",
        (e) => this.emitAll(e),
      );
      this.sessions.set(id, s);
      this.byRuntimeSid.set(s.runtimeSid, s);
      s.emit("session.started", {
        agent: p.agent,
        cwd: p.cwd,
        ...(s.model ? { model: s.model } : {}),
        ...(s.provider ? { provider: s.provider } : {}),
        ...(s.effort ? { effort: s.effort } : {}),
        ...(s.fast !== undefined ? { fast: s.fast } : {}),
      });
      s.setState("idle");
      return { sessionId: id };
    }

    if (!this.opts.acp)
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        "mcpServers require the acp transport (engine built without acp options)",
      );
    const driver = new AcpDriver(this.opts.acp, this);
    const opened = await driver.open(p);
    const s = new Session(
      id,
      p.agent,
      p.cwd,
      model,
      mcp,
      provider,
      effort,
      fast,
      "acp",
      opened.runtimeSid,
      opened.ref,
      (e) => this.emitAll(e),
    );
    driver.bind(s);
    this.sessions.set(id, s);
    this.acpDrivers.set(id, driver);
    s.emit("session.started", {
      agent: p.agent,
      cwd: p.cwd,
      ...(s.model ? { model: s.model } : {}),
      ...(s.provider ? { provider: s.provider } : {}),
      ...(s.effort ? { effort: s.effort } : {}),
      ...(s.fast !== undefined ? { fast: s.fast } : {}),
    });
    s.setState("idle");
    return { sessionId: id };
  }

  /**
   * #50 AC-1 — negotiate `session.create` against the connected gateway's
   * declared contract. A field the build doesn't declare answers a 4000
   * extra_forbidden rejection naming it; drop it when it's known-optional
   * and retry, remembering the drop for the life of this engine (the
   * contract can't change under one `hermes serve` process). Also captures
   * the gateway build from the result's `info` for describe().
   */
  private async createSessionCompat(params: Record<string, unknown>) {
    const send: Record<string, unknown> = { ...params };
    for (const f of this.droppedCreateFields) delete send[f];
    // Bounded: one retry per refused field, and only droppable ones retry.
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const r = (await this.opts.gateway.request("session.create", send)) as {
          info?: { version?: unknown; release_date?: unknown };
        };
        const info = r?.info;
        if (info && typeof info === "object") {
          this.gatewayInfo = {
            version:
              typeof info.version === "string" ? info.version : undefined,
            releaseDate:
              typeof info.release_date === "string"
                ? info.release_date
                : undefined,
          };
        }
        return r;
      } catch (e) {
        const field = extraForbiddenField(e);
        if (field && field in send && DROPPABLE_CREATE_FIELDS.has(field)) {
          delete send[field];
          this.droppedCreateFields.add(field);
          continue;
        }
        throw e;
      }
    }
    throw new RpcError(
      RPC_ERRORS.INTERNAL_ERROR,
      "session.create still rejected after dropping refused optional fields",
    );
  }

  private async prompt(p: PromptParams) {
    const s = this.require(p.sessionId);
    if (s.state === "closed")
      throw new RpcError(RPC_ERRORS.INVALID_STATE, `session ${s.id} is closed`);
    if (s.turn)
      throw new RpcError(
        RPC_ERRORS.INVALID_STATE,
        `session ${s.id} already has a running turn`,
      );
    const images = p.content.filter(
      (b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image",
    );
    const text = p.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => {
        return b.type === "text";
      })
      .map((b) => b.text)
      .join("\n");

    const turnId = `t${++this.turnCounter}`;
    const done = new Promise<{ turnId: string; stopReason: string }>(
      (resolve, reject) => {
        s.turn = { turnId, phase: "reasoning", resolve, reject };
      },
    );
    done.catch(() => {});
    s.emit("turn.started", {
      turnId,
      ...(s.model ? { model: s.model } : {}),
      ...(s.provider ? { provider: s.provider } : {}),
      ...(s.effort ? { effort: s.effort } : {}),
      ...(s.fast !== undefined ? { fast: s.fast } : {}),
      ...(p.ref ? { ref: p.ref } : {}),
    });
    s.setState("running");

    try {
      if (s.driver === "ws") {
        for (const img of images) {
          const ext = img.mimeType.split("/")[1] || "png";
          await this.opts.gateway.request("image.attach_bytes", {
            session_id: s.runtimeSid,
            content_base64: img.data,
            filename: `image.${ext}`,
            ext,
          });
        }
        await this.opts.gateway.request("prompt.submit", {
          session_id: s.runtimeSid,
          text,
        });
      } else {
        const driver = this.acpDrivers.get(s.id);
        if (!driver)
          throw new RpcError(
            RPC_ERRORS.INTERNAL_ERROR,
            `no acp driver for ${s.id}`,
          );
        void driver.submit(s, turnId, p.content).catch(() => {});
      }
    } catch (e) {
      const msg = e instanceof RpcError ? e.message : String(e);
      s.turn = undefined;
      s.emit("turn.completed", {
        turnId,
        stopReason: "refusal",
        error: msg,
      });
      s.setState("idle");
      throw e;
    }
    return done;
  }

  private async interrupt(p: InterruptParams) {
    const s = this.require(p.sessionId);
    if (s.state === "closed")
      throw new RpcError(RPC_ERRORS.INVALID_STATE, `session ${s.id} is closed`);
    if (!s.turn) return { interrupted: false };
    if (s.driver === "acp") {
      await this.acpDrivers.get(s.id)?.interrupt(s);
      return { interrupted: true };
    }
    const r = (await this.opts.gateway.request("session.interrupt", {
      session_id: s.runtimeSid,
    })) as { status?: unknown };
    return { interrupted: r.status === "interrupted" };
  }

  private requestRespond(p: RequestRespondParams) {
    const s = this.require(p.sessionId);
    const ask = s.openRequests.get(p.requestId);
    if (!ask) throw requestNotFound(p.requestId);
    const bad = resolveOutcomeValid(ask, p.outcome);
    if (bad) throw new RpcError(RPC_ERRORS.INVALID_PARAMS, bad);
    if (p.outcome === "answer" && p.answer === undefined)
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        "outcome answer needs an answer field",
      );

    s.openRequests.delete(p.requestId);
    s.emit("request.resolved", {
      requestId: p.requestId,
      outcome: p.outcome,
      ...(p.answer !== undefined ? { answer: p.answer } : {}),
    });
    ask.settle({ outcome: p.outcome, answer: p.answer });
    ask.respond(p.outcome, p.answer);
    if (s.openRequests.size === 0 && s.state === "waiting") {
      s.setState("running");
      if (s.turn) s.turn.phase = "tools";
    }
    return { accepted: true as const };
  }

  private eventsSince(p: EventsSinceParams) {
    return this.require(p.sessionId).eventsSince(p.after);
  }

  private async sessionStop(p: SessionStopParams) {
    const s = this.require(p.sessionId);
    if (s.state === "closed") return { stopped: false };
    cancelAllAsks(s);
    const t = s.turn;
    s.turn = undefined;
    if (s.driver === "acp") {
      const d = this.acpDrivers.get(s.id);
      this.acpDrivers.delete(s.id);
      if (d) await d.close(s);
    } else {
      try {
        await this.opts.gateway.request("session.close", {
          session_id: s.runtimeSid,
        });
      } catch {
        /* session may already be gone server-side */
      }
    }
    s.state = "closed";
    s.emit("session.state", { state: "closed" });
    if (t) {
      s.emit("turn.completed", { turnId: t.turnId, stopReason: "cancelled" });
      t.resolve({ turnId: t.turnId, stopReason: "cancelled" });
    }
    return { stopped: true };
  }

  private async sessionSteer(p: SessionSteerParams) {
    const s = this.require(p.sessionId);
    if (s.state === "closed")
      throw new RpcError(RPC_ERRORS.INVALID_STATE, `session ${s.id} is closed`);
    if (s.driver === "acp") {
      const d = this.acpDrivers.get(s.id);
      if (!s.turn || !d) return { status: "not_running" as const };
      const turnId = s.turn.turnId;
      const status = await d.steer(s, p.text, () => `t${++this.turnCounter}`);
      if (status === "steered")
        s.emit("turn.steered", { turnId, text: p.text });
      return { status };
    }
    let r: { status?: unknown };
    try {
      r = (await this.opts.gateway.request("session.steer", {
        session_id: s.runtimeSid,
        text: p.text,
      })) as { status?: unknown };
    } catch (e) {
      // Hermes 4010 = agent still building after session.create — no turn can
      // be running, so contract-wise the steer was not consumed.
      if (e instanceof RpcError && e.code === 4010)
        return { status: "not_running" as const };
      throw e;
    }
    if (r.status === "queued" || r.status === "redirected") {
      s.emit("turn.steered", {
        turnId: s.turn?.turnId ?? s.lastTurnId,
        text: p.text,
      });
      return { status: "steered" as const };
    }
    return { status: "not_running" as const };
  }

  // ── gateway inbound routing ───────────────────────────────────────────────

  /** ACP drivers call this when a queued (steer) turn becomes active. */
  beginTurn(s: Session, turnId: string) {
    s.turn = {
      turnId,
      phase: "reasoning",
      resolve: () => {},
      reject: () => {},
    };
    s.emit("turn.started", {
      turnId,
      ...(s.model ? { model: s.model } : {}),
      ...(s.provider ? { provider: s.provider } : {}),
      ...(s.effort ? { effort: s.effort } : {}),
      ...(s.fast !== undefined ? { fast: s.fast } : {}),
    });
    if (s.state !== "closed") s.setState("running");
  }

  private async sessionSetModel(p: SessionSetModelParams) {
    const s = this.require(p.sessionId);
    if (s.state === "closed")
      throw new RpcError(RPC_ERRORS.INVALID_STATE, `session ${s.id} is closed`);
    if (s.driver === "acp")
      throw new RpcError(
        RPC_ERRORS.METHOD_NOT_FOUND,
        "session.setModel needs the WS transport (no ACP equivalent yet)",
      );
    /* config.set trio: `<id> --provider <p> --reasoning <e>` + fast on/off.
       A running session defers the model leg to the next turn (`deferred`);
       `confirm_required` is answered inside setSessionModel (#92 AC-4). */
    const ack = await setSessionModel(this.opts.gateway, s.runtimeSid, {
      model: p.model,
      provider: p.provider,
      effort: p.effort,
      fast: p.fast,
    });
    s.model = ack.model;
    if (ack.provider !== undefined) s.provider = ack.provider;
    // Hermes keeps the session's reasoning override across a model switch.
    if (ack.effort !== undefined) s.effort = ack.effort;
    if (ack.fast !== undefined) s.fast = ack.fast;
    return {
      model: ack.model,
      ...(ack.provider ? { provider: ack.provider } : {}),
      ...(ack.effort ? { effort: ack.effort } : {}),
      ...(ack.fast !== undefined ? { fast: ack.fast } : {}),
      ...(ack.deferred === true ? { deferred: true } : {}),
    };
  }

  /**
   * `session.title` resolves a live runtime id first, then stored ids/keys —
   * ACP sessions reach it through the stored ref. A title set before the row
   * exists is queued server-side (`pending: true`), so no ordering care here.
   */
  private async sessionSetTitle(p: SessionSetTitleParams) {
    const s = this.require(p.sessionId);
    const r = (await this.opts.gateway.request("session.title", {
      session_id: s.driver === "ws" ? s.runtimeSid : s.ref,
      title: p.title,
    })) as { title?: unknown };
    if (typeof r.title !== "string")
      throw new RpcError(
        RPC_ERRORS.INTERNAL_ERROR,
        "session.title returned no title",
      );
    return { title: r.title };
  }

  /** `session.set_hidden` flags the session out of the default list. */
  private async sessionSetHidden(p: SessionSetHiddenParams) {
    const s = this.require(p.sessionId);
    const r = (await this.opts.gateway.request("session.set_hidden", {
      session_id: s.driver === "ws" ? s.runtimeSid : s.ref,
      hidden: p.hidden,
      profile: s.agent,
    })) as { hidden?: unknown };
    return { hidden: r.hidden === true };
  }

  /** ACP path: a session/prompt response IS the turn end (no message.complete). */
  endAcpTurn(
    s: Session,
    turnId: string,
    stopReason: StopReason,
    usage?: {
      inputTokens?: number | null;
      outputTokens?: number | null;
      thoughtTokens?: number | null;
      cachedReadTokens?: number | null;
      totalTokens?: number | null;
    } | null,
  ) {
    const u = usage
      ? ({
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          reasoning: usage.thoughtTokens ?? 0,
          cache: usage.cachedReadTokens ?? 0,
        } satisfies Usage)
      : undefined;
    if (u) s.usage = u;
    s.emit("turn.completed", {
      turnId,
      stopReason,
      ...(u ? { usage: u } : {}),
    });
    if (s.state !== "closed") {
      cancelAllAsks(s);
      s.setState("idle");
    }
    if (s.turn?.turnId === turnId) {
      const t = s.turn;
      s.turn = undefined;
      t.resolve({ turnId, stopReason });
    }
  }

  /** Update the durable ref after a rotation; emits session.ref.changed. */
  bumpRef(s: Session, ref: string) {
    if (!ref || ref === s.ref) return;
    const prev = s.ref;
    s.ref = ref;
    s.emit("session.ref.changed", { ref, previousRef: prev });
  }

  private onGatewayEvent(e: {
    type: string;
    sessionId: string;
    payload: Record<string, unknown>;
  }) {
    const s = this.byRuntimeSid.get(e.sessionId);
    if (!s) return;
    this.applyEvent(s, e.type, e.payload);
  }

  /** Shared by the WS and ACP event paths (acp.ts maps updates into these). */
  applyEvent(s: Session, type: string, p: Record<string, unknown>) {
    const turnId = s.turn?.turnId ?? s.lastTurnId;
    switch (type) {
      case "message.start":
        s.setState("running");
        break;
      case "reasoning.delta":
      case "reasoning.available": {
        if (typeof p.text === "string" && p.text)
          s.emit("turn.delta", { turnId, stream: "reasoning", delta: p.text });
        if (s.turn) s.turn.phase = "reasoning";
        break;
      }
      case "message.delta": {
        if (typeof p.text === "string" && p.text)
          s.emit("turn.delta", { turnId, stream: "text", delta: p.text });
        if (s.turn) s.turn.phase = "text";
        break;
      }
      case "message.interim": {
        const t = typeof p.text === "string" ? p.text : "";
        if (t) s.emit("turn.delta", { turnId, stream: "text", delta: t });
        break;
      }
      case "tool.start": {
        if (s.turn) s.turn.phase = "tools";
        s.emit("tool.started", {
          turnId,
          toolCallId: s.toolCallId(String(p.tool_id ?? "")),
          tool: String(p.name ?? "tool"),
          input:
            typeof p.args === "object" && p.args !== null
              ? (p.args as Record<string, unknown>)
              : {},
        });
        break;
      }
      case "tool.complete": {
        const mapped = mapToolStatus(p);
        s.emit("tool.completed", {
          turnId,
          toolCallId: s.toolCallId(String(p.tool_id ?? "")),
          tool: String(p.name ?? "tool"),
          status: mapped.status,
          ...(mapped.output !== undefined ? { output: mapped.output } : {}),
          ...(mapped.diff ? { diff: mapped.diff } : {}),
        });
        break;
      }
      case "session.info": {
        const stored = p.stored_session_id;
        if (typeof stored === "string" && stored && stored !== s.ref) {
          const prev = s.ref;
          s.ref = stored;
          s.emit("session.ref.changed", { ref: stored, previousRef: prev });
        }
        break;
      }
      case "message.complete":
        void this.completeTurn(s, p);
        break;
      default:
        break; // status.update, session.title, sessions.changed, ...
    }
  }

  /**
   * Turn end: poll `session.title` for a silent ref rotation (auto-compress
   * emits no `session.info`), emit ref change, then `turn.completed`.
   */
  private async completeTurn(s: Session, p: Record<string, unknown>) {
    const turn = s.turn;
    if (turn) s.lastTurnId = turn.turnId;
    if (s.driver === "ws") {
      try {
        const r = (await this.opts.gateway.request("session.title", {
          session_id: s.runtimeSid,
        })) as { session_key?: unknown };
        if (
          typeof r.session_key === "string" &&
          r.session_key &&
          r.session_key !== s.ref
        ) {
          const prev = s.ref;
          s.ref = r.session_key;
          s.emit("session.ref.changed", { ref: s.ref, previousRef: prev });
        }
      } catch {
        /* best effort: session.info events still catch most rotations */
      }
    }
    const { stopReason } = mapStopReason(p.status);
    const usage = mapUsage(p.usage);
    if (usage) s.usage = usage;
    const errText = typeof p.error === "string" ? p.error : undefined;
    s.emit("turn.completed", {
      turnId: turn?.turnId ?? s.lastTurnId,
      stopReason,
      ...(usage ? { usage } : {}),
      ...(errText ? { error: errText } : {}),
    });
    s.turn = undefined;
    if (s.state !== "closed") {
      cancelAllAsks(s);
      s.setState(s.openRequests.size ? "waiting" : "idle");
    }
    turn?.resolve({ turnId: turn.turnId, stopReason });
  }

  private onServerRequest(r: {
    id: string;
    method: string;
    params: Record<string, unknown>;
  }) {
    const sid =
      typeof r.params.session_id === "string"
        ? r.params.session_id
        : typeof r.params.gateway_session_id === "string"
          ? r.params.gateway_session_id
          : "";
    const s = this.byRuntimeSid.get(sid);
    if (!s) {
      this.opts.gateway.respond(r.id, {
        error: {
          code: RPC_ERRORS.METHOD_NOT_FOUND,
          message: `unknown session for ${r.method}`,
        },
      });
      return;
    }
    const gw = this.opts.gateway;
    if (r.method === "approval") {
      const request = mapApprovalParams(r.params);
      if (!request) {
        gw.respond(r.id, { result: { choice: "deny" } });
        return;
      }
      this.openAsk(s, r.id, request, "approval", (outcome) =>
        gw.respond(r.id, { result: approvalOutcomeToResult(outcome) }),
      );
      return;
    }
    if (r.method === "clarify") {
      const questions = mapClarifyParams(r.params);
      if (questions.length === 0) {
        gw.respond(r.id, { result: {} });
        return;
      }
      const group =
        questions.length > 1
          ? {
              pending: new Set(questions.map((q) => q.qid)),
              answers: {} as Record<string, string>,
              cancelled: false,
            }
          : undefined;
      for (const q of questions) {
        const respond = (outcome: ApprovalOutcome, answer?: string) => {
          if (!group) {
            // single-question form: {answer} ("" = skip); {} = cancel-all
            gw.respond(r.id, {
              result: outcome === "cancel" ? {} : { answer: answer ?? "" },
            });
            return;
          }
          group.pending.delete(q.qid);
          if (outcome === "cancel") {
            if (!group.cancelled) {
              group.cancelled = true;
              gw.respond(r.id, { result: {} }); // cancel-all
            }
            return;
          }
          if (group.cancelled) return;
          group.answers[q.qid] = answer ?? "";
          if (group.pending.size === 0)
            gw.respond(r.id, { result: { answers: group.answers } });
        };
        this.openAsk(
          s,
          r.id,
          q.request,
          "clarify",
          respond,
          q.qid,
          group,
          q.qid ? `${r.id}/${q.qid}` : r.id,
        );
      }
      return;
    }
    // sudo/secret/vault.*/preview.*/terminal.read/display.*/tour/window.read:
    // desktop bridges LilOS never crosses — refuse per the issue spec.
    this.opts.gateway.respond(r.id, {
      error: {
        code: RPC_ERRORS.METHOD_NOT_FOUND,
        message: `server request ${r.method} is not supported by engine-hermes`,
      },
    });
  }

  /**
   * Open a client-facing ask; returns a promise resolved by request.respond
   * (or wire cancel). `respond` sends the answer back on the wire.
   */
  openAsk(
    s: Session,
    wireId: string,
    request: EngineRequest,
    kind: "approval" | "clarify",
    respond: PendingAsk["respond"],
    qid = "",
    group?: PendingAsk["group"],
    requestId = wireId,
  ): Promise<{ outcome: ApprovalOutcome; answer?: string }> {
    const turnId = s.turn?.turnId ?? s.lastTurnId ?? "t0";
    let settle: PendingAsk["settle"] = () => {};
    const answered = new Promise<{ outcome: ApprovalOutcome; answer?: string }>(
      (r) => {
        settle = r;
      },
    );
    answered.catch(() => {});
    const ask: PendingAsk = {
      requestId,
      turnId,
      request,
      seq: s.seq + 1,
      wireId,
      kind,
      qid,
      respond,
      answered,
      settle,
      ...(group ? { group } : {}),
    };
    s.openRequests.set(requestId, ask);
    s.emit("request.opened", { turnId, requestId, request });
    if (s.turn) s.turn.phase = "waiting";
    s.setState("waiting");
    return answered;
  }

  private onServerCancel(c: { id: string; method: string; reason?: string }) {
    // The server withdrew the srq: resolve every ask bound to that wire id.
    for (const s of this.sessions.values()) {
      for (const ask of [...s.openRequests.values()]) {
        if (ask.wireId === c.id) cancelAsk(s, ask);
      }
      if (s.state === "waiting" && s.openRequests.size === 0)
        s.setState("running");
    }
  }

  private require(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s)
      throw new RpcError(
        RPC_ERRORS.SESSION_NOT_FOUND,
        `no session ${sessionId}`,
      );
    return s;
  }

  /** For the live runner / harness: map a runtime sid back to a session id. */
  sessionIdFor(runtimeSid: string): string | undefined {
    return this.byRuntimeSid.get(runtimeSid)?.id;
  }

  /** For the live runner / harness: the session behind a LilOS session id. */
  sessionFor(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  async close() {
    for (const s of [...this.sessions.values()]) {
      try {
        await this.sessionStop({ sessionId: s.id });
      } catch {
        /* best effort */
      }
    }
    this.opts.gateway.close();
  }
}
