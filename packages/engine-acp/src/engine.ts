import type * as acp from "@agentclientprotocol/sdk";
import {
  type AgentDescriptor,
  type AgentsCreateParams,
  type AgentsDescribeParams,
  type AgentsUpdateParams,
  type ApprovalOutcome,
  autoTitle,
  type DescribeResult,
  ENGINE_METHODS,
  ENGINE_PROTOCOL,
  type EngineEvent,
  type EventsSinceParams,
  type InterruptParams,
  type ModelsListParams,
  type ModelsListResult,
  type PromptParams,
  type PromptResult,
  type RequestRespondParams,
  RPC_ERRORS,
  type SessionSetHiddenParams,
  type SessionSetModelParams,
  type SessionSetModelResult,
  type SessionSetTitleParams,
  type SessionStartParams,
  type SessionSteerParams,
  type SessionStopParams,
  type SessionSuspendParams,
} from "@lilos/contracts/engine";
import { AcpAgentRoster } from "./agents.js";
import {
  type AcpSessionConfig,
  catalogEffortOption,
  catalogFastOption,
  catalogModelOption,
  catalogModels,
  configOptionDescriptor,
  deriveCapabilities,
  type EngineConfigOption,
  learnSessionConfig,
} from "./capabilities.js";
import { AcpConnection } from "./client.js";
import { RpcError } from "./errors.js";
import {
  acpStopReason,
  acpTurnUsage,
  handleAcpUpdate,
  toAcpContent,
  toAcpMcp,
} from "./mapping.js";
import { acpApprovalRequest, acpPermissionAnswer } from "./permissions.js";
import { AcpSession, cancelAllAcpAsks, type PendingAcpAsk } from "./session.js";
import {
  type AcpClientTerminals,
  resolveEmbeddedTerminalContent,
} from "./terminals.js";

/**
 * D-#764 — the generic ACP engine: any agent speaking the pinned ACP schema
 * over stdio runs through the shared mapping (`mapping.ts`,
 * `capabilities.ts`, `permissions.ts`) and answers the LilOS engine
 * protocol. Agent identity never appears — `command` argv is the only
 * agent-specific input the caller supplies. Per-job model/effort/fast
 * picks write through the config options the live session advertised
 * (D-#846); a pick it cannot take is skipped with a session note.
 */

export interface AcpEngineOptions {
  /** Engine identity in describe() (e.g. "engine-acp-fake" for the fake). */
  name?: string;
  version?: string;
  /** The agent's stdio command — `["bun","scripts/fake-agent.ts"]` etc. */
  command: string[];
  env?: Record<string, string>;
  /**
   * Env names removed from the inherited env before the agent spawns (the
   * shim's env policy — e.g. provider-auth vars that must not reroute the
   * agent off the user's own login). Inherited names only; explicit `env`
   * grants still land.
   */
  dropEnv?: readonly string[];
  /** `initialize.clientInfo`. */
  clientInfo?: { name: string; version: string };
  /**
   * `initialize.clientCapabilities` override — the shim advertises what
   * the agent needs (e.g. `terminal: true` for agents that run commands
   * through the client). Defaults to no delegation.
   */
  clientCapabilities?: acp.ClientCapabilities;
  /**
   * Client-side `terminal/*` serving (D-#845) — required when
   * `clientCapabilities.terminal` is advertised; the engine also resolves
   * `{type:"terminal"}` tool-call content against the manager's buffers.
   */
  terminals?: AcpClientTerminals;
  /** Per-session event-log cap (#431). */
  eventLogCap?: number;
  /**
   * Access-level -> mode hint: `session.start.access` maps through here
   * when the session advertised modes (ACP modes are agent-defined ids —
   * the generic engine cannot guess them; the engine package knows its
   * agent's vocabulary and passes the mapping in).
   */
  modeForAccess?: (
    access: "ask" | "full",
    modes: { id: string; name?: string }[],
  ) => string | undefined;
  /**
   * Extra `_meta` sent on `session/new` (agent-provenance hooks live with
   * the engine package, not the generic seam).
   */
  sessionMeta?: (p: SessionStartParams) => Record<string, unknown>;
  /**
   * Engine-level effort default (D-#761): applied on `session.start` when
   * the caller picks no effort — the launch spec names an advertised
   * `thought_level` value (e.g. Devin's free SWE-2 `max`). Absent = the
   * agent's own default.
   */
  defaultEffort?: string;
  /**
   * The launched agent's roster seed (D-#845): the descriptor
   * `agents.list` opens with — id, display name, `detail.isDefault` for
   * the harness's first-run hire. Defaults to a generic "default" row.
   */
  agent?: AgentDescriptor;
  /**
   * Bound on agent round-trips that can wedge on the agent's own child
   * (session/new·load·set-mode·set-config·close — never `prompt`, which is
   * a live turn). On timeout that one call errors — the adapter is NOT
   * torn down: it multiplexes every live session over one process
   * group, so a per-session wedge must never SIGKILL healthy turns
   * (D-#866's installed-app find; r6 review — the wedged session is
   * abandoned, adapter-side state for it ages out on the agent).
   */
  createTimeoutMs?: number;
  /**
   * Total `session.start` budget (default 50s — inside the harness's
   * 60s bind wait, D-#866 r7): newSession plus every config/mode write
   * draws from it so the chain can never finish after the host already
   * gave up and leave the ACP session + child orphaned. Tests shrink it.
   */
  startBudgetMs?: number;
}

