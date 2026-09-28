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
  ConversationUpdatedEvent,
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
import { type CheckpointStore, collapsePath, expandPath } from "@lilos/host";
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
  /** Folder the session works in — the checkpoint store's work tree (#134). */
  cwd: string;
  /** Highest engine event seq applied — the `events.since` watermark. */
  lastSeq: number;
  /** Running turn, if any. */
  runningTurnId?: string;
  /** Buffered answer text per running turn. */
  textByTurn: Map<string, string>;
  /** The `turn.started` pick per running turn — stamped on the answer (#92). */
  pickByTurn: Map<
    string,
    { model?: string; provider?: string; effort?: string; fast?: boolean }
  >;
  /** User messages queued while a turn runs (delivered in order). */
  queue: AppMessage[];
  /** Relay message ids the engine consumed (replayed `turn.started.ref`). */
  consumed: Set<string>;
  /** turnId -> relay message id that prompted it — the answer's dedupe key. */
  turnSource: Map<string, string>;
  /** Latest pick made while a turn runs — applied to the idle session
      before the next prompt goes out (#92). */
  heldPick?: ModelPick;
  /** The conversation's pick before `heldPick`'s intent was written —
      restored when the held apply fails so a dead pick can't linger. */
  heldPickPrev?: ConversationPickPatch;
}

/** A pick as the app sends it (#92): `{provider?, id}` plus its legs. */
type ModelPick = {
  model: string;
  provider?: string;
  effort?: string;
  fast?: boolean;
};

