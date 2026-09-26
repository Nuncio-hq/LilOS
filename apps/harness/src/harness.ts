import type { RelayClient } from "@lilos/client-runtime";
import type {
  AppChannel,
  AppMessage,
  Ask,
  Conversation,
  Employee,
  PendingTurn,
} from "@lilos/contracts/app";
import {
  AskResolvedEvent,
  ChannelCreatedEvent,
  TurnInterruptRequestedEvent,
} from "@lilos/contracts/app";
import type {
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
  /** User messages queued while a turn runs (delivered in order). */
  queue: AppMessage[];
}

export interface HarnessOptions {
  relay: RelayClient;
  sleep: SleepGuard;
  /** Working directory engine sessions run in (a project repo or a work dir). */
  workdir: string;
  log: Logger;
  /** Engine `session.start` params for an employee. */
  sessionParamsFor?: (employee: Employee | undefined) => {
    agent: string;
    model?: string;
  };
  /** Wake hook: a new user message while the engine is down asks the supervisor to self-heal. */
  onNeedEngine?: () => void;
}

const INVALID_STATE = -32003;
const REQUEST_NOT_FOUND = -32002;

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
  private readonly unsubs: Array<() => void> = [];

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
    const reg = await this.opts.relay.request<{
      hostId: string;
      pending: PendingTurn[];
    }>("harness.register", {});
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
    const started = await conn.request<{ sessionId: string }>(
      "session.start",
      this.sessionParams(employee),
    );
    this.unbind(binding);
    const rebound: SessionBinding = {
      ...binding,
      sessionId: started.sessionId,
      ref: started.sessionId,
      lastSeq: 0,
      runningTurnId: undefined,
      textByTurn: new Map(),
    };
    this.bindings.set(binding.conversationId, rebound);
    this.conversationBySession.set(started.sessionId, binding.conversationId);
    await this.updateConversation(binding.conversationId, {
      engineRef: started.sessionId,
      state: "active",
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
    try {
      // Turn lifecycle (`turn.started`/`turn.completed`) arrives as events
      // before the prompt call resolves — they alone own runningTurnId.
      // No RPC timeout: a turn can run for minutes; completion is an event,
      // and a socket drop still rejects this call.
      await conn.request<{ turnId: string }>(
        "prompt",
        {
          sessionId: binding.sessionId,
          content: [{ type: "text", text: message.text }],
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
    const started = await conn.request<{ sessionId: string }>(
      "session.start",
      this.sessionParams(employee),
    );
    const binding: SessionBinding = {
      conversationId: conv.id,
      channelId,
      sessionId: started.sessionId,
      ref: started.sessionId,
      lastSeq: 0,
      queue: [],
      textByTurn: new Map(),
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
    const convId = this.conversationBySession.get(event.sessionId);
    const binding = convId ? this.bindings.get(convId) : undefined;
    if (binding && event.seq > binding.lastSeq) binding.lastSeq = event.seq;
    switch (event.type) {
      case "turn.started":
        if (!binding) return;
        binding.runningTurnId = event.payload.turnId;
        binding.textByTurn.set(event.payload.turnId, "");
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
          binding.ref = event.payload.ref;
          void this.updateConversation(binding.conversationId, {
            engineRef: event.payload.ref,
          }).catch(() => {});
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
      default:
        break;
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

  /* --------------------------- turn completion -------------------------- */

  private async finishTurn(
    binding: SessionBinding,
    event: Extract<EngineEvent, { type: "turn.completed" }>,
  ) {
    const { turnId, stopReason } = event.payload;
    const text = binding.textByTurn.get(turnId) ?? "";
    binding.textByTurn.delete(turnId);
    binding.runningTurnId = undefined;
    this.opts.sleep.release();

    const employeeId = this.employeeIdFor(
      this.conversationFromAtom(binding.conversationId),
    );
    if (text.trim().length > 0 && employeeId) {
      await this.opts.relay
        .request("messages.post", {
          channelId: binding.channelId,
          conversationId: binding.conversationId,
          authorKind: "employee",
          authorId: employeeId,
          text: text.trim(),
        })
        .catch((error) =>
          this.opts.log.error("answer post failed", { error: String(error) }),
        );
    } else if (stopReason === "cancelled") {
      await this.postSystem(binding, "Stopped.");
    } else {
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

  private sessionParams(employee: Employee | undefined) {
    const base = this.opts.sessionParamsFor?.(employee) ?? {
      agent: employee?.profile || employee?.name || "default",
      ...(employee?.model ? { model: employee.model } : {}),
    };
    return { ...base, cwd: this.opts.workdir };
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
    // A conversation can land on the relay a tick after its first message.
    try {
      await this.opts.relay.request("conversations.list", {});
    } catch {
      // list refresh failure falls through to atom data
    }
    return this.opts.relay.conversations
      .get()
      .find((c) => c.id === conversationId);
  }

  private async updateConversation(
    conversationId: string,
    patch: { engineRef?: string; state?: "idle" | "active" | "closed" },
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
