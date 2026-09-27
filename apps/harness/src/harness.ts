import type { RelayClient } from "@lilos/client-runtime";
import type {
  AppChannel,
  AppMessage,
  Ask,
  AttachmentsGetResult,
  Conversation,
  Employee,
  PendingTurn,
} from "@lilos/contracts/app";
import {
  APP_PROTOCOL_VERSION,
  AskResolvedEvent,
  ChannelCreatedEvent,
  ChannelRemovedEvent,
  ConversationModelRequestedEvent,
  ENGINE_PASSTHROUGH_METHODS,
  TurnInterruptRequestedEvent,
} from "@lilos/contracts/app";
import type {
  AgentDescriptor,
  ContentBlock,
  DescribeResult,
  EngineEvent,
  EngineRequest,
  EventsSinceResult,
} from "@lilos/contracts/engine";
import type { EngineConnection } from "./engine/client";
import { engineErrorCode, SESSION_NOT_FOUND } from "./engine/client";
import type { EngineHostState } from "./engine/supervisor";
import type { Logger } from "./log";
import type { SleepGuard } from "./sleep";

/**
 * The workspace harness: the ONLY component that talks to the engine
 * (docs/DECISIONS D-#26). It connects to the relay, registers as the engine
 * host, binds each DM conversation to one engine session, forwards user
 * messages as prompts, surfaces engine asks (approvals/questions) on the
 * relay, posts final answers back, and holds the sleep assertion while a
 * turn runs.
 *
 * Engine-agnostic: everything goes through the engine protocol
 * (`@lilos/contracts/engine`); nothing Hermes-specific may live here.
 */

interface SessionBinding {
  conversationId: string;
  channelId: string;
  /** Transport handle used in engine calls (stable across ref rotations). */
  sessionId: string;
  /** Durable ref stored as the conversation's engineRef. */
  ref: string;
  /** Highest engine event seq applied — the `events.since` watermark. */
  lastSeq: number;
  /** Running turn, if any. */
  runningTurnId?: string;
  /** Buffered answer text per running turn. */
  textByTurn: Map<string, string>;
  /** `turn.started.model` per running turn — stamped on the answer message. */
  modelByTurn: Map<string, string>;
  /** User messages queued while a turn runs (delivered in order). */
  queue: AppMessage[];
}

export interface HarnessOptions {
  relay: RelayClient;
  sleep: SleepGuard;
  /** Working directory engine sessions run in (a project repo or a work dir). */
  workdir: string;
  log: Logger;
  /**
   * Engine `session.start` params for an employee. `agentId` is the
   * engine-side agent the harness hired via `agents.create` (D-#8) —
   * implementations should use it as `agent`.
   */
  sessionParamsFor?: (
    employee: Employee | undefined,
    agentId: string,
  ) => {
    agent: string;
    model?: string;
  };
  /** Wake hook: a new user message while the engine is down asks the supervisor to self-heal. */
  onNeedEngine?: () => void;
  /** Harness build version reported in `harness.register` (#33 handshake). */
  version?: string;
  /** Capability ids hidden from clients and skipped by the driver (dev/e2e). */
  hideCaps?: string[];
}

const INVALID_STATE = -32003;
const REQUEST_NOT_FOUND = -32002;
/** Tells the relay to answer the caller `engine_unavailable` (not error). */
const ENGINE_UNAVAILABLE = -32005;

export class Harness {
  private engine?: EngineConnection;
  private hostId?: string;
  private started = false;
  private readonly bindings = new Map<string, SessionBinding>(); // convId -> binding
  private readonly conversationBySession = new Map<string, string>(); // sessionId -> convId
  private readonly rebinds = new Map<string, Promise<void>>(); // convId -> in-flight rebind
  /** engine requestId -> relay ask id (per session). */
  private readonly askByRequest = new Map<string, string>();
  private readonly requestByAsk = new Map<
    string,
    { sessionId: string; requestId: string }
  >();
  private readonly delivered = new Set<string>(); // relay message ids claimed
  /** Messages that arrived while the engine was down; drained on attach. */
  private readonly early = new Map<string, AppMessage[]>();
  private readonly channelSeen = new Map<string, number>();
  private readonly channelWatch = new Map<string, () => void>(); // channelId -> store unsub
  private readonly unsubs: Array<() => void> = [];
  /** Latest `describe` result (hideCaps already filtered out). */
  private describeResult?: DescribeResult;
  /** Feed subscribers fan out every engine event to attached clients. */
  private readonly feedListeners = new Set<(event: EngineEvent) => void>();
  /** First-run auto-hire ran (or employees already existed). */
  private hired = false;

  /** Live engine sessions the harness owns (status reports this — #33). */
  get liveSessionCount(): number {
    return this.conversationBySession.size;
  }

  constructor(private readonly opts: HarnessOptions) {}