/** Default for {@link AcpEngineOptions.startBudgetMs} — binds.ts gives
    session.start 60s; 10s of headroom covers transport + bind work. */
const SESSION_START_BUDGET_MS = 50_000;

export class AcpEngine {
  private conn?: AcpConnection;
  private sessions = new Map<string, AcpSession>();
  private listeners = new Set<(e: EngineEvent) => void>();
  private sessionCounter = 0;
  private turnCounter = 0;
  private requestCounter = 0;
  /** Session-config catalog learned from session/new advertisements —
      engine-wide truth that accrues as sessions open (D-#764). */
  private catalog: AcpSessionConfig = { options: new Map() };
  /* D-#845 — LilOS personas over the one launched binary; in-memory, the
     same lifetime as the session map. */
  private agents: AcpAgentRoster;
  private opening?: Promise<AcpConnection>;
  /** The backgrounded catalog probe — models.list awaits it so a first
     call still returns the advertised table, never an empty race (D-#866). */
  private catalogProbe?: Promise<void>;
  private pumping = new Set<string>();

  constructor(private readonly opts: AcpEngineOptions) {
    this.agents = new AcpAgentRoster(
      opts.agent ?? {
        id: "default",
        name: "Default",
        detail: { isDefault: true },
      },
      () => catalogModels(this.catalog),
    );
  }