/** Pick fields as the conversation row stores them — `null` clears. */
type ConversationPickPatch = {
  model?: string | null;
  provider?: string | null;
  effort?: string | null;
  fast?: boolean | null;
};

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
    provider?: string;
    effort?: string;
    fast?: boolean;
  };
  /** Wake hook: a new user message while the engine is down asks the supervisor to self-heal. */
  onNeedEngine?: () => void;
  /** Harness build version reported in `harness.register` (#33 handshake). */
  version?: string;
  /** Capability ids hidden from clients and skipped by the driver (dev/e2e). */
  hideCaps?: string[];
  /**
   * Harness-owned folder checkpoints (#134): a shadow git store snapshotted
   * before each turn and restored by `conversations.rewind`. Optional so
   * unit fixtures can skip it — the real harness always has one.
   */
  checkpoints?: CheckpointStore;
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
  private readonly modelPickQueue = new Map<string, Promise<void>>();
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
  /**
   * FIFO of relay writes made while the socket was down — flushed in order
   * after every `harness.register`, BEFORE pending turns are re-delivered,
   * so a queued answer lands before its conversation looks pending (#28).
   */
  private readonly outbox: {
    label: string;
    run: () => Promise<unknown>;
  }[] = [];
  private flushingOutbox = false;
  private registering = false;
  private registerAgain = false;
  /** Last relay-side title/archive seen per conversation (meta mirror diff). */
  private readonly metaSeen = new Map<
    string,
    { title: string; archived: boolean }
  >();
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
    this.unsubs.push(
      this.opts.relay.onEvent((m, p) => this.onRelayEvent(m, p)),
    );
    // App-side `agents.*`/`models.*` calls arrive as relay-forwarded
    // requests (ENGINE_PASSTHROUGH_METHODS); they run on the engine.
    this.opts.relay.setRequestHandler((m, p) => this.onRelayRequest(m, p));
    // Every relay "ready" (first connect AND every reconnect) re-registers:
    // a new socket is a new peer, so the host slot must be reclaimed before
    // host-gated writes (answers, asks, watermarks) are accepted again.
    this.unsubs.push(
      this.opts.relay.state.listen((state) => {
        if (state === "ready") void this.onRelayReady();
      }),
    );
    const welcome = await this.opts.relay.connect();
    this.opts.log.info("relay connected", {
      instanceId: welcome.instanceId,
      engineHost: welcome.engineHost,
    });
  }

  private async onRelayReady(): Promise<void> {
    if (!this.started) return;
    if (this.registering) {
      this.registerAgain = true;
      return;
    }
    this.registering = true;
    try {
      do {
        this.registerAgain = false;
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
        // Queued writes land before any re-delivery: a pending turn whose
        // answer was in flight flushes first, and the watermark makes the
        // already-prompted tail ineligible a second time.
        await this.flushOutbox();
        await this.reconcileAsks();
        for (const channel of this.opts.relay.channels.get()) {
          this.watchChannel(channel.id);
        }
        for (const turn of reg.pending) {
          for (const message of turn.messages ?? [turn.message]) {
            void this.deliver(message).catch((error) =>
              this.opts.log.error("pending turn delivery failed", {
                messageId: message.id,
                error: String(error),
              }),
            );
          }
        }
      } while (this.registerAgain);
    } finally {
      this.registering = false;
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

  /**
   * One relay write. Transient failures (socket down/timeout) queue into the
   * outbox and replay in order on the next registration; permanent failures
   * (not_found/forbidden) are dropped with a log.
   */
  private relayWrite(label: string, run: () => Promise<unknown>): void {
    if (this.outbox.length > 0) {
      // Keep FIFO order: never overtake a queued write.
      this.outbox.push({ label, run });
      return;
    }
    void run().catch((error) => {
      if (isTransientRelayError(error)) {
        this.outbox.push({ label, run });
      } else {
        this.opts.log.warn(`${label} dropped`, { error: String(error) });
      }
    });
  }

  private async flushOutbox(): Promise<void> {
    if (this.flushingOutbox) return;
    this.flushingOutbox = true;
    try {
      while (this.outbox.length > 0) {
        const entry = this.outbox[0];
        try {
          await entry.run();
          this.outbox.shift();
        } catch (error) {
          if (!isTransientRelayError(error)) {
            this.opts.log.warn(`${entry.label} dropped on retry`, {
              error: String(error),
            });
            this.outbox.shift();
            continue;
          }
          break; // socket down again — retry on the next register
        }
      }
    } finally {
      this.flushingOutbox = false;
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
      pickByTurn: new Map(),
      /* A held pick already sits on the conversation row — the new session
         starts on it via `sessionParams`; nothing left to apply. */
      heldPick: undefined,
      heldPickPrev: undefined,
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
    this.mirrorMeta(rebound, conv);
  }

  /**
   * Best-effort mirror of the app's title/archive onto the engine session
   * (capability `session_meta`, #28 AC-3). Engines without it keep working —
   * the relay record is the source of truth either way.
   */
  private mirrorMeta(
    binding: SessionBinding,
    conv: { title: string; archived: boolean } | undefined,
  ): void {
    if (!conv) return;
    const seen = this.metaSeen.get(binding.conversationId);
    this.metaSeen.set(binding.conversationId, {
      title: conv.title,
      archived: conv.archived,
    });
    const conn = this.engine;
    if (!conn || !this.hasCapability("session_meta")) return;
    if (conv.title && (!seen || seen.title !== conv.title)) {
      void conn
        .request("session.setTitle", {
          sessionId: binding.sessionId,
          title: conv.title,
        })
        .catch((error) =>
          this.opts.log.warn("session.setTitle failed", {
            error: String(error),
          }),
        );
    }
    if (!seen || seen.archived !== conv.archived) {
      void conn
        .request("session.setHidden", {
          sessionId: binding.sessionId,
          hidden: conv.archived,
        })
        .catch((error) =>
          this.opts.log.warn("session.setHidden failed", {
            error: String(error),
          }),
        );
    }
  }

  /* ------------------------- message -> engine -------------------------- */

  private async deliver(message: AppMessage): Promise<void> {
    if (message.authorKind !== "user") return;
    if (!message.conversationId) return;
    if (this.delivered.has(message.id)) return;

    this.opts.log.info("user message", {
      conversationId: message.conversationId,
      messageId: message.id,
    });
    this.opts.onNeedEngine?.();
    const conv = await this.findConversation(message.conversationId);
    // Lookup failed (relay flapped mid-RPC): leave `delivered` unset so the
    // register-time pending list can redeliver the message later.
    if (!conv) return;
    if (conv.archived || conv.state === "closed") {
      this.opts.log.warn("dropping message for unknown/closed conversation", {
        conversationId: message.conversationId,
      });
      return;
    }
    this.delivered.add(message.id);
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
    // Watermark guard: a redelivery (register pending list, channel replay)
    // of a message the engine already took must not prompt it again.
    const fresh = this.conversationFromAtom(conv.id) ?? conv;
    if (message.seq <= fresh.deliveredSeq || binding.consumed.has(message.id)) {
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
    // In-flight guard: replayed `turn.started` refs populate `consumed`, and
    // claiming the id here means a message can't be prompted twice even when
    // two delivery paths (register pending + channel replay) race before the
    // first turn.started lands. The queue-drain path bypasses this by design:
    // entries here failed or steered out, so a fresh send is the point.
    if (binding.consumed.has(message.id)) return;
    binding.consumed.add(message.id);
    if (binding.runningTurnId) {
      // Capability `steer` (#9): a mid-turn user message steers the running
      // turn; without it the message queues as the next prompt.
      // `session.steer` carries text only — a mid-turn message with
      // attachments queues so its image blocks go out through sendPrompt
      // instead of being silently dropped (#112). So does a message while a
      // pick is held: the pick applies before the next prompt, so the
      // message runs as that next prompt on the new model instead of
      // steering the old turn (#92).
      const conn = this.engine;
      if (
        conn &&
        this.hasCapability("steer") &&
        !message.attachments?.length &&
        !binding.heldPick
      ) {
        void this.stampCheckpoint(binding, message)
          .then(() =>
            conn.request<{ status: "steered" | "not_running" }>(
              "session.steer",
              {
                sessionId: binding.sessionId,
                text: message.text,
              },
            ),
          )
          .then((res) => {
            if (res.status === "steered") {
              this.markDelivered(binding, message);
            } else {
              binding.consumed.delete(message.id);
              binding.queue.push(message);
            }
          })
          .catch((error) => {
            this.opts.log.warn("steer failed; queued instead", {
              error: String(error),
            });
            binding.consumed.delete(message.id);
            binding.queue.push(message);
          });
        return;
      }
      binding.consumed.delete(message.id);
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
      binding.consumed.delete(message.id);
      binding.queue.push(message);
      return;
    }
    // A pick held while the last turn ran lands now, before this prompt —
    // the session is idle so setModel applies straight away (#92).
    await this.applyHeldPick(binding);
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
    // Text block only when there is text — an image-only message prompts
    // with just image blocks rather than an empty text block (#112).
    const content: ContentBlock[] = message.text
      ? [{ type: "text", text: message.text }, ...images]
      : images;
    if (!content.length) {
      // Every attachment failed to load and no text was typed — nothing to
      // send; the postSystem notes above already told the user.
      this.markDelivered(binding, message);
      return;
    }
    /* #134: snapshot the session folder BEFORE the turn so a later
       "Rewind to here" on this message can restore it. */
    await this.stampCheckpoint(binding, message);
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
          // The relay message id rides to the engine and back on
          // `turn.started` — that's what makes a replayed turn prove which
          // user message it consumed, and what its answer dedupes under.
          ref: message.id,
        },
        0,
      );
      this.markDelivered(binding, message);
    } catch (error) {
      // Going back on the queue releases the in-flight claim — a rebind
      // drains the queue through enqueueOrPrompt, which dedupes on it.
      if (engineErrorCode(error) === undefined) {
        // Transport failure (socket dropped / engine died mid-prompt): the
        // engine may still have taken the turn — its replayed
        // `turn.started.ref` reclaims the message on resync, and the answer
        // dedupes on the same key either way.
        binding.consumed.delete(message.id);
        binding.queue.unshift(message);
        return;
      }
      if (engineErrorCode(error) === INVALID_STATE) {
        binding.consumed.delete(message.id);
        binding.queue.push(message);
        return;
      }
      if (engineErrorCode(error) === SESSION_NOT_FOUND) {
        binding.consumed.delete(message.id);
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
        `sys:${binding.conversationId}:${message.id}:engine-error`,
      );
    }
  }

  /**
   * #134: snapshot the session folder into the shadow-git checkpoint store
   * and stamp the checkpoint id on the user message (the rewind target).
   * Best-effort: a failed snapshot logs and continues — the turn still runs,
   * its message just can't be a file rewind point.
   */
  private async stampCheckpoint(
    binding: SessionBinding,
    message: AppMessage,
  ): Promise<void> {
    const checkpoints = this.opts.checkpoints;
    if (!checkpoints) return;
    try {
      const checkpoint = await checkpoints.snapshot(binding.cwd);
      await this.opts.relay.request("messages.setCheckpoint", {
        channelId: binding.channelId,
        messageId: message.id,
        checkpoint,
      });
    } catch (error) {
      this.opts.log.warn("folder checkpoint failed", {
        conversationId: binding.conversationId,
        messageId: message.id,
        error: String(error),
      });
    }
  }

  /**
   * `conversations.rewind` arrives as a relay-forwarded host call (#134):
   * restore the folder to the checkpoint stamped on the target message, drop
   * queued user messages the rewind removes, and — when the session's engine
   * declares `rewind` — drop the turns from its context too. Throws (code
   * -32009 conflict) while a turn runs; throwing before the mark means the
   * relay leaves the thread untouched.
   */
  private async rewindConversation(params: {
    conversationId: string;
    engineRef: string | null;
    checkpoint: string | null;
    cwd: string | null;
    fromSeq: number;
    toTurn: number;
  }): Promise<{ engineRewound: boolean; filesRestored: boolean }> {
    const binding = this.bindings.get(params.conversationId);
    if (binding?.runningTurnId) {
      throw Object.assign(
        new Error("a turn is still running — stop it before rewinding"),
        { code: -32009 },
      );
    }
    /* Stored cwd may be `~/x` (host fs echoes collapsed): expand before
       any spawn/fs use — literal `~` is not a valid cwd for execFile. */
    const cwd = expandPath(params.cwd ?? binding?.cwd ?? this.opts.workdir);
    let filesRestored = false;
    if (params.checkpoint && this.opts.checkpoints) {
      await this.opts.checkpoints.restore(cwd, params.checkpoint);
      filesRestored = true;
    }
    /* Queued-behind-a-turn user messages at/after the rewind point never
       send; release their delivery claims so nothing re-prompts them. */
    if (binding) {
      binding.queue = binding.queue.filter((m) => {
        if (m.seq >= params.fromSeq) binding.consumed.delete(m.id);
        return m.seq < params.fromSeq;
      });
    }
    let engineRewound = false;
    const conn = this.engine;
    const sessionId = binding?.sessionId ?? params.engineRef ?? undefined;
    if (conn && sessionId && this.hasCapability("rewind")) {
      try {
        await conn.request("session.rewind", {
          sessionId,
          toTurn: params.toTurn,
        });
        engineRewound = true;
      } catch (error) {
        const code = engineErrorCode(error);
        if (code === INVALID_STATE) {
          throw Object.assign(
            new Error("the engine refused the rewind — a turn may be running"),
            { code: -32009 },
          );
        }
        // Method missing / transport can't rewind (ACP): the AC-3 path —
        // files still restore, the note tells the user, and the app offers
        // "Start a new session from here".
        this.opts.log.warn("engine session.rewind failed", {
          sessionId,
          error: String(error),
        });
      }
    }
    return { engineRewound, filesRestored };
  }

  /**
   * Advance the conversation's delivery watermark: this user message reached
   * the engine, so a re-registering harness must not owe it again. Queued
   * messages stay under the watermark until they actually send.
   */
  private markDelivered(binding: SessionBinding, message: AppMessage): void {
    this.relayWrite(`deliveredSeq ${message.id}`, () =>
      this.opts.relay.request("conversations.update", {
        conversationId: binding.conversationId,
        deliveredSeq: message.seq,
      }),
    );
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
          cwd: expandPath(conv.cwd ?? this.opts.workdir),
          lastSeq: 0,
          queue: [],
          textByTurn: new Map(),
          pickByTurn: new Map(),
          consumed: new Set(),
          turnSource: new Map(),
        };
        this.bindings.set(conv.id, binding);
        this.conversationBySession.set(conv.engineRef, conv.id);
        this.applyReplay(binding, replay);
        this.rebuildHeldPick(binding, conv, replay.snapshot);
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
      cwd: expandPath(conv.cwd ?? this.opts.workdir),
      lastSeq: 0,
      queue: [],
      textByTurn: new Map(),
      pickByTurn: new Map(),
      consumed: new Set(),
      turnSource: new Map(),
    };
    this.bindings.set(conv.id, binding);
    this.conversationBySession.set(started.sessionId, conv.id);
    await this.updateConversation(conv.id, {
      engineRef: started.sessionId,
      state: "active",
    });
    // #113 AC-6: a session opened without a picked folder says where the
    // agent actually works (the harness default). Deduped — a rebind after
    // restart does not repost it.
    if (!conv.cwd) {
      await this.postSystem(
        binding,
        `No folder: working in ${collapsePath(this.opts.workdir)}`,
        `sys:${conv.id}:no-folder`,
      );
    }
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
        // The pick the turn actually runs on — engine truth for the footer's
        // `· model · effort · Fast` (issue #92 AC-4).
        if (
          event.payload.model ||
          event.payload.provider ||
          event.payload.effort ||
          event.payload.fast !== undefined
        ) {
          binding.pickByTurn.set(event.payload.turnId, {
            ...(event.payload.model ? { model: event.payload.model } : {}),
            ...(event.payload.provider
              ? { provider: event.payload.provider }
              : {}),
            ...(event.payload.effort ? { effort: event.payload.effort } : {}),
            ...(event.payload.fast !== undefined
              ? { fast: event.payload.fast }
              : {}),
          });
        }
        // `ref` proves which relay message this turn consumed — recorded so a
        // pending-tail redelivery can't re-prompt it, and so the turn's answer
        // posts under a dedupe key stable across reconnects.
        if (event.payload.ref) {
          binding.consumed.add(event.payload.ref);
          binding.turnSource.set(event.payload.turnId, event.payload.ref);
        }
        this.opts.sleep.acquire();
        this.updateConversation(binding.conversationId, {
          state: "active",
        }).catch(() => {});
        break;
      case "session.note":
        /* Engine-authored note (e.g. a deferred model switch that failed at
           turn start — "Couldn't switch to X — staying on Y"). Surfaced as a
           system message; deduped by seq AND session — a rebound session
           restarts its seq at 1 (#92). */
        if (binding) {
          this.postSystem(
            binding,
            event.payload.text,
            `sys:${binding.conversationId}:note:${event.sessionId}:${event.seq}`,
          ).catch(() => {});
        }
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
      // tool.started/completed never post feed rows — the tool cards inside
      // the turn are the single rendering (issue #71, AC-1).
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
    const open = async () => {
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
    };
    try {
      await open();
    } catch (error) {
      if (!isTransientRelayError(error)) throw error;
      // Socket mid-reconnect: the ask lands when the outbox flushes (the
      // request_id unique key makes a replayed open idempotent).
      this.relayWrite(`asks.open ${requestId}`, open);
    }
  }

  /**
   * After a relay reconnect, asks the user resolved while the socket was down
   * never reached us (`ask.resolved` is fire-and-forget). Re-list resolved
   * asks and forward the ones still mapped to an engine request.
   */
  private async reconcileAsks(): Promise<void> {
    let resolved: Ask[];
    try {
      const res = await this.opts.relay.request<{ asks: Ask[] }>("asks.list", {
        state: "resolved",
      });
      resolved = res.asks;
    } catch (error) {
      this.opts.log.warn("asks reconcile failed", { error: String(error) });
      return;
    }
    for (const ask of resolved) {
      try {
        if (this.requestByAsk.has(ask.id) && ask.outcome)
          await this.onAskResolved(ask);
      } catch (error) {
        this.opts.log.warn("ask reconcile respond failed", {
          askId: ask.id,
          error: String(error),
        });
      }
    }
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
    this.relayWrite(`asks.respond ${requestId}`, () =>
      this.opts.relay.request("asks.respond", {
        askId,
        outcome,
        ...(answer ? { answer } : {}),
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
      case "conversation.updated": {
        // User-initiated rename/archive (host writes only touch
        // engineRef/state/deliveredSeq): mirror onto the engine session when
        // it advertises `session_meta` (#28 AC-3).
        const parsed = ConversationUpdatedEvent.safeParse(params);
        if (!parsed.success) break;
        const conv = parsed.data.conversation;
        const seen = this.metaSeen.get(conv.id);
        const binding = this.bindings.get(conv.id);
        if (!binding) {
          // No session yet — record the baseline so a later event diffs right.
          if (!seen) {
            this.metaSeen.set(conv.id, {
              title: conv.title,
              archived: conv.archived,
            });
          }
          break;
        }
        if (
          seen &&
          seen.title === conv.title &&
          seen.archived === conv.archived
        ) {
          break;
        }
        this.mirrorMeta(binding, conv);
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
          const { conversationId } = parsed.data;
          // Serialize picks per conversation: a slow ack (confirm_required,
          // deferred-while-running) would otherwise let an earlier pick's
          // ack overwrite the last one — last-ack-wins must mean last-sent.
          const prev =
            this.modelPickQueue.get(conversationId) ?? Promise.resolve();
          const next = prev.then(() =>
            this.onModelRequested(conversationId, {
              model: parsed.data.model,
              provider: parsed.data.provider,
              effort: parsed.data.effort,
              fast: parsed.data.fast,
            }),
          );
          this.modelPickQueue.set(
            conversationId,
            next.catch(() => {}),
          );
          void next;
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
    /* `conversations.rewind` is relay-initiated (not passthrough): the
       harness restores the folder checkpoint and rewinds the engine session
       when its transport can. */
    if (method === "conversations.rewind") {
      return this.rewindConversation(
        params as unknown as Parameters<Harness["rewindConversation"]>[0],
      );
    }
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
  private async onModelRequested(conversationId: string, pick: ModelPick) {
    const binding = this.bindings.get(conversationId);
    const conn = this.engine;
    /* The pick is the whole intended state: a field the new model drops
       (provider on a single-provider engine, effort on a non-reasoning
       model, fast on a model with no tier) writes NULL so the old pick
       can't linger on the conversation row or the footer (#92 AC-4). */
    const patch: ConversationPickPatch = {
      model: pick.model,
      provider: pick.provider ?? null,
      effort: pick.effort ?? null,
      fast: pick.fast ?? null,
    };
    if (binding && conn) {
      if (binding.runningTurnId) {
        /* Hold the pick while a turn runs: a mid-turn setModel would either
           mutate the running session (a live fast flip is checked against
           the OLD model, and its provider request overrides can ride onto
           the new one) or land in an engine deferred stash the next prompt
           races. Held here and applied on the idle session before the next
           prompt, the engine only ever sees a plain setModel — no deferral,
           no stash (#92 AC-4). Latest pick wins; a failed apply restores
           the row to what the session actually runs. */
        const conv = this.conversationFromAtom(conversationId);
        binding.heldPickPrev ??= {
          model: conv?.model ?? null,
          provider: conv?.provider ?? null,
          effort: conv?.effort ?? null,
          fast: conv?.fast ?? null,
        };
        binding.heldPick = pick;
      } else {
        /* A fresh pick on an idle session supersedes any pick still held
           from the turn that just ended — drop it so the queue-serialized
           apply can't land an older pick after this one. */
        binding.heldPick = undefined;
        binding.heldPickPrev = undefined;
        try {
          Object.assign(patch, await this.setSessionModel(binding, pick));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.opts.log.warn("session.setModel failed", {
            conversationId,
            error: detail,
          });
          await this.postSystem(
            binding,
            `Couldn't switch to ${pick.model}: ${detail}`,
          );
          return;
        }
      }
    }
    await this.updateConversation(conversationId, patch).catch((error) =>
      this.opts.log.warn("conversation model update failed", {
        conversationId,
        error: String(error),
      }),
    );
  }

  /**
   * `session.setModel` on an idle session, returning the corrections the
   * ack implies for the conversation row: the engine's canonical model id,
   * any field it rewrites, and `fast: null` + a short note when fast was
   * requested but the ack doesn't carry it (the pick runs without it).
   */
  private async setSessionModel(
    binding: SessionBinding,
    pick: ModelPick,
  ): Promise<ConversationPickPatch> {
    const conn = this.engine;
    if (!conn) throw new Error("engine not connected");
    const ack = await conn.request<{
      model: string;
      provider?: string;
      effort?: string;
      fast?: boolean;
      deferred?: boolean;
    }>("session.setModel", {
      sessionId: binding.sessionId,
      ...pick,
    });
    const patch: ConversationPickPatch = { model: ack.model };
    if (ack.provider !== undefined) patch.provider = ack.provider;
    if (ack.effort !== undefined) patch.effort = ack.effort;
    if (ack.fast !== undefined) {
      patch.fast = ack.fast;
    } else if (pick.fast !== undefined) {
      /* Fast was requested but the ack omits it — record the refusal so the
         picker doesn't show ⚡ on a turn that ran without it. */
      patch.fast = null;
      await this.postSystem(
        binding,
        `⚡ Fast isn't available for ${ack.model} — the pick runs without it.`,
        /* Unique key: a repeat refusal on the same model must still post —
           the picker showing ⚡ on a turn that ran without it is the bug
           the note exists for (#92 review). */
        `sys:${binding.conversationId}:pick-fast:${ack.model}:${Date.now()}`,
      );
    }
    return patch;
  }

  /**
   * A pick made while a turn ran, applied to the now-idle session before
   * the next prompt goes out. The intent already sits on the conversation
   * row; a failed apply restores the previous pick so the dead model can't
   * linger or be retried on restart, and `turn.started` keeps stamping what
   * the session actually ran. Serialized with `onModelRequested` through
   * `modelPickQueue` — a newer pick always lands after the held one.
   */
  private applyHeldPick(binding: SessionBinding): Promise<void> {
    const conversationId = binding.conversationId;
    const prev = this.modelPickQueue.get(conversationId) ?? Promise.resolve();
    const next = prev.then(() => this.doApplyHeldPick(binding));
    this.modelPickQueue.set(
      conversationId,
      next.catch(() => {}),
    );
    return next;
  }

  /**
   * Reattach after a harness restart: a pick written while the harness was
   * down sits only on the row — the session snapshot still shows the old
   * model while the UI shows the new one. When they differ, hold the row's
   * pick (prev = what the session actually runs) so it applies before the
   * next prompt; a failed apply restores the snapshot's values (#92).
   */
  private rebuildHeldPick(
    binding: SessionBinding,
    conv: Conversation,
    snap: EventsSinceResult["snapshot"],
  ) {
    if (!conv.model) return;
    const rowPick: ModelPick = { model: conv.model };
    if (conv.provider) rowPick.provider = conv.provider;
    if (conv.effort) rowPick.effort = conv.effort;
    if (conv.fast !== undefined) rowPick.fast = conv.fast;
    if (
      snap.model === rowPick.model &&
      snap.provider === rowPick.provider &&
      snap.effort === rowPick.effort &&
      snap.fast === rowPick.fast
    )
      return;
    binding.heldPickPrev = {
      model: snap.model ?? null,
      provider: snap.provider ?? null,
      effort: snap.effort ?? null,
      fast: snap.fast ?? null,
    };
    binding.heldPick = rowPick;
  }

  private async doApplyHeldPick(binding: SessionBinding) {
    const pick = binding.heldPick;
    if (!pick) return;
    const prev = binding.heldPickPrev;
    binding.heldPick = undefined;
    binding.heldPickPrev = undefined;
    if (!this.engine) return; // intent stays on the row; session.start applies it
    try {
      const correction = await this.setSessionModel(binding, pick);
      await this.updateConversation(binding.conversationId, correction).catch(
        () => {},
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.opts.log.warn("held session.setModel failed", {
        conversationId: binding.conversationId,
        error: detail,
      });
      if (prev) {
        await this.updateConversation(binding.conversationId, prev).catch(
          () => {},
        );
      }
      await this.postSystem(
        binding,
        `Couldn't switch to ${pick.model}: ${detail}`,
        // Unique key: every failed apply surfaces, not just the first (#92).
        `sys:${binding.conversationId}:pick-failed:${pick.model}:${Date.now()}`,
      );
    }
  }

  /* --------------------------- turn completion -------------------------- */

  private async finishTurn(
    binding: SessionBinding,
    event: Extract<EngineEvent, { type: "turn.completed" }>,
  ) {
    const { turnId, stopReason } = event.payload;
    const text = binding.textByTurn.get(turnId) ?? "";
    const pick = binding.pickByTurn.get(turnId);
    binding.textByTurn.delete(turnId);
    binding.pickByTurn.delete(turnId);
    binding.runningTurnId = undefined;
    this.opts.sleep.release();

    const employeeId = this.employeeIdFor(
      this.conversationFromAtom(binding.conversationId),
    );
    const hasAnswer = text.trim().length > 0 && !!employeeId;
    // The answer dedupes under the user message that prompted the turn
    // (turn.started.ref); re-prompts of the same message — a rebind redelivery
    // — hit the same key instead of posting a duplicate.
    const source = binding.turnSource.get(turnId) ?? turnId;
    if (hasAnswer) {
      this.relayWrite(`answer ${turnId}`, () =>
        this.opts.relay.request("messages.post", {
          channelId: binding.channelId,
          conversationId: binding.conversationId,
          authorKind: "employee",
          authorId: employeeId,
          text: text.trim(),
          ...(pick?.model ? { model: pick.model } : {}),
          ...(pick?.provider ? { provider: pick.provider } : {}),
          ...(pick?.effort ? { effort: pick.effort } : {}),
          ...(pick?.fast !== undefined ? { fast: pick.fast } : {}),
          dedupeKey: `answer:${binding.conversationId}:${source}`,
        }),
      );
    }
    // An errored turn must leave a trace even when text streamed before it —
    // in-view conversations never notify, so this is the only failure signal.
    if (event.payload.error) {
      await this.postSystem(
        binding,
        `Error: ${event.payload.error}`,
        `sys:${binding.conversationId}:${source}:error`,
      );
    } else if (!hasAnswer && stopReason === "cancelled") {
      await this.postSystem(
        binding,
        "Stopped.",
        `sys:${binding.conversationId}:${source}:stopped`,
      );
    } else if (!hasAnswer) {
      await this.postSystem(
        binding,
        "(the engine ended the turn silently)",
        `sys:${binding.conversationId}:${source}:silent`,
      );
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
    // A pick pinned on the conversation (#30/#92) wins over the profile
    // default — each field falls back independently so a bare `model` pin
    // (old rows) still resolves its provider/effort on the engine.
    const model = conv?.model ?? base.model;
    const provider = conv?.provider ?? base.provider;
    const effort = conv?.effort ?? base.effort;
    const fast = conv?.fast ?? base.fast;
    // The session's folder is owned by the conversation (#113); absent → the
    // harness default workdir, as before.
    const cwd = expandPath(conv?.cwd ?? this.opts.workdir);
    return {
      ...base,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(effort ? { effort } : {}),
      ...(fast !== undefined ? { fast } : {}),
      cwd,
    };
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
      model?: string | null;
      provider?: string | null;
      effort?: string | null;
      fast?: boolean | null;
      deliveredSeq?: number;
    },
  ) {
    await this.opts.relay.request("conversations.update", {
      conversationId,
      ...patch,
    });
  }

  private async postSystem(
    binding: SessionBinding,
    text: string,
    dedupeKey?: string,
  ) {
    this.relayWrite(`system note "${text.slice(0, 24)}"`, () =>
      this.opts.relay.request("messages.post", {
        channelId: binding.channelId,
        conversationId: binding.conversationId,
        authorKind: "system",
        text,
        ...(dedupeKey ? { dedupeKey } : {}),
      }),
    );
  }
}

/** Socket-level failures retry through the outbox; the rest are real. */
const TRANSIENT_CODES = new Set([
  "not_connected",
  "timeout",
  "socket_closed",
  "closed",
]);
function isTransientRelayError(error: unknown): boolean {
  if (error instanceof Error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  }
  return false;
}