  /* ------------------------------- startup ------------------------------ */

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const welcome = await this.opts.relay.connect();
    this.opts.log.info("relay connected", {
      instanceId: welcome.instanceId,
      engineHost: welcome.engineHost,
    });
    this.unsubs.push(
      this.opts.relay.onEvent((m, p) => this.onRelayEvent(m, p)),
    );
    // App-side `agents.*`/`models.*` calls arrive as relay-forwarded
    // requests (ENGINE_PASSTHROUGH_METHODS); they run on the engine.
    this.opts.relay.setRequestHandler((m, p) => this.onRelayRequest(m, p));
    const reg = await this.opts.relay.request<{
      hostId: string;
      pending: PendingTurn[];
    }>("harness.register", {
      protocolVersion: APP_PROTOCOL_VERSION,
      version: this.opts.version ?? "0",
    });
    this.hostId = reg.hostId;
    this.opts.log.info("registered as engine host", {
      hostId: reg.hostId,
      pending: reg.pending.length,
    });
    for (const channel of this.opts.relay.channels.get()) {
      this.watchChannel(channel.id);
    }
    for (const turn of reg.pending) {
      void this.deliver(turn.message).catch((error) =>
        this.opts.log.error("pending turn delivery failed", {
          messageId: turn.message.id,
          error: String(error),
        }),
      );
    }
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubs.splice(0)) unsub();
    this.opts.relay.close();
    this.engine = undefined;
    this.opts.log.close();
  }

  /* --------------------------- engine wiring ---------------------------- */

  /** Supervisor calls this on every fresh connection (first + reconnect). */
  attachEngine(conn: EngineConnection): void {
    this.engine?.close();
    this.engine = conn;
    this.unsubs.push(conn.onEvent((e) => this.onEngineEvent(e)));
    void this.describeAndHire(conn).catch((error) =>
      this.opts.log.warn("describe/hire failed", { error: String(error) }),
    );
    // Resync every bound session: replay events past the watermark, re-open
    // asks, adopt a turn already running (harness restart mid-turn).
    // Messages held while the engine was down become turns now.
    for (const convId of this.early.keys()) {
      void this.flushEarly(convId).catch((error) =>
        this.opts.log.warn("early message flush failed", {
          conversationId: convId,
          error: String(error),
        }),
      );
    }
    for (const binding of this.bindings.values()) {
      void this.resyncBinding(binding).catch((error) =>
        this.opts.log.warn("session resync failed", {
          sessionId: binding.sessionId,
          error: String(error),
        }),
      );
    }
  }

  /** Supervisor state changes → relay `harness.report` (host heartbeat). */
  onEngineStateChange(state: EngineHostState, detail?: string): void {
    if (!this.hostId) return;
    this.opts.relay
      .request("harness.report", {
        engine: { state, ...(detail ? { detail } : {}) },
      })
      .catch((error) =>
        this.opts.log.warn("harness.report failed", { error: String(error) }),
      );
  }

  /* ---------------- client session feed (read-only) ---------------------- */

  /** Engine identity + capabilities as clients see them (hideCaps applied). */
  engineDescribe(): DescribeResult | undefined {
    return this.describeResult;
  }

  /** `events.since` passthrough — replay a session's event log for a client. */
  async eventsSince(
    sessionId: string,
    after: number,
  ): Promise<EventsSinceResult> {
    const conn = this.engine;
    if (!conn) throw new Error("engine not connected");
    return conn.request<EventsSinceResult>("events.since", {
      sessionId,
      after,
    });
  }

  /** Subscribe to every engine event the harness sees (feed fan-out). */
  subscribeEngineEvents(fn: (event: EngineEvent) => void): () => void {
    this.feedListeners.add(fn);
    return () => this.feedListeners.delete(fn);
  }

  private hasCapability(id: string): boolean {
    return this.describeResult?.capabilities.some((c) => c.id === id) ?? false;
  }

  /**
   * On (re)connect: cache `describe` (minus hidden capabilities) and hire the
   * `default` engine profile as the first employee when the roster is empty.
   */
  private async describeAndHire(conn: EngineConnection): Promise<void> {
    try {
      const d = await conn.request<DescribeResult>("describe", {});
      const hide = new Set(this.opts.hideCaps ?? []);
      this.describeResult = {
        ...d,
        capabilities: d.capabilities.filter((c) => !hide.has(c.id)),
      };
    } catch (error) {
      this.describeResult = undefined;
      this.opts.log.warn("engine describe failed", {
        error: String(error),
      });
    }
    if (this.hired) return;
    this.hired = true;
    try {
      // connect() is idempotent: no-op when already up, waits when the
      // engine attached before harness.start() finished the handshake.
      await this.opts.relay.connect();
      const { employees } = await this.opts.relay.request<{
        employees: Employee[];
      }>("employees.list", {});
      if (employees.length > 0) return;
      const { agents } = await conn.request<{ agents: AgentDescriptor[] }>(
        "agents.list",
        {},
      );
      const agent = agents.find((a) => a.id === "default") ?? agents[0];
      if (!agent) return;
      const created = await this.opts.relay.request<{ employee: Employee }>(
        "employees.create",
        {
          name: agent.name,
          role: agent.description ?? "",
          status: "online",
          profile: agent.id,
          // No `model` copy: the catalog entry is the engine's default, and a
          // pinned employee model would override operator-set engine model
          // flags (HERMES_MODEL / --model) on every session.
          ...(agent.soul ? { instructions: agent.soul } : {}),
        },
      );
      this.opts.log.info("hired first employee", {
        employeeId: created.employee.id,
        agent: agent.id,
      });
    } catch (error) {
      this.opts.log.warn("first-run hire failed", { error: String(error) });
    }
  }

  private async resyncBinding(binding: SessionBinding): Promise<void> {
    const conn = this.engine;
    if (!conn) return;
    try {
      const replay = await conn.request<EventsSinceResult>("events.since", {
        sessionId: binding.sessionId,
        after: binding.lastSeq,
      });
      this.applyReplay(binding, replay);
    } catch (error) {
      if (engineErrorCode(error) === SESSION_NOT_FOUND) {
        // Engine lost the session (fresh engine): rebind to a new one.
        await this.rebindConversation(binding);
        return;
      }
      throw error;
    }
  }

  private applyReplay(binding: SessionBinding, replay: EventsSinceResult) {
    // The turn we were running before the gap; if replay neither shows it
    // still running nor carries its turn.completed, it died silently.
    const watchedTurnId = binding.runningTurnId;
    if (replay.truncated) {
      this.opts.log.warn("engine event log truncated; state is lossy", {
        sessionId: binding.sessionId,
      });
    }
    binding.lastSeq = Math.max(binding.lastSeq, replay.latestSeq);
    if (replay.snapshot.turn) {
      binding.runningTurnId = replay.snapshot.turn.turnId;
    }
    for (const open of replay.openRequests) {
      void this.openAsk(
        binding,
        open.turnId,
        open.requestId,
        open.request,
      ).catch(() => {});
    }
    for (const event of replay.events) this.onEngineEvent(event);
    // AC-4: a turn that vanished across sleep/restart must end as
    // `interrupted` with Retry — never a spinner. Lost iff the replay shows
    // it neither still running nor terminated by a replayed turn.completed.
    const finishedInReplay = replay.events.some(
      (e) => e.type === "turn.completed" && e.payload.turnId === watchedTurnId,
    );
    if (
      watchedTurnId &&
      replay.snapshot.turn?.turnId !== watchedTurnId &&
      !finishedInReplay
    ) {
      void this.markTurnInterrupted(binding, watchedTurnId);
    }
  }

  /** End a turn that vanished across a gap — surface interrupted + Retry. */
  private async markTurnInterrupted(
    binding: SessionBinding,
    turnId: string,
  ): Promise<void> {
    // Only release the sleep hold/clear the slot when the lost turn still
    // owns it — a different adopted turn must keep its own hold.
    if (binding.runningTurnId === turnId) {
      binding.runningTurnId = undefined;
      binding.textByTurn.delete(turnId);
      this.opts.sleep.release();
      await this.updateConversation(binding.conversationId, {
        state: "idle",
      });
    }
    await this.postSystem(
      binding,
      "Turn interrupted — the Mac slept or the engine restarted. Retry.",
    );
  }

  /** One rebind at a time per conversation — resync and prompt-failure paths race here. */
  private rebindConversation(binding: SessionBinding): Promise<void> {
    const pending = this.rebinds.get(binding.conversationId);
    if (pending) return pending;
    const p = this.doRebindConversation(binding).finally(() =>
      this.rebinds.delete(binding.conversationId),
    );
    this.rebinds.set(binding.conversationId, p);
    return p;
  }

  private async doRebindConversation(binding: SessionBinding) {
    const conv = this.conversationFromAtom(binding.conversationId);
    const employee = await this.resolveEmployee(conv);
    const conn = this.engine;
    if (!conn) return;
    const agent = await this.ensureAgent(conn, employee);
    const started = await conn.request<{ sessionId: string; ref?: string }>(
      "session.start",
      this.sessionParams(employee, agent, conv),
    );
    // Session lost on the engine (fresh engine/orphan grace expired): a turn
    // that was running ended silently — surface interrupted + Retry (AC-4).
    if (binding.runningTurnId) {
      await this.markTurnInterrupted(binding, binding.runningTurnId);
    }
    this.unbind(binding);
    const rebound: SessionBinding = {
      ...binding,
      sessionId: started.sessionId,
      ref: started.ref ?? started.sessionId,
      lastSeq: 0,
      runningTurnId: undefined,
      textByTurn: new Map(),
      modelByTurn: new Map(),
    };
    this.bindings.set(binding.conversationId, rebound);
    this.conversationBySession.set(started.sessionId, binding.conversationId);
    // Idle, not active: a rebind with an empty queue has nothing running —
    // "active" would leave the conversation spinning forever. Requeued
    // messages flip it back to active via their own turn.started.
    await this.updateConversation(binding.conversationId, {
      engineRef: started.sessionId,
      state: "idle",
    });
    const queued = binding.queue.splice(0);
    for (const message of queued) this.enqueueOrPrompt(rebound, message);
  }

  /* ------------------------- message -> engine -------------------------- */

  private async deliver(message: AppMessage): Promise<void> {
    if (message.authorKind !== "user") return;
    if (!message.conversationId) return;
    if (this.delivered.has(message.id)) return;
    this.delivered.add(message.id);

    this.opts.log.info("user message", {
      conversationId: message.conversationId,
      messageId: message.id,
    });
    this.opts.onNeedEngine?.();
    const conv = await this.findConversation(message.conversationId);
    if (!conv || conv.archived || conv.state === "closed") {
      this.opts.log.warn("dropping message for unknown/closed conversation", {
        conversationId: message.conversationId,
      });
      return;
    }
    const binding = await this.bindingFor(conv, message.channelId);
    if (!binding) {
      // Engine still starting/restarting: hold the message; attachEngine
      // flushes this queue once a connection exists (the dedupe set above
      // would otherwise drop it forever).
      const waiting = this.early.get(conv.id) ?? [];
      waiting.push(message);
      this.early.set(conv.id, waiting);
      this.opts.log.debug("message held for engine", {
        conversationId: conv.id,
        waiting: waiting.length,
      });
      return;
    }
    this.enqueueOrPrompt(binding, message);
  }

  private async flushEarly(convId: string): Promise<void> {
    const waiting = this.early.get(convId);
    if (!waiting?.length) return;
    const conv = await this.findConversation(convId);
    if (!conv || conv.archived || conv.state === "closed") {
      this.early.delete(convId);
      return;
    }
    const binding = await this.bindingFor(conv, waiting[0]?.channelId ?? "");
    if (!binding) return; // engine went away again; next attach retries
    this.early.delete(convId);
    for (const message of waiting) this.enqueueOrPrompt(binding, message);
  }

  private enqueueOrPrompt(binding: SessionBinding, message: AppMessage) {
    if (binding.runningTurnId) {
      // Capability `steer` (#9): a mid-turn user message steers the running
      // turn; without it the message queues as the next prompt.
      const conn = this.engine;
      if (conn && this.hasCapability("steer")) {
        void conn
          .request<{ status: "steered" | "not_running" }>("session.steer", {
            sessionId: binding.sessionId,
            text: message.text,
          })
          .then((res) => {
            if (res.status !== "steered") binding.queue.push(message);
          })
          .catch((error) => {
            this.opts.log.warn("steer failed; queued instead", {
              error: String(error),
            });
            binding.queue.push(message);
          });
        return;
      }
      binding.queue.push(message);
      this.opts.log.debug("queued behind running turn", {
        conversationId: binding.conversationId,
        queued: binding.queue.length,
      });
      return;
    }
    void this.sendPrompt(binding, message);
  }

  private async sendPrompt(binding: SessionBinding, message: AppMessage) {
    const conn = this.engine;
    if (!conn) {
      binding.queue.push(message);
      return;
    }
    // Attachment bytes never ride the message row — the harness fetches each
    // ref via `attachments.get` and sends ACP-shaped image blocks (issue #31).
    const images: ContentBlock[] = [];
    for (const ref of message.attachments ?? []) {
      try {
        const stored = await this.opts.relay.request<AttachmentsGetResult>(
          "attachments.get",
          { id: ref.id },
        );
        images.push({
          type: "image",
          data: stored.dataBase64,
          mimeType: stored.attachment.mimeType,
        });
      } catch (error) {
        this.opts.log.error("attachment fetch failed", {
          attachmentId: ref.id,
          error: String(error),
        });
        await this.postSystem(
          binding,
          `Attachment "${ref.name || ref.id}" could not be loaded — sending the message without it.`,
        );
      }
    }
    const content: ContentBlock[] = [
      { type: "text", text: message.text },
      ...images,
    ];
    try {
      // Turn lifecycle (`turn.started`/`turn.completed`) arrives as events
      // before the prompt call resolves — they alone own runningTurnId.
      // No RPC timeout: a turn can run for minutes; completion is an event,
      // and a socket drop still rejects this call.
      await conn.request<{ turnId: string }>(
        "prompt",
        {
          sessionId: binding.sessionId,
          content,
        },
        0,
      );
    } catch (error) {
      if (engineErrorCode(error) === INVALID_STATE) {
        binding.queue.push(message);
        return;
      }
      if (engineErrorCode(error) === SESSION_NOT_FOUND) {
        binding.queue.unshift(message);
        await this.rebindConversation(binding);
        return;
      }
      this.opts.log.error("prompt failed", {
        conversationId: binding.conversationId,
        error: String(error),
      });
      await this.postSystem(
        binding,
        `Engine error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async bindingFor(
    conv: Conversation,
    channelId: string,
  ): Promise<SessionBinding | undefined> {
    const existing = this.bindings.get(conv.id);
    if (existing) return existing;
    const conn = this.engine;
    if (!conn) return undefined;

    // Reattach path: harness restarted while the engine kept the session
    // (orphan grace, #22) — the stored engineRef still resolves on the engine.
    if (conv.engineRef) {
      try {
        const replay = await conn.request<EventsSinceResult>("events.since", {
          sessionId: conv.engineRef,
          after: 0,
        });
        const binding: SessionBinding = {
          conversationId: conv.id,
          channelId,
          sessionId: conv.engineRef,
          ref: conv.engineRef,
          lastSeq: 0,
          queue: [],
          textByTurn: new Map(),
          modelByTurn: new Map(),
        };
        this.bindings.set(conv.id, binding);
        this.conversationBySession.set(conv.engineRef, conv.id);
        this.applyReplay(binding, replay);
        return binding;
      } catch (error) {
        if (engineErrorCode(error) !== SESSION_NOT_FOUND) throw error;
      }
    }

    const employee = await this.resolveEmployee(conv);
    const agent = await this.ensureAgent(conn, employee);
    const started = await conn.request<{ sessionId: string; ref?: string }>(
      "session.start",
      this.sessionParams(employee, agent, conv),
    );
    const binding: SessionBinding = {
      conversationId: conv.id,
      channelId,
      sessionId: started.sessionId,
      ref: started.ref ?? started.sessionId,
      lastSeq: 0,
      queue: [],
      textByTurn: new Map(),
      modelByTurn: new Map(),
    };
    this.bindings.set(conv.id, binding);
    this.conversationBySession.set(started.sessionId, conv.id);
    await this.updateConversation(conv.id, {
      engineRef: started.sessionId,
      state: "active",
    });
    return binding;
  }

  /* ------------------------- engine -> relay ---------------------------- */

  private onEngineEvent(event: EngineEvent) {
    for (const fn of this.feedListeners) {
      try {
        fn(event);
      } catch {
        // a feed subscriber must never break event dispatch
      }
    }
    const convId = this.conversationBySession.get(event.sessionId);
    const binding = convId ? this.bindings.get(convId) : undefined;
    if (binding && event.seq > binding.lastSeq) binding.lastSeq = event.seq;
    switch (event.type) {
      case "turn.started":
        if (!binding) return;
        binding.runningTurnId = event.payload.turnId;
        binding.textByTurn.set(event.payload.turnId, "");
        if (event.payload.model) {
          binding.modelByTurn.set(event.payload.turnId, event.payload.model);
        }
        this.opts.sleep.acquire();
        this.updateConversation(binding.conversationId, {
          state: "active",
        }).catch(() => {});
        break;
      case "turn.delta":
        if (binding && event.payload.stream === "text") {
          binding.textByTurn.set(
            event.payload.turnId,
            (binding.textByTurn.get(event.payload.turnId) ?? "") +
              event.payload.delta,
          );
        }
        break;
      case "tool.started":
        if (binding) {
          void this.postSystem(
            binding,
            `⚙ ${event.payload.tool}${toolHint(event.payload.input)}`,
          );
        }
        break;
      case "request.opened":
        if (binding) {
          void this.openAsk(
            binding,
            event.payload.turnId,
            event.payload.requestId,
            event.payload.request,
          ).catch((error) =>
            this.opts.log.error("asks.open failed", { error: String(error) }),
          );
        }
        break;
      case "request.resolved":
        void this.onEngineRequestResolved(
          event.sessionId,
          event.payload.requestId,
          event.payload.outcome,
          event.payload.answer,
        );
        break;
      case "session.ref.changed":
        if (binding) {
          // Keep the rotated runtime ref on the binding only. The
          // conversation's engineRef stays the stable engine session id —
          // clients resolve it through the feed (`events.since`, live
          // `event.sessionId`), which never sees runtime refs.
          binding.ref = event.payload.ref;
          this.opts.log.info("session ref rotated", {
            sessionId: event.sessionId,
            ref: event.payload.ref,
          });
        }
        break;
      case "turn.completed":
        if (binding) void this.finishTurn(binding, event);
        break;
      default:
        break;
    }
  }

  private async openAsk(
    binding: SessionBinding,
    turnId: string,
    requestId: string,
    request: EngineRequest,
  ): Promise<void> {
    const key = `${binding.sessionId}:${requestId}`;
    const result = await this.opts.relay.request<{ ask: Ask }>("asks.open", {
      channelId: binding.channelId,
      conversationId: binding.conversationId,
      turnId,
      requestId,
      request,
    });
    this.askByRequest.set(key, result.ask.id);
    this.requestByAsk.set(result.ask.id, {
      sessionId: binding.sessionId,
      requestId,
    });
  }

  /** Engine resolved an ask itself (cancel/steer) → close the relay ask. */
  private async onEngineRequestResolved(
    sessionId: string,
    requestId: string,
    outcome: string,
    answer?: string,
  ) {
    const askId = this.askByRequest.get(`${sessionId}:${requestId}`);
    this.askByRequest.delete(`${sessionId}:${requestId}`);
    if (!askId) return;
    this.requestByAsk.delete(askId);
    await this.opts.relay
      .request("asks.respond", {
        askId,
        outcome,
        ...(answer ? { answer } : {}),
      })
      .catch((error) =>
        this.opts.log.warn("asks.respond (engine-resolved) failed", {
          error: String(error),
        }),
      );
  }

  /* --------------------------- relay -> engine -------------------------- */

  /** Relay notifications that have no atom (asks, interrupts, channel lifecycle). */
  onRelayEvent(method: string, params: Record<string, unknown>) {
    switch (method) {
      case "channel.created": {
        const parsed = ChannelCreatedEvent.safeParse(params);
        if (parsed.success) this.watchChannel(parsed.data.channel.id);
        break;
      }
      case "channel.removed": {
        const parsed = ChannelRemovedEvent.safeParse(params);
        if (parsed.success) void this.onChannelRemoved(parsed.data.channelId);
        break;
      }
      case "ask.resolved": {
        const parsed = AskResolvedEvent.safeParse(params);
        if (parsed.success) void this.onAskResolved(parsed.data.ask);
        break;
      }
      case "turn.interruptRequested": {
        const parsed = TurnInterruptRequestedEvent.safeParse(params);
        if (parsed.success) {
          void this.onInterruptRequested(parsed.data.conversationId);
        }
        break;
      }
      case "conversation.modelRequested": {
        const parsed = ConversationModelRequestedEvent.safeParse(params);
        if (parsed.success) {
          void this.onModelRequested(
            parsed.data.conversationId,
            parsed.data.model,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * The relay asks the harness to answer engine calls on its behalf
   * (harness = the only engine talker, D-#26). Only the declared passthrough
   * set is honored; anything else is a JSON-RPC method-not-found.
   */
  private onRelayRequest(method: string, params: Record<string, unknown>) {
    if (!(ENGINE_PASSTHROUGH_METHODS as readonly string[]).includes(method)) {
      throw Object.assign(new Error(`harness does not answer ${method}`), {
        code: -32601,
      });
    }
    const conn = this.engine;
    if (!conn) {
      throw Object.assign(new Error("engine not connected"), {
        code: ENGINE_UNAVAILABLE,
      });
    }
    return conn.request(method, params);
  }

  /**
   * `channel.removed` (an employee was removed): stop the bound engine
   * session, drop bindings, queued early messages, asks and the watch.
   */
  private async onChannelRemoved(channelId: string) {
    this.channelWatch.get(channelId)?.();
    this.channelWatch.delete(channelId);
    this.channelSeen.delete(channelId);
    const conn = this.engine;
    for (const binding of [...this.bindings.values()]) {
      if (binding.channelId !== channelId) continue;
      this.unbind(binding);
      this.early.delete(binding.conversationId);
      for (const key of [...this.askByRequest.keys()]) {
        if (key.startsWith(`${binding.sessionId}:`)) {
          const askId = this.askByRequest.get(key);
          this.askByRequest.delete(key);
          if (askId) this.requestByAsk.delete(askId);
        }
      }
      if (conn) {
        try {
          await conn.request("session.stop", { sessionId: binding.sessionId });
        } catch (error) {
          this.opts.log.warn("session.stop on removed channel failed", {
            sessionId: binding.sessionId,
            error: String(error),
          });
        }
      }
    }
  }

  private watchChannel(channelId: string) {
    if (this.channelSeen.has(channelId)) return;
    this.channelSeen.set(channelId, 0);
    const store = this.opts.relay.channelMessages(channelId);
    const unsub = store.subscribe((state) => {
      const seen = this.channelSeen.get(channelId) ?? 0;
      const fresh = state.messages.filter((m) => m.seq > seen);
      if (fresh.length === 0) return;
      this.channelSeen.set(channelId, Math.max(...fresh.map((m) => m.seq)));
      for (const message of fresh) {
        void this.deliver(message).catch((error) =>
          this.opts.log.error("delivery failed", {
            messageId: message.id,
            error: String(error),
          }),
        );
      }
    });
    this.channelWatch.set(channelId, unsub);
    this.unsubs.push(unsub);
  }

  private async onAskResolved(ask: Ask) {
    const rec = this.requestByAsk.get(ask.id);
    if (!rec) return; // resolved engine-side already
    this.requestByAsk.delete(ask.id);
    this.askByRequest.delete(`${rec.sessionId}:${rec.requestId}`);
    const conn = this.engine;
    if (!conn) return;
    try {
      await conn.request("request.respond", {
        sessionId: rec.sessionId,
        requestId: rec.requestId,
        outcome: ask.outcome,
        ...(ask.answer ? { answer: ask.answer } : {}),
      });
    } catch (error) {
      if (engineErrorCode(error) !== REQUEST_NOT_FOUND) throw error;
      this.opts.log.warn("engine request already gone", {
        requestId: rec.requestId,
      });
    }
  }

  private async onInterruptRequested(conversationId: string) {
    const binding = this.bindings.get(conversationId);
    const conn = this.engine;
    if (!binding || !conn) return;
    this.opts.log.info("interrupt requested", { conversationId });
    try {
      await conn.request("interrupt", { sessionId: binding.sessionId });
    } catch (error) {
      this.opts.log.warn("interrupt failed", { error: String(error) });
    }
  }

  /**
   * Model pick (#30): `conversations.setModel` lands here. With a bound
   * engine session the engine acks first (its canonical id is what the
   * conversation stores); without one the pin rides on the conversation and
   * `session.start` picks it up via `sessionParams`.
   */
  private async onModelRequested(conversationId: string, model: string) {
    const binding = this.bindings.get(conversationId);
    const conn = this.engine;
    let pinned = model;
    if (binding && conn) {
      try {
        const ack = await conn.request<{ model: string }>("session.setModel", {
          sessionId: binding.sessionId,
          model,
        });
        pinned = ack.model;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.opts.log.warn("session.setModel failed", {
          conversationId,
          error: detail,
        });
        await this.postSystem(
          binding,
          `Couldn't switch to ${model}: ${detail}`,
        );
        return;
      }
    }
    await this.updateConversation(conversationId, { model: pinned }).catch(
      (error) =>
        this.opts.log.warn("conversation model update failed", {
          conversationId,
          error: String(error),
        }),
    );
  }

  /* --------------------------- turn completion -------------------------- */

  private async finishTurn(
    binding: SessionBinding,
    event: Extract<EngineEvent, { type: "turn.completed" }>,
  ) {
    const { turnId, stopReason } = event.payload;
    const text = binding.textByTurn.get(turnId) ?? "";
    const model = binding.modelByTurn.get(turnId);
    binding.textByTurn.delete(turnId);
    binding.modelByTurn.delete(turnId);
    binding.runningTurnId = undefined;
    this.opts.sleep.release();

    const employeeId = this.employeeIdFor(
      this.conversationFromAtom(binding.conversationId),
    );
    const hasAnswer = text.trim().length > 0 && !!employeeId;
    if (hasAnswer) {
      await this.opts.relay
        .request("messages.post", {
          channelId: binding.channelId,
          conversationId: binding.conversationId,
          authorKind: "employee",
          authorId: employeeId,
          text: text.trim(),
          ...(model ? { model } : {}),
        })
        .catch((error) =>
          this.opts.log.error("answer post failed", { error: String(error) }),
        );
    }
    // An errored turn must leave a trace even when text streamed before it —
    // in-view conversations never notify, so this is the only failure signal.
    if (event.payload.error) {
      await this.postSystem(binding, `Error: ${event.payload.error}`);
    } else if (!hasAnswer && stopReason === "cancelled") {
      await this.postSystem(binding, "Stopped.");
    } else if (!hasAnswer) {
      await this.postSystem(binding, "(the engine ended the turn silently)");
    }
    this.updateConversation(binding.conversationId, { state: "idle" }).catch(
      () => {},
    );

    const next = binding.queue.shift();
    if (next) void this.sendPrompt(binding, next);
  }

  private unbind(binding: SessionBinding) {
    this.conversationBySession.delete(binding.sessionId);
    this.bindings.delete(binding.conversationId);
  }

  /* ------------------------------- helpers ------------------------------ */

  /**
   * The `agents` capability (D-#8): `session.start.agent` must be an
   * engine-registered agent id, so the harness hires the LilOS employee onto
   * the engine — `agents.list` for an existing profile, `agents.create`
   * otherwise. Engines without the capability (the method errors) take the
   * employee name verbatim.
   */
  private async ensureAgent(
    conn: EngineConnection,
    employee: Employee | undefined,
  ): Promise<string> {
    // `profile` is the employee's engine-agent handle; name is the fallback.
    const preferred = employee?.profile || employee?.name || "default";
    const want = preferred.toLowerCase();
    try {
      const list = async () =>
        (await conn.request<{ agents: AgentDescriptor[] }>("agents.list", {}))
          .agents;
      // Engines may normalize agent ids (Hermes lowercases profile names),
      // so match case-insensitively and always send back the engine's id.
      const match = (agents: AgentDescriptor[]) =>
        agents.find(
          (a) =>
            a.id === preferred ||
            a.id.toLowerCase() === want ||
            a.id === employee?.id ||
            a.name.toLowerCase() === want,
        );
      const agents = await list();
      const found = match(agents);
      if (found) return found.id;
      // Hire under the engine's default agent when it reports one — Hermes
      // clones that profile (config, providers, skills) so the employee can
      // actually run; engines ignoring `detail` are unaffected.
      const cloneFrom =
        agents.find((a) => a.detail?.isDefault === true)?.id ?? undefined;
      const create = (model?: string) =>
        conn.request<{ agent: AgentDescriptor }>("agents.create", {
          name: preferred,
          ...(employee?.instructions ? { soul: employee.instructions } : {}),
          ...(model ? { model } : {}),
          ...(cloneFrom ? { detail: { clone_from: cloneFrom } } : {}),
        });
      try {
        return (await create(employee?.model || undefined)).agent.id;
      } catch {
        // The create may have partially succeeded (profile created but the
        // response lookup failed on a normalized id) or raced — re-list
        // before retrying unpinned.
        const retry = match(await list());
        if (retry) return retry.id;
        return (await create()).agent.id;
      }
    } catch (error) {
      this.opts.log.debug(
        "agents capability unavailable; using employee name",
        { error: String(error) },
      );
      return preferred;
    }
  }

  private sessionParams(
    employee: Employee | undefined,
    agentId: string,
    conv?: Conversation,
  ) {
    const base = this.opts.sessionParamsFor?.(employee, agentId) ?? {
      agent: agentId,
      ...(employee?.model ? { model: employee.model } : {}),
    };
    // A model pinned on the conversation (#30) wins over the profile default.
    const model = conv?.model ?? base.model;
    return { ...base, ...(model ? { model } : {}), cwd: this.opts.workdir };
  }

  private employeeIdFor(conv: Conversation | undefined) {
    if (!conv) return undefined;
    const channel: AppChannel | undefined = this.opts.relay.channels
      .get()
      .find((c) => c.id === conv.channelId);
    return channel?.employeeId;
  }

  private async resolveEmployee(
    conv: Conversation | undefined,
  ): Promise<Employee | undefined> {
    const employeeId = this.employeeIdFor(conv);
    if (!employeeId) return undefined;
    const cached = this.opts.relay.employees
      .get()
      .find((e) => e.id === employeeId);
    if (cached) return cached;
    // Employees created after the harness connected are not in the atom.
    try {
      const { employees } = await this.opts.relay.request<{
        employees: Employee[];
      }>("employees.list", {});
      return employees.find((e) => e.id === employeeId);
    } catch {
      return undefined;
    }
  }

  private conversationFromAtom(
    conversationId: string,
  ): Conversation | undefined {
    return this.opts.relay.conversations
      .get()
      .find((c) => c.id === conversationId);
  }

  private async findConversation(
    conversationId: string,
  ): Promise<Conversation | undefined> {
    const found = this.conversationFromAtom(conversationId);
    if (found) return found;
    // conversation.updated is a live-only emit; a subscribe that lands after
    // the open races it away — so query the relay directly instead of only
    // trusting the atom. (AC-2/AC-4: first DM on a fresh channel, or events
    // missed while asleep, must still bind.)
    try {
      const listed = await this.opts.relay.request<{
        conversations: Conversation[];
      }>("conversations.list", {});
      const hit = listed.conversations.find((c) => c.id === conversationId);
      if (hit) return hit;
    } catch {
      return undefined;
    }
  }

  private async updateConversation(
    conversationId: string,
    patch: {
      engineRef?: string;
      state?: "idle" | "active" | "closed";
      model?: string;
    },
  ) {
    await this.opts.relay.request("conversations.update", {
      conversationId,
      ...patch,
    });
  }

  private async postSystem(binding: SessionBinding, text: string) {
    await this.opts.relay
      .request("messages.post", {
        channelId: binding.channelId,
        conversationId: binding.conversationId,
        authorKind: "system",
        text,
      })
      .catch((error) =>
        this.opts.log.warn("system post failed", { error: String(error) }),
      );
  }
}

const toolHint = (input: unknown): string => {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  const hint =
    record.command ?? record.path ?? record.file ?? record.name ?? "";
  return typeof hint === "string" && hint ? ` — ${hint.slice(0, 80)}` : "";
};