  onEvent(fn: (e: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emitAll(e: EngineEvent) {
    for (const fn of this.listeners) fn(e);
  }

  /** Lazily spawn the agent + `initialize` once; describe() needs it. */
  private async connection(): Promise<AcpConnection> {
    /* A dead adapter (wedged-request teardown or an unexpected exit) is
       dropped here — the next demand spawns a fresh one instead of
       queuing behind the corpse (D-#866). */
    if (this.conn?.dead) this.conn = undefined;
    if (this.conn) return this.conn;
    this.opening ??= AcpConnection.open({
      command: this.opts.command,
      ...(this.opts.env ? { env: this.opts.env } : {}),
      ...(this.opts.dropEnv ? { dropEnv: this.opts.dropEnv } : {}),
      ...(this.opts.createTimeoutMs !== undefined
        ? { createTimeoutMs: this.opts.createTimeoutMs }
        : {}),
      cwd: process.cwd(),
      ...(this.opts.clientInfo ? { clientInfo: this.opts.clientInfo } : {}),
      ...(this.opts.clientCapabilities
        ? { clientCapabilities: this.opts.clientCapabilities }
        : {}),
      ...(this.opts.terminals
        ? {
            terminals: {
              create: (r) => this.opts.terminals!.create(r),
              output: async (r) => this.opts.terminals!.output(r),
              waitForExit: (r) => this.opts.terminals!.waitForExit(r),
              kill: (r) => this.opts.terminals!.kill(r),
              release: (r) => this.opts.terminals!.release(r),
            },
          }
        : {}),
      handlers: {
        onPermission: (params) => this.onPermission(params),
        onUpdate: (params) => this.onUpdate(params),
      },
      onDead: () => this.onAdapterGone(),
    }).then(async (c) => {
      this.conn = c;
      /* The config-option/mode catalog lives on session/new, not
         initialize — one scratch probe session learns it. It runs
         BACKGROUNDED (D-#866): describe()/models.list answer from
         initialize + whatever the catalog has accrued — a slow first
         child init under a fresh macOS ancestry (~14s on the installed
         app) must not put the probe on describe's critical path. */
      this.catalogProbe = this.probeCatalog(c);
      return c;
    });
    try {
      return await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  /** The catalog probe — a scratch session/new so describe/models.list are
     honest before the first real session (#764). Non-fatal on timeout: a
     wedged probe drops the catalog fill, never the adapter — a real
     session's own bound still enforces the wedge (D-#866). */
  private async probeCatalog(c: AcpConnection) {
    try {
      /* D-#866 (r4): the scratch session still spawns the agent's child —
         it must carry the same `ask` meta as a gated session so NO session
         is ever born under the user's bypassPermissions default.
         `armWedge:false` — a hung probe leaves ONE bounded child (reaped
         at conn close); it must not bar real session starts, which is
         what the wedged-create guard exists to protect (r7 nit). */
      const probe = await c.newSession(
        {
          cwd: process.cwd(),
          ...(this.opts.sessionMeta
            ? {
                meta: this.opts.sessionMeta({
                  agent: this.opts.agent?.id ?? "",
                  cwd: process.cwd(),
                  access: "ask",
                }),
              }
            : {}),
        },
        { armWedge: false },
      );
      learnSessionConfig(this.catalog, probe);
      await c.closeSession(probe.sessionId);
    } catch (e) {
      /* Still reap on a wedged probe when nobody else is using the
         adapter — the wedged probe child dies with the conn (r7 nit),
         and the next demand re-probes on a fresh adapter. */
      await this.reapWedgedCreate(c, e);
      /* An agent that cannot open a session cannot run turns either —
         the empty catalog just means no models capability yet. */
    }
  }

  async close() {
    for (const s of this.sessions.values()) cancelAllAcpAsks(s);
    await this.opts.terminals?.disposeAll();
    await this.conn?.close();
    this.conn = undefined;
  }

  /**
   * The shared adapter died (process exit or `close()`) — every ACP
   * session id it held is dead with it. Mark each live session
   * suspended so the next use re-creates it on the fresh adapter
   * through the normal resume path, instead of prompting a stale id
   * and surfacing the adapter's -32603 as a "refusal" (D-#866 r6 —
   * the reviewer's poison.ts: one wedged start used to poison every
   * other session with "Internal error" turns).
   */
  private onAdapterGone() {
    for (const s of this.sessions.values()) {
      if (s.suspended || s.state === "closed") continue;
      cancelAllAcpAsks(s);
      s.suspended = true;
      s.state = "closed";
      s.emit("session.state", { state: "closed", reason: "suspended" });
      if (s.turn) {
        const turn = s.turn;
        s.turn = undefined;
        s.emit("turn.completed", {
          turnId: turn.turnId,
          stopReason: "cancelled",
        });
      }
    }
  }

  // ── dispatch ───────────────────────────────────────────────────────────

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
    /* Capability-gated methods exist only while describe() declares their
       capability — the app never calls them otherwise (D-#19). The catalog
       probe is backgrounded now (D-#866), so a gated call arriving before
       the probe lands waits it out and re-derives once — bounded +
       non-fatal, never a hang. */
    if (contract.capability) {
      const declared = async () =>
        (await this.describe()).capabilities.map((c) => c.id);
      if (!(await declared()).includes(contract.capability)) {
        await this.catalogProbe;
        if (!(await declared()).includes(contract.capability))
          throw new RpcError(
            RPC_ERRORS.METHOD_NOT_FOUND,
            `${method} needs the ${contract.capability} capability`,
          );
      }
    }
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
      case "session.suspend":
        return this.sessionSuspend(parsed.data as SessionSuspendParams);
      case "session.steer":
        return this.sessionSteer(parsed.data as SessionSteerParams);
      case "models.list":
        return this.modelsList(parsed.data as ModelsListParams);
      case "agents.list":
        return { agents: this.agents.list() };
      case "agents.describe":
        return {
          agent: this.agents.describe((parsed.data as AgentsDescribeParams).id),
        };
      case "agents.create":
        return {
          agent: this.agents.create(parsed.data as AgentsCreateParams),
        };
      case "agents.update":
        return {
          agent: this.agents.update(parsed.data as AgentsUpdateParams),
        };
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

  private async describe(): Promise<DescribeResult> {
    const conn = await this.connection();
    /* describe is the host's LIVENESS probe (D-#482: 1.5s deadline, two
       misses restart the adapter) — it answers immediately from whatever
       the catalog holds right now. A slow first session/new under a fresh
       app ancestry (~14s) starving this into a restart loop was the r4
       failure: NO grace, no wait — the catalog fills whenever the
       backgrounded probe lands, and only `models.list`/the capability
       gate await it. */
    return {
      name: this.opts.name ?? "engine-acp",
      version: this.opts.version ?? "0.0.0",
      protocol: ENGINE_PROTOCOL,
      capabilities: [
        ...deriveCapabilities(conn.initializeResult, this.catalog),
        /* D-#845 — the roster is engine-owned (one launched binary + the
           LilOS personas created over it), so `agents` is declared for
           every ACP agent — the hire surface needs it. */
        {
          id: "agents",
          name: "Hireable agents",
          description:
            "One launched ACP agent plus LilOS personas created over it; sessions start as one.",
          methods: [
            "agents.list",
            "agents.describe",
            "agents.create",
            "agents.update",
          ],
          detail: { updatable: ["name", "description", "soul", "model"] },
        },
      ],
    };
  }

  private require(sessionId: string): AcpSession {
    const s = this.sessions.get(sessionId);
    if (!s)
      throw new RpcError(
        RPC_ERRORS.SESSION_NOT_FOUND,
        `no session ${sessionId}`,
      );
    return s;
  }

  // ── session lifecycle ──────────────────────────────────────────────────

  private async sessionStart(p: SessionStartParams) {
    const conn = await this.connection();
    /* D-#866 r7: the whole start chain (newSession + config writes +
       set_mode) must answer inside the harness's 60s bind wait — a
       chain of unbounded per-RPC timeouts could finish after the
       harness already gave up, orphaning the ACP session + its child.
       Each call gets what is left of the budget; a starved tail lands
       as visible skip notes, not a silent no-op. */
    const startDeadline =
      Date.now() + (this.opts.startBudgetMs ?? SESSION_START_BUDGET_MS);
    const left = () => Math.max(0, startDeadline - Date.now());
    /* The persona's profile model is the default the session picks up —
       an explicit session.start.model still wins (D-#845: `agent` is the
       LilOS persona handle; ACP `session/new` has no profile gate, so an
       unknown name still starts under it). */
    const persona = this.agents.resolve(p.agent);
    const res = await conn
      .newSession(
        {
          cwd: p.cwd,
          mcpServers: (p.mcpServers ?? []).map(toAcpMcp),
          ...(this.opts.sessionMeta ? { meta: this.opts.sessionMeta(p) } : {}),
        },
        {
          timeoutMs: left(),
          /* r9: the caller's stable identity scopes the wedge guard —
             retries of THIS conversation's start fail fast; another
             conversation in the same folder creates normally (cwd
             keying had them share the wedge — the samecwd repro). */
          ...(p.callerKey ? { callerKey: p.callerKey } : {}),
        },
      )
      .catch(async (e) => {
        await this.reapWedgedCreate(conn, e);
        throw e;
      });
    const id = `s-${++this.sessionCounter}`;
    const s = new AcpSession(
      id,
      p.agent,
      p.cwd,
      (e) => this.emitAll(e),
      this.opts.eventLogCap,
    );
    s.acpSessionId = res.sessionId;
    /* Resume's session/new fallback keys on the same caller so its own
       retries still can't stack (r9). */
    s.callerKey = p.callerKey ?? id;
    s.access = p.access;
    this.sessions.set(id, s);
    this.learnSession(s, res);
    /* D-#846: the requested pick (composer row, persona pin, stored
       default — all arrive as session.start params) writes only through
       options THIS session advertised; skips go home in the result — an
       emitted session.note would race the host's binding registration. */
    const notes: string[] = [];
    await this.applyPick(
      s,
      {
        model: p.model ?? persona?.model,
        /* D-#761: an engine-level default effort (`defaultEffort` on the
           launch spec — Devin's free SWE-2 `max`) lands when the caller
           didn't pick one; a session param still wins, and the write only
           ever goes through options this session advertised. */
        effort: p.effort ?? this.opts.defaultEffort,
        fast: p.fast,
      },
      (line) => notes.push(line),
      left,
    );
    /* Access hint: only when the session advertised modes and the engine
       knows this agent's mode vocabulary. A failed write is a skip note
       — the start never reports a gated mode it could not apply. */
    if (p.access && s.modes && this.opts.modeForAccess) {
      const modeId = this.opts.modeForAccess(p.access, s.modes.available);
      if (modeId) {
        const ok = await conn
          .setMode(s.acpSessionId, modeId, { timeoutMs: left() })
          .then(() => true)
          .catch(() => false);
        if (!ok) notes.push(this.skipText(`the "${modeId}" mode`));
      }
    }
    s.emit("session.started", {
      agent: p.agent,
      cwd: p.cwd,
      ...(s.model ? { model: s.model } : {}),
      ...(s.effort ? { effort: s.effort } : {}),
      ...(s.fast !== undefined ? { fast: s.fast } : {}),
    });
    s.setState("idle");
    return {
      sessionId: id,
      engineSessionId: s.acpSessionId,
      ...(notes.length ? { notes } : {}),
    };
  }

  /** Fold a session/new (or load) response into the catalogs. */
  private learnSession(
    s: AcpSession,
    res: Pick<acp.NewSessionResponse, "configOptions" | "modes">,
  ) {
    learnSessionConfig(this.catalog, res);
    for (const o of res.configOptions ?? []) {
      const d = configOptionDescriptor(o);
      s.configOptions.set(d.id, d);
      this.applyConfigValue(s, d);
    }
    if (res.modes) {
      s.modes = {
        current: res.modes.currentModeId,
        available: res.modes.availableModes.map((m) => ({
          id: m.id,
          ...(m.name ? { name: m.name } : {}),
        })),
      };
    }
  }

  /** A config option's currentValue -> the session's model/effort/fast pick. */
  private applyConfigValue(s: AcpSession, o: EngineConfigOption) {
    if (o.currentValue === undefined) return;
    if (o.category === "model") s.model = o.currentValue;
    else if (o.category === "thought_level") s.effort = o.currentValue;
    else if (o.category === "model_config") {
      /* The fast tier is the value literally named "fast" (or any boolean
         switch under the same category). */
      if (o.type === "boolean") s.fast = o.currentValue === "true";
      else s.fast = o.currentValue === "fast";
    }
  }

  /**
   * This session's advertised config table — the only truth a pick may
   * write through (D-#846's trap: the engine-wide catalog is a union of
   * every session's advertisement; an option this session never offered
   * is skipped, not forced).
   */
  private sessionConfig(s: AcpSession): AcpSessionConfig {
    return { options: s.configOptions };
  }

  /**
   * One pick (session.start fields, session.setModel params, or the
   * session's own stored pick on resume) -> config_option writes. Each
   * field either lands — recorded on `s.pick` so resume can re-apply it —
   * or reports through `skip` (D-#846: visible, never a failed start).
   * The caller owns delivery: session.start returns the lines (its events
   * race the host's binding), bound-session paths emit `session.note`.
   */
  private async applyPick(
    s: AcpSession,
    pick: { model?: string; effort?: string; fast?: boolean },
    skip: (line: string) => void,
    budget?: () => number,
  ) {
    const cfg = this.sessionConfig(s);
    if (pick.model !== undefined) {
      const opt = catalogModelOption(cfg);
      if (
        !opt?.choices.some((c) => c.value === pick.model) ||
        !(await this.writePick(
          s,
          "model",
          opt.id,
          pick.model,
          pick.model,
          budget,
        ))
      )
        skip(this.skipText(`model "${pick.model}"`));
    }
    if (pick.effort !== undefined) {
      const opt = catalogEffortOption(cfg);
      if (
        !opt?.choices.some((c) => c.value === pick.effort) ||
        !(await this.writePick(
          s,
          "effort",
          opt.id,
          pick.effort,
          pick.effort,
          budget,
        ))
      )
        skip(this.skipText(`effort "${pick.effort}"`));
    }
    if (pick.fast !== undefined) {
      const fast = catalogFastOption(cfg);
      if (fast) {
        const value = pick.fast ? fast.fastValue : offValue(fast);
        if (
          !(await this.writePick(
            s,
            "fast",
            fast.option.id,
            value,
            pick.fast,
            budget,
          ))
        )
          skip(this.skipText("the fast tier"));
      } else if (pick.fast) skip(this.skipText("the fast tier"));
      /* fast:false with no fast-tier option is already the agent's
         standard route — nothing to write, nothing to note. */
    }
  }

  /** The one-line note a skipped pick produces, wherever it surfaces. */
  private skipText(what: string) {
    return `Skipped ${what} — the agent didn't take it; running its own default.`;
  }

  /**
   * One session/set_config_option write. On success the requested value
   * joins `s.pick` (the resume replay set); a refusal reports `false` —
   * the caller words and delivers the skip note.
   */
  private async writePick<K extends "model" | "effort" | "fast">(
    s: AcpSession,
    field: K,
    configId: string,
    value: string,
    picked: NonNullable<AcpSession["pick"]>[K],
    budget?: () => number,
  ): Promise<boolean> {
    try {
      await this.writeConfig(s, configId, value, budget?.());
      s.pick = { ...s.pick, [field]: picked };
      return true;
    } catch {
      return false;
    }
  }

  /** One session/set_config_option write + the session's pick update.
      `timeoutMs` shrinks the call's bound — session.start passes the
      remainder of its start budget so a slow tail cannot overrun the
      harness's bind wait (D-#866 r7). */
  private async writeConfig(
    s: AcpSession,
    configId: string,
    value: string,
    timeoutMs?: number,
  ) {
    const conn = this.conn;
    if (!conn) return;
    const res = await conn.setConfigOption(s.acpSessionId, configId, value, {
      timeoutMs,
    });
    this.applyConfigOptions(s, res.configOptions ?? []);
  }

  /** A full configOptions array (set response / config_option_update). */
  private applyConfigOptions(
    s: AcpSession,
    options: acp.SessionConfigOption[],
  ) {
    for (const o of options) {
      const d = configOptionDescriptor(o);
      s.configOptions.set(d.id, d);
      this.catalog.options.set(d.id, d);
      this.applyConfigValue(s, d);
    }
  }

  // ── turns ──────────────────────────────────────────────────────────────

  private async prompt(p: PromptParams): Promise<PromptResult> {
    const s = this.require(p.sessionId);
    if (s.suspended) await this.resume(s);
    if (s.state === "closed")
      throw new RpcError(RPC_ERRORS.INVALID_STATE, `session ${s.id} is closed`);
    const turnId = `t${++this.turnCounter}`;
    return this.runTurn(s, turnId, p.content, p.ref);
  }

  /**
   * One turn: turn.started -> session/prompt -> update frames -> the
   * response IS the turn end (ACP has no separate completion event).
   * `turn.started` fires inside the prompt pump's onStart — a send queued
   * behind an in-flight prompt opens its turn only once it's on the wire,
   * so two turns are never open at once.
   */
  private async runTurn(
    s: AcpSession,
    turnId: string,
    content: Parameters<typeof toAcpContent>[0][],
    ref?: string,
  ): Promise<PromptResult> {
    const conn = await this.connection();
    this.autoTitle(s, "derived", firstText(content));
    const startTurn = () => {
      /* Stopped/suspended while queued: the send still hits the wire (the
         queue cannot recall it) but the dead session opens no turn. */
      if (s.state === "closed") return;
      s.turn = { turnId, phase: "reasoning" };
      s.emit("turn.started", {
        turnId,
        ...(s.model ? { model: s.model } : {}),
        ...(s.effort ? { effort: s.effort } : {}),
        ...(s.fast !== undefined ? { fast: s.fast } : {}),
        ...(ref ? { ref } : {}),
      });
      s.setState("running");
    };
    try {
      const res = await conn.prompt(
        s.acpSessionId,
        content.map(toAcpContent),
        startTurn,
      );
      const usage = acpTurnUsage(s.usage, res.usage ?? undefined);
      if (usage) s.usage = usage;
      const stopReason = acpStopReason(res.stopReason);
      /* session.stop/suspend mid-turn already closed the turn as cancelled —
         only the live owner emits the completion (one terminal frame). */
      if (s.turn?.turnId === turnId) {
        s.emit("turn.completed", {
          turnId,
          stopReason,
          ...(usage ? { usage } : {}),
        });
      }
      return { turnId, stopReason, ...(usage ? { usage } : {}) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: unknown }).code;
      if (s.turn?.turnId === turnId) {
        s.emit("turn.completed", {
          turnId,
          stopReason: "refusal",
          error: msg,
          ...(typeof code === "number" ? { errorCode: code } : {}),
        });
      }
      return { turnId, stopReason: "refusal" };
    } finally {
      s.turn = undefined;
      s.lastTurnId = turnId;
      cancelAllAcpAsks(s);
      if (s.state !== "closed") s.setState("idle");
      this.drainSteers(s);
    }
  }

  private async interrupt(p: InterruptParams) {
    const s = this.require(p.sessionId);
    const conn = this.conn;
    if (!conn || !s.acpSessionId) return { interrupted: false };
    /* A turn still queued behind an in-flight prompt cancels too. */
    if (!s.turn && !conn.promptBusyFor(s.acpSessionId))
      return { interrupted: false };
    /* A parked permission ask blocks the agent's own unwind — the protocol
       has the client answer it cancelled on session/cancel, so resolve ours
       first, then send the cancel. */
    cancelAllAcpAsks(s);
    await conn.cancel(s.acpSessionId);
    return { interrupted: true };
  }

  private async sessionSteer(p: SessionSteerParams) {
    const s = this.require(p.sessionId);
    if (s.suspended) await this.resume(s);
    const turnId = s.turn?.turnId;
    if (!turnId) return { status: "not_running" as const };
    /* ACP has no mid-turn injection: the steer queues as the next
       session/prompt — `turn.steered` marks the acceptance and the queued
       leg's own turn.started echoes its ref (#308). */
    s.steeredQueue.push({ text: p.text, ...(p.ref ? { ref: p.ref } : {}) });
    s.emit("turn.steered", { turnId, text: p.text });
    this.drainSteers(s);
    return { status: "steered" as const };
  }

  /** Pump queued steers as implicit legs — each mints its turn id at send
     time so its frames never merge into the turn it was sent under. */
  private drainSteers(s: AcpSession) {
    if (this.pumping.has(s.id) || !s.steeredQueue.length || s.turn) return;
    this.pumping.add(s.id);
    void (async () => {
      const conn = this.conn;
      try {
        while (conn && s.steeredQueue.length && !s.suspended) {
          const queued = s.steeredQueue[0];
          const turnId = `t${++this.turnCounter}`;
          s.turn = { turnId, phase: "reasoning" };
          s.emit("turn.started", {
            turnId,
            ...(s.model ? { model: s.model } : {}),
            ...(s.effort ? { effort: s.effort } : {}),
            ...(s.fast !== undefined ? { fast: s.fast } : {}),
            ...(queued.ref ? { ref: queued.ref } : {}),
          });
          s.setState("running");
          s.steeredQueue.shift();
          try {
            const res = await conn.prompt(s.acpSessionId, [
              { type: "text", text: queued.text },
            ]);
            const usage = acpTurnUsage(s.usage, res.usage ?? undefined);
            if (usage) s.usage = usage;
            if (s.turn?.turnId === turnId) {
              s.emit("turn.completed", {
                turnId,
                stopReason: acpStopReason(res.stopReason),
                ...(usage ? { usage } : {}),
              });
            }
          } catch (e) {
            if (s.turn?.turnId === turnId) {
              const msg = e instanceof Error ? e.message : String(e);
              const code = (e as { code?: unknown }).code;
              s.emit("turn.completed", {
                turnId,
                stopReason: "refusal",
                error: msg,
                ...(typeof code === "number" ? { errorCode: code } : {}),
              });
            }
            break;
          } finally {
            s.turn = undefined;
            s.lastTurnId = turnId;
            cancelAllAcpAsks(s);
            if (s.state !== "closed") s.setState("idle");
          }
        }
      } finally {
        this.pumping.delete(s.id);
      }
    })();
  }

  // ── asks ───────────────────────────────────────────────────────────────

  /** Agent -> client `session/request_permission`: open the engine ask. */
  private async onPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const s = this.sessionForAcp(params.sessionId);
    if (!s) return { outcome: { outcome: "cancelled" } };
    const request = acpApprovalRequest(params);
    const requestId = `acp-r${++this.requestCounter}`;
    const turnId = s.turn?.turnId ?? s.lastTurnId ?? "t0";
    let settle: PendingAcpAsk["settle"] = () => {};
    const answered = new Promise<{
      outcome: ApprovalOutcome;
      answer?: string;
    }>((r) => {
      settle = r;
    });
    answered.catch(() => {});
    s.openRequests.set(requestId, {
      requestId,
      turnId,
      request,
      seq: s.seq + 1,
      answered,
      settle,
    });
    s.emit("request.opened", { turnId, requestId, request });
    if (s.turn) s.turn.phase = "waiting";
    s.setState("waiting");
    const { outcome } = await answered;
    const { response, granted } = acpPermissionAnswer(params, outcome);
    /* request.resolved echoes the grant actually sent — a downgraded pick
       surfaces instead of silently sticking (#133). A cancel that beat us
       here already emitted its own resolved frame; we emit only when the
       ask is still ours to close. */
    if (s.openRequests.delete(requestId))
      s.emit("request.resolved", { requestId, outcome: granted });
    if (s.state === "waiting" && s.openRequests.size === 0)
      s.setState("running");
    return response;
  }

  private sessionForAcp(acpSessionId: string): AcpSession | undefined {
    return [...this.sessions.values()].find(
      (x) => x.acpSessionId === acpSessionId,
    );
  }

  private async requestRespond(p: RequestRespondParams) {
    const s = this.require(p.sessionId);
    const ask = s.openRequests.get(p.requestId);
    if (!ask)
      throw new RpcError(
        RPC_ERRORS.REQUEST_NOT_FOUND,
        `no open request ${p.requestId}`,
      );
    if (ask.request.kind === "approval") {
      if (p.outcome === "answer")
        throw new RpcError(
          RPC_ERRORS.INVALID_PARAMS,
          "an approval takes once/session/always/deny/cancel, not answer",
        );
      if (
        p.outcome !== "cancel" &&
        !ask.request.options.includes(p.outcome as never)
      )
        throw new RpcError(
          RPC_ERRORS.INVALID_PARAMS,
          `outcome ${p.outcome} not in offered options`,
        );
    } else if (p.outcome !== "answer" && p.outcome !== "cancel") {
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        "a question takes answer or cancel",
      );
    }
    ask.settle({
      outcome: p.outcome,
      ...(p.answer ? { answer: p.answer } : {}),
    });
    return { accepted: true as const };
  }

  private onUpdate(params: acp.SessionNotification) {
    const s = this.sessionForAcp(params.sessionId);
    if (!s) return;
    /* `{type:"terminal"}` tool-call content resolves against the client
       terminals' buffers before the shared mapping sees it — the mapping
       itself stays terminal-agnostic (D-#845). */
    const t = this.opts.terminals;
    const notification = t
      ? resolveEmbeddedTerminalContent(params, t.readOutputSnapshot)
      : params;
    handleAcpUpdate(s, notification, {
      onSessionInfo: (sess, u) => {
        /* session_info_update carries the agent-computed title — the "llm"
           stage of #137's auto-title. */
        const title = (u as { title?: unknown }).title;
        if (typeof title === "string" && title)
          this.autoTitle(sess, "llm", title);
      },
      onModeUpdate: (sess, modeId) => {
        if (sess.modes) sess.modes.current = modeId;
      },
      /* The update carries the full configOptions array — refresh the
         session and engine catalogs from it. */
      onConfigUpdate: (sess, u) => {
        const list = (u as unknown as { configOptions?: unknown })
          .configOptions;
        if (Array.isArray(list))
          this.applyConfigOptions(sess, list as acp.SessionConfigOption[]);
      },
    });
  }

  // ── replay / lifecycle ─────────────────────────────────────────────────

  private async eventsSince(p: EventsSinceParams) {
    const s = this.require(p.sessionId);
    return s.eventsSince(p.after);
  }

  private async sessionStop(p: SessionStopParams) {
    const s = this.sessions.get(p.sessionId);
    if (!s)
      throw new RpcError(
        RPC_ERRORS.SESSION_NOT_FOUND,
        `no session ${p.sessionId}`,
      );
    if (s.state === "closed" && !s.suspended) return { stopped: false };
    cancelAllAcpAsks(s);
    const turn = s.turn;
    s.turn = undefined;
    const conn = this.conn;
    if (conn && s.acpSessionId) await conn.closeSession(s.acpSessionId);
    s.suspended = false;
    s.state = "closed";
    s.emit("session.state", { state: "closed" });
    if (turn) {
      s.emit("turn.completed", {
        turnId: turn.turnId,
        stopReason: "cancelled",
      });
    }
    /* D-#573: stop forgets — the session leaves the map, and every later
       call answers SESSION_NOT_FOUND like a never-seen one. */
    this.sessions.delete(s.id);
    return { stopped: true };
  }

  /**
   * #346 suspend: close the live ACP session (session/close when
   * advertised — the agent's processes die like session.stop) but keep the
   * LilOS record + log; the next prompt resumes it under the same id —
   * `session/load` when the agent advertised loadSession, a fresh
   * `session/new` otherwise (its transcript resets; the LilOS event log
   * still replays).
   */
  private async sessionSuspend(p: SessionSuspendParams) {
    const s = this.sessions.get(p.sessionId);
    if (!s)
      throw new RpcError(
        RPC_ERRORS.SESSION_NOT_FOUND,
        `no session ${p.sessionId}`,
      );
    if (s.suspended) return { suspended: true };
    if (s.state === "closed") return { suspended: false };
    cancelAllAcpAsks(s);
    const turn = s.turn;
    s.turn = undefined;
    const conn = this.conn;
    if (conn && s.acpSessionId) await conn.closeSession(s.acpSessionId);
    s.suspended = true;
    s.state = "closed";
    s.emit("session.state", { state: "closed", reason: "suspended" });
    if (turn) {
      s.emit("turn.completed", {
        turnId: turn.turnId,
        stopReason: "cancelled",
      });
    }
    return { suspended: true };
  }

  /**
   * A timed-out session create leaves its agent child running inside the
   * shared adapter (r7 nit — the harness's bind retries each spawned
   * another `claude`, up to 6 per stuck send). With no other live
   * sessions to protect, closing the connection reaps the whole tree;
   * with live sessions the conn's per-caller wedged-create guard
   * already fails that caller's retries fast (r8), so nothing stacks
   * behind the wedge — and healthy conversations keep creating.
   */
  private async reapWedgedCreate(
    conn: AcpConnection,
    error: unknown,
    self?: AcpSession,
  ) {
    if (!/did not answer session\/(new|load)/.test(String(error))) return;
    const live = [...this.sessions.values()].filter(
      (x) =>
        x !== self && x.acpSessionId && !x.suspended && x.state !== "closed",
    );
    if (live.length === 0 && !conn.hasLiveCreates() && this.conn === conn)
      await conn.close();
  }

  /** Reattach a suspended session — same LilOS id, live ACP session. */
  private async resume(s: AcpSession) {
    const conn = await this.connection();
    const caps = conn.agentCapabilities;
    /* The re-create must replay the shim's sessionMeta (D-#866): every
       session is born gated — one that came back without the meta would
       run under the user's settings default (bypassPermissions). */
    const meta = this.opts.sessionMeta?.({
      agent: s.agent,
      cwd: s.cwd,
      ...(s.access ? { access: s.access } : {}),
    });
    let res:
      | Pick<acp.NewSessionResponse, "configOptions" | "modes">
      | undefined;
    if (caps?.loadSession === true) {
      try {
        res = await conn.loadSession({
          sessionId: s.acpSessionId,
          cwd: s.cwd,
          mcpServers: [],
          ...(meta ? { meta } : {}),
        });
      } catch (e) {
        /* A dead session still resumes — fresh session/new below — but a
           WEDGED load surfaces: its child still runs in the adapter, and
           the conn's wedged-create guard would only fail the retry. */
        await this.reapWedgedCreate(conn, e, s);
        if (/did not answer session\/(new|load)/.test(String(e))) throw e;
      }
    }
    if (!res) {
      const created = await conn
        .newSession(
          {
            cwd: s.cwd,
            ...(meta ? { meta } : {}),
          },
          /* Same caller key the start used — this session's own
             retries still fail fast under a wedge. */
          { callerKey: s.callerKey },
        )
        .catch(async (e) => {
          await this.reapWedgedCreate(conn, e, s);
          throw e;
        });
      s.acpSessionId = created.sessionId;
      res = created;
    }
    this.learnSession(s, res);
    /* D-#846: a reloaded session may drop back to agent defaults — re-apply
       the pick the session took before it suspended. The binding already
       exists wherever resume runs, so skips can ride session.note. */
    if (s.pick)
      await this.applyPick(s, s.pick, (line) =>
        s.emit("session.note", { text: line }),
      );
    /* r8 nit: the adapter may have died between `session/load` and these
       writes — `onAdapterGone` skips still-suspended sessions, so marking
       this one live would leave it prompting a dead ACP id (the r6
       -32603 refusal shape). Keep it suspended: the next demand
       re-resumes on the fresh adapter and mints a live id. */
    if (conn.dead)
      throw new Error("agent adapter restarted while the session resumed");
    s.suspended = false;
    s.state = "idle";
    s.emit("session.started", {
      agent: s.agent,
      cwd: s.cwd,
      ...(s.model ? { model: s.model } : {}),
      ...(s.effort ? { effort: s.effort } : {}),
      ...(s.fast !== undefined ? { fast: s.fast } : {}),
    });
    s.setState("idle");
  }

  // ── models ─────────────────────────────────────────────────────────────

  private async modelsList(_p: ModelsListParams): Promise<ModelsListResult> {
    await this.connection();
    /* The probe carries the catalog for a fresh engine — wait for it (it
       is bounded + non-fatal, so a wedge resolves as an empty catalog,
       never a hang). */
    await this.catalogProbe;
    const models = catalogModels(this.catalog);
    const current = catalogModelOption(this.catalog)?.currentValue;
    return {
      models,
      ...(current && models.some((m) => m.id === current)
        ? { default: current }
        : {}),
    };
  }

  private async sessionSetModel(
    p: SessionSetModelParams,
  ): Promise<SessionSetModelResult> {
    const s = this.require(p.sessionId);
    if (s.suspended) await this.resume(s);
    const cfg = this.sessionConfig(s);
    const modelOpt = catalogModelOption(cfg);
    const effortOpt = catalogEffortOption(cfg);
    /* Validate the whole pick before any write — an unlisted value refuses
       outright (-32005) so a pick never half-lands (model applied, effort
       rejected). An OPTION the session never advertised is different: skip
       it with a note (D-#846) and answer the session's real state. */
    if (
      p.model !== undefined &&
      modelOpt &&
      !modelOpt.choices.some((c) => c.value === p.model)
    )
      throw new RpcError(
        RPC_ERRORS.MODEL_NOT_FOUND,
        `unknown model ${p.model}`,
      );
    if (
      p.effort !== undefined &&
      effortOpt &&
      !effortOpt.choices.some((c) => c.value === p.effort)
    )
      throw new RpcError(
        RPC_ERRORS.MODEL_NOT_FOUND,
        `unknown effort ${p.effort}`,
      );
    await this.applyPick(
      s,
      { model: p.model, effort: p.effort, fast: p.fast },
      (line) => s.emit("session.note", { text: line }),
    );
    return {
      model: s.model ?? p.model,
      ...(s.effort ? { effort: s.effort } : {}),
      ...(s.fast !== undefined ? { fast: s.fast } : {}),
    };
  }

  // ── session_meta ───────────────────────────────────────────────────────

  /**
   * #137 two-stage titling: "derived" fires once at the first turn start
   * (verbatim first line, engine-side — no ACP needed); "llm" upgrades
   * when the agent's session_info_update carries a title. A user-chosen
   * title (setTitle) outranks every later upgrade.
   */
  private autoTitle(s: AcpSession, stage: "derived" | "llm", text: string) {
    if (s.userTitle !== undefined) return;
    if (stage === "derived" && s.titledStage !== undefined) return;
    if (stage === "llm" && s.titledStage === "llm") return;
    const title = stage === "derived" ? derivedTitle(text) : text;
    if (!title) return;
    s.titledStage = stage;
    s.title = title;
    s.emit("session.titled", { title, source: stage });
  }

  private async sessionSetTitle(p: SessionSetTitleParams) {
    const s = this.require(p.sessionId);
    if (s.suspended) await this.resume(s);
    s.userTitle = p.title;
    s.title = p.title;
    return { title: p.title };
  }

  private async sessionSetHidden(p: SessionSetHiddenParams) {
    const s = this.require(p.sessionId);
    s.hidden = p.hidden;
    return { hidden: s.hidden };
  }
}

/** First text block's verbatim first line — the derived title seed. */
function firstText(content: Parameters<typeof toAcpContent>[0][]): string {
  const t = content.find(
    (b): b is { type: "text"; text: string } => b.type === "text",
  );
  return t?.text ?? "";
}

/** First full sentence — the shared derived-title rule (#886). */
const derivedTitle = autoTitle;

/** The non-fast value of a fast-tier config option (boolean "false", else
    the first choice that isn't the fast value). */
function offValue(fast: {
  option: EngineConfigOption;
  fastValue: string;
}): string {
  if (fast.option.type === "boolean") return "false";
  return (
    fast.option.choices.find((c) => c.value !== fast.fastValue)?.value ??
    fast.fastValue
  );
}
