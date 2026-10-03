import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RelayClient } from "@lilos/client-runtime";
import type {
  AppChannel,
  AppMessage,
  Ask,
  AttachmentsGetResult,
  Conversation,
  ConversationsRewindHostResult,
  Employee,
  FoldersBrowseResult,
  FoldersDetailResult,
  FoldersDiscoverResult,
  PendingTurn,
  ProfileConnection,
} from "@lilos/contracts/app";
import {
  APP_PROTOCOL_VERSION,
  AskResolvedEvent,
  ChannelCreatedEvent,
  ChannelRemovedEvent,
  ConversationModelRequestedEvent,
  ConversationRewoundEvent,
  ConversationsRewindHostParams,
  ConversationUpdatedEvent,
  EmployeeRemovedEvent,
  ENGINE_PASSTHROUGH_METHODS,
  FoldersBrowseParams,
  FoldersDetailParams,
  MessageChangedEvent,
  TurnInterruptRequestedEvent,
} from "@lilos/contracts/app";
import {
  type AgentDescriptor,
  type ContentBlock,
  type DescribeResult,
  type EngineEvent,
  type EngineRequest,
  EventsSinceParams,
  type EventsSinceResult,
  type McpServerStdio,
} from "@lilos/contracts/engine";
import {
  type CheckpointStore,
  callHost,
  collapsePath,
  expandPath,
  fsList,
  gitBranches,
  gitDiscoverRepos,
  gitIsRepo,
  gitWorktrees,
  HOST_ERRORS,
  HostError,
  resolveUnderHome,
  worktreeAdd,
} from "@lilos/host";
import { CONNECT_APPROVAL_KEY } from "./connect";
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
  /**
   * The engine's own session id inside its engine (#339 — Hermes' stored
   * session key, returned as `session.start`'s `engineSessionId` and kept
   * current by `session.ref.changed`). The gateway aliases it so an
   * in-process engine plugin resolves this binding's scope.
   */
  engineSessionId?: string;
  /** The gateway session id backing this session's surfaces, if wired. */
  gatewaySession?: string;
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
  /** Relay message ids whose `sendPrompt` is between dispatch and settle
      (#377). A second send during that window must queue, not race the
      wire: the loser's `prompt` hits INVALID_STATE, its re-queue lands
      after any `message.changed` splice, and send order inverts. */
  inflightPrompts: Set<string>;
  /** Resolved once each in-flight `sendPrompt` has put its `prompt` frame on
     the wire (or bailed early). `interrupt` and `conversations.rewind` wait
     on these so a request landing in the pre-prompt window (attachment
     fetch, folder checkpoint) can't overtake its prompt on the in-order
     engine conn — an early interrupt would be acked `interrupted:false` on
     a turn that exists a moment later, silently losing the Stop (#274). */
  promptGates: Set<Promise<void>>;
  /** Relay message ids the engine consumed (replayed `turn.started.ref`). */
  consumed: Set<string>;
  /** turnId -> relay message id that prompted it — the answer's dedupe key. */
  turnSource: Map<string, string>;
  /** Steers the engine accepted but hasn't landed yet (no `turn.steered`
      seen), keyed by relay message id — a Stop drops these alongside the
      queue so nothing waiting can auto-run after it (#315). */
  steerPending: { messageId: string; text: string }[];
  /** Grace window for stranded accepted steers (#315): scheduled when a
     turn ends or an accepted steer lands after it — at fire time any
     steerPending left parks in the not-sent tray via `messages.drop`. */
  steerReconcileTimer?: ReturnType<typeof setTimeout>;
  /** Set when ■ Stop is requested until the next `turn.started` — the
      queue drain parks instead of prompting while it's on (#315). */
  stopRequested: boolean;
  /** Set once a Stop's park sweep ran, until the next `turn.started` —
      steer acks for the stopped turn that land after the sweep still park
      (#377: a `steered`/`not_running` resolution racing the sweep must
      not deliver or prompt past the tray). */
  stopParked?: boolean;
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
  /**
   * The agent-gateway surfaces server (#337/#339): one gateway session per
   * engine session, aliased by the engine's own session id so an
   * in-process engine plugin can present it via `x-lilos-session`.
   * Optional — fixtures skip it; engines still work, `lilos_*` tools just
   * never resolve.
   */
  surfaces?: {
    create(init: {
      cwd?: string;
      binding?: import("@lilos/contracts/harness").SessionBinding;
      engineSessionId?: string;
    }): { session: string; mcpServer: McpServerStdio };
    bindEngineSession(session: string, engineSessionId: string): boolean;
    destroy(session: string): Promise<boolean>;
  };
  /**
   * How an engine session reaches its surfaces (#339): "plugin" — an
   * in-process engine plugin renders lilos_* from the gateway catalog
   * (Hermes); "mcp" — the session's `session.start` carries the surfaces'
   * stdio `lilos mcp` server spec (engine-fake, ACP engines).
   */
  surfacesAttach?: "plugin" | "mcp";
  /** The home-folder boundary `folders.browse`/`folders.discover` enforce
   * for device peers (#238). Defaults to the OS home dir (injectable for
   * tests).
   */
  homeDir?: string;
  /** #339 Connect reconciler (Hermes engine only): reconciles the lilos
     plugin per employee profile after approval, reports the rows on
     `harness.report`. Undefined on non-Hermes engines. */
  connect?: {
    reconcile(): Promise<void>;
    employeeRemoved(employeeId: string): void;
    report(): ProfileConnection[];
  };
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
  /* #400: a bind is a multi-await RPC chain (session.start + surfaces). Every
     deliver inside that window must share ONE bind — two racing binds made
     two engine sessions and the feed (keyed on engineRef, written last) only
     ever showed one session's turns. The set is also the marker
     onInterruptRequested reads before dropping a Stop fired mid-bind. */
  private readonly binds = new Map<
    string,
    Promise<SessionBinding | undefined>
  >();
  /** Conversation ids whose Stop outran the turn it meant to stop — fired
      at the send's first `turn.started`, when the engine provably has a
      turn to stop. Covers every window the relay's two delivery paths or
      the bind/prompt awaits open: the first bind still mid-flight (#400),
      the send's row not yet arrived via `channelMessages` at all (#402),
      and the bound-but-pre-turn stretch where `promptGates` can't see the
      dispatch yet (an interrupt there acks `interrupted:false` and dies). */
  private readonly pendingInterrupts = new Set<string>();
  /** Sends per conversation between `deliver`'s claim and the send landing
      in a tracked state (early/queue/consumed/steerPending). The binding
      can exist with empty promptGates in this stretch — e.g. inside
      bindConversation's post-`bindings.set` awaits — so it is its own
      marker for "a turn is coming". */
  private readonly inFlightDeliveries = new Map<string, number>();
  /** engine requestId -> relay ask id (per session). */
  private readonly askByRequest = new Map<string, string>();
  private readonly requestByAsk = new Map<
    string,
    { sessionId: string; requestId: string }
  >();
  private readonly delivered = new Set<string>(); // relay message ids claimed
  /** Messages that arrived while the engine was down; drained on attach. */
  private readonly early = new Map<string, AppMessage[]>();
  /** User-removed message ids (#315 `message.changed`): skipped forever. */
  private readonly dismissed = new Set<string>();
  /** Un-parked message ids allowed past the deliveredSeq watermark once —
      a Send on a dropped accepted-steer has seq <= deliveredSeq and must
      still reach the engine (#315 `message.changed`). */
  private readonly redeliver = new Set<string>();
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
    { title: string; archived: boolean; titleSource?: "auto" | "user" }
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

  /* The Mac user's home this harness serves — `~` on the wire means this
     directory (device-scope folder reads stay under it). */
  private readonly home: string;

  constructor(private readonly opts: HarnessOptions) {
    this.home = opts.homeDir ?? homedir();
  }

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
    try {
      return await conn.request<EventsSinceResult>("events.since", {
        sessionId,
        after,
      });
    } catch (error) {
      /* #300: a session the engine forgot — legacy bare ids (`s1`) with no
         registry row, or any SESSION_NOT_FOUND — must not surface as a
         replay error. The client degrades to "no live transcript": relay
         messages + the persisted context meter still render, and the write
         path rebinds on `session.start` the same way a gateway 404 does. */
      if (engineErrorCode(error) !== SESSION_NOT_FOUND) throw error;
      return {
        events: [],
        latestSeq: after,
        truncated: false,
        openRequests: [],
        snapshot: { sessionId, state: "closed" },
      };
    }
  }

  /** Subscribe to every engine event the harness sees (feed fan-out). */
  subscribeEngineEvents(fn: (event: EngineEvent) => void): () => void {
    this.feedListeners.add(fn);
    return () => this.feedListeners.delete(fn);
  }

  private hasCapability(id: string): boolean {
    return this.describeResult?.capabilities.some((c) => c.id === id) ?? false;
  }

  /** The engine writes titles itself (#137) — declared via
      `session_meta.detail.autoTitle`, emitted as `session.titled`. */
  private hasAutoTitle(): boolean {
    return (
      this.describeResult?.capabilities.find((c) => c.id === "session_meta")
        ?.detail?.autoTitle === true
    );
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
      // The web hire path opens the DM channel up front so the employee's DM
      // never renders a perpetual skeleton (hireEmployee); the first-run
      // hire does the same (#193). `channels.openDm` is idempotent.
      await this.opts.relay.request("channels.openDm", {
        employeeId: created.employee.id,
      });
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
    /* #137 AC-2: the snapshot title is the engine's persisted truth — it
       lands whatever the (possibly truncated) event log missed. The relay
       still refuses it over a user rename. */
    const snapshotTitle = replay.snapshot.title;
    if (
      snapshotTitle &&
      this.hasAutoTitle() &&
      this.metaSeen.get(binding.conversationId)?.titleSource !== "user"
    ) {
      this.updateConversation(binding.conversationId, {
        title: snapshotTitle,
      }).catch(() => {});
    }
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
      /* The turn vanished mid-run — pending steers can't land anymore. */
      this.scheduleSteerReconcile(binding);
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
    const surface = this.createSurfaces(binding, conv, employee);
    const started = await conn.request<{
      sessionId: string;
      ref?: string;
      engineSessionId?: string;
    }>(
      "session.start",
      this.sessionParams(employee, agent, conv, surface?.mcpServer),
    );
    this.aliasSurfaces(surface?.session, started.engineSessionId);
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
      engineSessionId: started.engineSessionId,
      gatewaySession: surface?.session,
      lastSeq: 0,
      runningTurnId: undefined,
      textByTurn: new Map(),
      pickByTurn: new Map(),
      /* A held pick already sits on the conversation row — the new session
         starts on it via `sessionParams`; nothing left to apply. */
      heldPick: undefined,
      heldPickPrev: undefined,
      promptGates: new Set(),
      /* The old session's in-flight sends die with it — the rebound queue
         drains through sendPrompt, which re-arms its own entry. */
      inflightPrompts: new Set(),
      /* A dead session's stop mustn't park the live one, and its reconcile
         timer dies with it (#315). */
      stopRequested: false,
      stopParked: false,
      steerReconcileTimer: undefined,
    };
    if (binding.steerReconcileTimer) clearTimeout(binding.steerReconcileTimer);
    this.bindings.set(binding.conversationId, rebound);
    this.conversationBySession.set(started.sessionId, binding.conversationId);
    // Idle, not active: a rebind with an empty queue has nothing running —
    // "active" would leave the conversation spinning forever. Requeued
    // messages flip it back to active via their own turn.started.
    await this.updateConversation(binding.conversationId, {
      engineRef: started.sessionId,
      state: "idle",
    });
    /* The old session is gone: an accepted-but-unlanded steer can never
       land on the rebound session — park it in the not-sent tray
       (#315 AC-5/AC-6). Same for the queue when a Stop had armed the
       park: nothing waiting auto-runs after it. */
    for (const pending of binding.steerPending.splice(0)) {
      binding.consumed.delete(pending.messageId);
      this.relayWrite(`drop steer ${pending.messageId}`, () =>
        this.opts.relay.request("messages.drop", {
          messageId: pending.messageId,
        }),
      );
    }
    const queued = binding.queue.splice(0);
    if (binding.stopRequested) {
      binding.stopRequested = false;
      /* #402: the queue this Stop dropped was everything a pre-bind parked
         interrupt could still wait on — the park is moot. */
      this.pendingInterrupts.delete(binding.conversationId);
      for (const message of queued) {
        binding.consumed.delete(message.id);
        this.relayWrite(`drop queued ${message.id}`, () =>
          this.opts.relay.request("messages.drop", { messageId: message.id }),
        );
      }
    } else {
      for (const message of queued) this.enqueueOrPrompt(rebound, message);
    }
    this.mirrorMeta(rebound, conv);
  }

  /**
   * Best-effort mirror of the app's title/archive onto the engine session
   * (capability `session_meta`, #28 AC-3). Engines without it keep working —
   * the relay record is the source of truth either way.
   */
  private mirrorMeta(
    binding: SessionBinding,
    conv:
      | { title: string; archived: boolean; titleSource?: "auto" | "user" }
      | undefined,
  ): void {
    if (!conv) return;
    const seen = this.metaSeen.get(binding.conversationId);
    this.metaSeen.set(binding.conversationId, {
      title: conv.title,
      archived: conv.archived,
      titleSource: conv.titleSource,
    });
    const conn = this.engine;
    if (!conn || !this.hasCapability("session_meta")) return;
    /* Only USER-chosen titles mirror onto the engine (#137): mirroring an
       engine-written title back via session.setTitle would mark it
       user-provenance on the engine side (Hermes `title_source=user`) and
       permanently block the derived → llm upgrade. */
    const titleIsUserChosen =
      conv.titleSource === undefined || conv.titleSource === "user";
    if (
      conv.title &&
      titleIsUserChosen &&
      (!seen || seen.title !== conv.title)
    ) {
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

  /** Per-conversation delivery chains (#377): `deliver`'s own awaits
      (conversation lookup, bind, replay) leave a window where a later send
      enqueues first — the queue and the wire then disagree on send order.
      Each link always resolves so a failed send can't park the convo. */
  private deliveryChains = new Map<string, Promise<void>>();

  /** Run `fn` after the conversation's earlier delivery work, in arrival order. */
  private ordered<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.deliveryChains.get(conversationId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tracked: Promise<void> = next.then(
      () => {},
      () => {},
    );
    this.deliveryChains.set(conversationId, tracked);
    void tracked.finally(() => {
      if (this.deliveryChains.get(conversationId) === tracked)
        this.deliveryChains.delete(conversationId);
    });
    return next;
  }

  private deliver(message: AppMessage): Promise<void> {
    /* #377: sends for one conversation enqueue strictly in arrival order —
       without the chain, two sends' interleaved awaits can reach
       enqueueOrPrompt reversed and the later send prompts first. */
    const convId = message.conversationId;
    if (!convId || message.authorKind !== "user") return Promise.resolve();
    return this.ordered(convId, () => this.deliverOrdered(message));
  }

  private async deliverOrdered(message: AppMessage): Promise<void> {
    if (message.authorKind !== "user") return;
    if (!message.conversationId) return;
    /* #315: a user-removed row must never reach the engine — not even via
       a replayed frame that predates the `message.changed` it carried.
       The row's own flags are checked too: they are the durable truth when
       a flag-flip frame never arrived on this socket (#377). */
    if (message.removed || message.dropped || message.rewound) return;
    if (this.dismissed.has(message.id)) return;
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
      this.dropParkedInterruptIfOrphaned(conv.id);
      return;
    }
    this.delivered.add(message.id);
    /* Until the send lands in a tracked resting place (early/queue/
       consumed/steerPending) the in-flight marker is all that proves a
       turn is coming — `onInterruptRequested` and the orphan clear both
       read it. Released once, wherever the send ends up. */
    let inFlight = true;
    const releaseInFlight = () => {
      if (!inFlight) return;
      inFlight = false;
      const n = (this.inFlightDeliveries.get(conv.id) ?? 0) - 1;
      if (n > 0) this.inFlightDeliveries.set(conv.id, n);
      else this.inFlightDeliveries.delete(conv.id);
    };
    this.inFlightDeliveries.set(
      conv.id,
      (this.inFlightDeliveries.get(conv.id) ?? 0) + 1,
    );
    try {
      /* #288: the watermark applies before ANY binding work — a restart's
         channel replay re-delivers every already-delivered user message while
         the engine is down; binding for one would start a fresh session (or
         reattach) only to drop the message, and the held batch would re-prompt
         on that new session when the engine attaches. Nothing owed → no bind,
         no session.start, no prompt. */
      /* #315: the `redeliver` claim is one-shot — read it once for both
         watermark checks below, or the second guard swallows a Send. */
      const isRedeliver = this.redeliver.delete(message.id);
      const cur = this.conversationFromAtom(conv.id) ?? conv;
      if (message.seq <= cur.deliveredSeq && !isRedeliver) {
        releaseInFlight();
        this.dropParkedInterruptIfOrphaned(conv.id);
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
        // The watermark already claimed this send — keep the claim alive so
        // the post-attach flush can't swallow it.
        if (isRedeliver) this.redeliver.add(message.id);
        this.opts.log.debug("message held for engine", {
          conversationId: conv.id,
          waiting: waiting.length,
        });
        return;
      }
      // Watermark guard: a redelivery (register pending list, channel replay)
      // of a message the engine already took must not prompt it again. The
      // `dismissed` head-check ran before the bind await — a rewind could have
      // killed the row in between, so it is checked again here.
      const fresh = this.conversationFromAtom(conv.id) ?? conv;
      if (
        (message.seq <= fresh.deliveredSeq && !isRedeliver) ||
        this.dismissed.has(message.id) ||
        binding.consumed.has(message.id)
      ) {
        releaseInFlight();
        this.dropParkedInterruptIfOrphaned(conv.id);
        return;
      }
      this.enqueueOrPrompt(binding, message);
    } finally {
      releaseInFlight();
    }
  }

  private async flushEarly(convId: string): Promise<void> {
    /* Enqueues must still join the conversation's delivery order — a send
       that arrived while the engine was down lands ahead of anything sent
       since (#377). */
    await this.ordered(convId, () => this.flushEarlyOrdered(convId));
  }

  private async flushEarlyOrdered(convId: string): Promise<void> {
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
    const fresh = this.conversationFromAtom(conv.id) ?? conv;
    for (const message of waiting) {
      /* #288: deliver()'s watermark guard, replayed for the held batch — a
         held message can sit at/below deliveredSeq (delivered on a previous
         engine attachment or via the register-time pending list while this
         one was queued). Never prompt it a second time. */
      if (
        this.dismissed.has(message.id) ||
        (message.seq <= fresh.deliveredSeq &&
          !this.redeliver.delete(message.id)) ||
        binding.consumed.has(message.id)
      )
        continue;
      this.enqueueOrPrompt(binding, message);
    }
  }

  private enqueueOrPrompt(binding: SessionBinding, message: AppMessage) {
    // In-flight guard: replayed `turn.started` refs populate `consumed`, and
    // claiming the id here means a message can't be prompted twice even when
    // two delivery paths (register pending + channel replay) race before the
    // first turn.started lands. The queue-drain path bypasses this by design:
    // entries here failed or steered out, so a fresh send is the point.
    if (binding.consumed.has(message.id)) return;
    /* Dead rows never enter the queue or the wire: `dismissed` is the
       event-fed kill-set, the row flags are the durable truth when a
       `message.changed` frame never arrived (#377). */
    if (
      this.dismissed.has(message.id) ||
      message.removed ||
      message.dropped ||
      message.rewound
    )
      return;
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
                /* Same link as `prompt.ref` — a steer that outlives its turn
                   pumps as the next one, and its turn.started must still name
                   the relay message (#134 rewind filtering keys off it). */
                ref: message.id,
              },
            ),
          )
          .then((res) => {
            /* Removed while the steer RPC was in flight: the engine took it,
               but the row is `removed` — don't advance deliveredSeq over it
               (a restart would re-owe it anyway: pending turns skip removed
               rows) and don't track it as a droppable steer. */
            if (this.dismissed.has(message.id)) return;
            /* #377: a steer resolving after its turn's Stop — even after the
               park sweep ran (`stopParked`) — parks in the tray like the
               sends the sweep caught; delivering or re-prompting it would
               slip a sent-before-Stop message past the tray. Send clears
               `dismissed` and re-delivers it. */
            if (binding.stopRequested || binding.stopParked) {
              binding.consumed.delete(message.id);
              this.dismissed.add(message.id);
              this.relayWrite(`drop steer ${message.id}`, () =>
                this.opts.relay.request("messages.drop", {
                  messageId: message.id,
                }),
              );
              return;
            }
            if (res.status === "steered") {
              this.markDelivered(binding, message);
              /* Tracked until `turn.steered` lands or a Stop drops it —
                 engines discard pending steers on interrupt (#315 AC-5). */
              binding.steerPending.push({
                messageId: message.id,
                text: message.text,
              });
              /* The steer can resolve after its turn ended: nothing will
                 land it now — start the stranded-steer reconcile (#315). */
              if (!binding.runningTurnId) this.scheduleSteerReconcile(binding);
            } else {
              // not_running: the turn ended between our check and the steer
              // (e.g. a Stop just landed). The engine consumed nothing — send
              // it as the next prompt now, or queue it if a new turn already
              // started. Queuing alone stranded it: the queue only drains on
              // turn.completed, and no turn was running.
              binding.consumed.delete(message.id);
              this.promptOrQueue(binding, message);
            }
          })
          .catch((error) => {
            this.opts.log.warn("steer failed; queued instead", {
              error: String(error),
            });
            binding.consumed.delete(message.id);
            this.promptOrQueue(binding, message);
          });
        return;
      }
      binding.consumed.delete(message.id);
      this.insertQueued(binding, message);
      this.opts.log.debug("queued behind running turn", {
        conversationId: binding.conversationId,
        queued: binding.queue.length,
      });
      return;
    }
    /* #377: the send lanes through the same queue — a `sendPrompt` already
       dispatching (turn.started not yet seen) must reach the wire before
       the next prompt leaves, or the two race and the loser comes back
       INVALID_STATE, re-queued out of order. drainQueue fires it when the
       lane is free. */
    binding.consumed.delete(message.id);
    this.insertQueued(binding, message);
    this.drainQueue(binding);
  }

  /** FIFO is arrival order; the tray and the drain owe the user send
      order — insert by relay seq so a late re-queue can't invert it. */
  private insertQueued(binding: SessionBinding, message: AppMessage): void {
    if (binding.queue.some((m) => m.id === message.id))
      this.opts.log.warn("queue dup insert", {
        conversationId: binding.conversationId,
        messageId: message.id,
      });
    const at = binding.queue.findIndex((m) => m.seq > message.seq);
    if (at === -1) binding.queue.push(message);
    else binding.queue.splice(at, 0, message);
  }

  /** Queue it behind whatever occupies the lane; drain when it's free. */
  private promptOrQueue(binding: SessionBinding, message: AppMessage) {
    /* #315 AC-5: while a Stop parks everything waiting, a send the engine
       never accepted (a `not_running` steer settling late) parks the same
       way instead of prompting a fresh turn past the stop. `dismissed`
       guards the stale-copy paths too; Send clears it (#377). */
    if (binding.stopRequested) {
      binding.consumed.delete(message.id);
      this.dismissed.add(message.id);
      this.relayWrite(`drop queued ${message.id}`, () =>
        this.opts.relay.request("messages.drop", { messageId: message.id }),
      );
      return;
    }
    this.insertQueued(binding, message);
    this.drainQueue(binding);
  }

  /**
   * #377: one `prompt` on the wire at a time per binding, in send order.
   * Fires only while the lane is free — no running turn, no dispatch in
   * flight. Rows already dead (removed/dropped/dismissed) skip straight out
   * of the queue instead of prompting.
   */
  private drainQueue(binding: SessionBinding): void {
    if (binding.runningTurnId || binding.inflightPrompts.size > 0) return;
    while (binding.queue.length) {
      const next = binding.queue.shift();
      if (!next) break;
      /* #377: already `consumed` means the engine took this send through
         another path — `turn.started.ref` claimed it while its re-queued
         copy still sat here (socket dropped after the prompt landed).
         Leave the claim in place; the copy just never re-prompts. */
      if (binding.consumed.has(next.id)) {
        this.opts.log.warn("drain skip: consumed", {
          messageId: next.id,
        });
        continue;
      }
      const dead =
        this.dismissed.has(next.id) ||
        next.removed ||
        next.dropped ||
        next.rewound;
      if (dead) {
        binding.consumed.delete(next.id);
        continue;
      }
      binding.consumed.add(next.id);
      void this.sendPrompt(binding, next);
      return;
    }
  }

  private async sendPrompt(binding: SessionBinding, message: AppMessage) {
    /* #274: interrupts (and rewinds) gate on every in-flight send for this
       binding until its `prompt` frame is on the wire — a Stop fired while
       this send is still in its pre-prompt awaits (attachment fetch, folder
       checkpoint) then lands BEHIND the prompt on the in-order conn and
       interrupts the turn it meant to stop, instead of being acked
       `interrupted:false` and lost. Released on dispatch or any bail. */
    binding.inflightPrompts.add(message.id);
    /* #377: claim the row the moment the lane commits it — while the send
       is still in its pre-prompt awaits it would otherwise sit "pending"
       in the waiting tray alongside truly queued sends, and a Remove
       click could hit it (retracting a send the user meant to keep, then
       running the queued one in its place). Claimed rows leave the tray
       and render as their own bubble; the engine never sees a row the
       user removed. */
    this.relayWrite(`claim ${message.id}`, () =>
      this.opts.relay.request("messages.claim", { messageId: message.id }),
    );
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseGate = resolve));
    binding.promptGates.add(gate);
    let requeued = false;
    try {
      requeued = await this.dispatchPrompt(binding, message, releaseGate);
    } finally {
      binding.inflightPrompts.delete(message.id);
      releaseGate();
      binding.promptGates.delete(gate);
      /* The lane just freed: sends queued behind this dispatch (or behind
         the turn it minted) advance now — waiting on the next turn.completed
         alone would strand a send whose dispatch bailed (#377). A dispatch
         that put its message BACK on the queue must not drain, though:
         re-queue means the engine is busy or gone, and turn.completed or
         the rebind already re-fires the drain — an immediate one would
         hot-loop the same prompt (#377 OOM in the loaded suite). */
      if (!requeued) this.drainQueue(binding);
    }
  }

  /** True when the message went back on the queue and awaits an external
      drain (turn.completed / rebind); false when it settled for good. */
  private async dispatchPrompt(
    binding: SessionBinding,
    message: AppMessage,
    promptOnWire: () => void,
  ): Promise<boolean> {
    const conn = this.engine;
    if (!conn) {
      this.opts.log.warn("prompt requeue: no conn", { messageId: message.id });
      binding.consumed.delete(message.id);
      binding.queue.push(message);
      return true;
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
      return false;
    }
    /* #134: snapshot the session folder BEFORE the turn so a later
       "Rewind to here" on this message can restore it. */
    await this.stampCheckpoint(binding, message);
    /* #377: the pre-prompt awaits (held pick, attachment fetch, checkpoint)
       give a Remove/drop the whole window to land — the `message.changed`
       splice only reaches rows still sitting in `binding.queue`, so an
       in-flight send must re-check before its frame hits the wire. */
    if (
      this.dismissed.has(message.id) ||
      message.removed ||
      message.dropped ||
      message.rewound
    ) {
      binding.consumed.delete(message.id);
      return false;
    }
    try {
      // Turn lifecycle (`turn.started`/`turn.completed`) arrives as events
      // before the prompt call resolves — they alone own runningTurnId.
      // No RPC timeout: a turn can run for minutes; completion is an event,
      // and a socket drop still rejects this call.
      const turn = conn.request<{ turnId: string }>(
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
      // The prompt frame is on the wire — a gated interrupt/rewind may go.
      promptOnWire();
      await turn;
      this.markDelivered(binding, message);
    } catch (error) {
      /* #377: a row that died mid-dispatch (removed while the prompt raced
         in, or parked by a Stop that landed meanwhile) never re-enters the
         queue — the splice window for it already closed. */
      if (
        this.dismissed.has(message.id) ||
        message.removed ||
        message.dropped ||
        message.rewound
      ) {
        binding.consumed.delete(message.id);
        return false;
      }
      if (binding.stopRequested) {
        binding.consumed.delete(message.id);
        this.relayWrite(`drop queued ${message.id}`, () =>
          this.opts.relay.request("messages.drop", { messageId: message.id }),
        );
        return false;
      }
      // Going back on the queue releases the in-flight claim — a rebind
      // drains the queue through enqueueOrPrompt, which dedupes on it.
      if (engineErrorCode(error) === undefined) {
        /* #377: a `turn.started` already consumed this message — the socket
           dropped after the prompt landed, so the turn ran anyway.
           Re-queuing would mint a duplicate turn on the next drain; it's
           delivered, not pending. */
        if ([...binding.turnSource.values()].includes(message.id))
          return false;
        this.opts.log.warn("prompt requeue: transport", {
          messageId: message.id,
          error: String(error),
        });
        // Transport failure (socket dropped / engine died mid-prompt): the
        // engine may still have taken the turn — its replayed
        // `turn.started.ref` reclaims the message on resync, and the answer
        // dedupes on the same key either way.
        binding.consumed.delete(message.id);
        binding.queue.unshift(message);
        return true;
      }
      if (engineErrorCode(error) === INVALID_STATE) {
        this.opts.log.warn("prompt requeue: invalid_state", {
          messageId: message.id,
          error: String(error),
        });
        binding.consumed.delete(message.id);
        this.insertQueued(binding, message);
        return true;
      }
      if (engineErrorCode(error) === SESSION_NOT_FOUND) {
        this.opts.log.warn("prompt requeue: session_not_found", {
          messageId: message.id,
        });
        binding.consumed.delete(message.id);
        binding.queue.unshift(message);
        await this.rebindConversation(binding);
        return true;
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
    return false;
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
  private async rewindConversation(
    params: ConversationsRewindHostParams,
  ): Promise<ConversationsRewindHostResult> {
    const binding = this.bindings.get(params.conversationId);
    /* #274 same overtaking class as interrupt: a rewind landing inside a
       send's pre-dispatch window would restore the folder and then the
       pending prompt still runs. Wait for in-flight sends to dispatch —
       then either a turn exists and the conflict below refuses, or the
       send bailed and the rewind proceeds. */
    if (binding?.promptGates.size) await Promise.all(binding.promptGates);
    // A rebind may have swapped the binding while the gates were held.
    if (this.bindings.get(params.conversationId)?.runningTurnId) {
      throw Object.assign(
        new Error("a turn is still running — stop it before rewinding"),
        { code: -32009 },
      );
    }
    /* Stored cwd may be `~/x` (host fs echoes collapsed): expand before
       any spawn/fs use — literal `~` is not a valid cwd for execFile. */
    const cwd = expandPath(
      params.cwd ?? binding?.cwd ?? this.opts.workdir,
      this.home,
    );
    /* Engine first: a refusal (INVALID_STATE — a turn is running) must leave
       everything untouched, before any file or queue mutation. */
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
    let filesRestored = false;
    if (params.checkpoint && this.opts.checkpoints) {
      await this.opts.checkpoints.restore(cwd, params.checkpoint);
      filesRestored = true;
    }
    /* Queued-behind-a-turn user messages at/after the rewind point never
       send; release their delivery claims so nothing re-prompts them. The
       `early` map holds the same kind of queued sends for sessions with no
       binding yet — prune it identically. */
    if (binding) {
      binding.queue = binding.queue.filter((m) => {
        if (m.seq >= params.fromSeq) binding.consumed.delete(m.id);
        return m.seq < params.fromSeq;
      });
    }
    const early = this.early.get(params.conversationId);
    if (early?.length) {
      const kept = early.filter((m) => m.seq < params.fromSeq);
      if (kept.length) this.early.set(params.conversationId, kept);
      else this.early.delete(params.conversationId);
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

  /**
   * Can a send still produce a turn on this conversation? Every tracked
   * resting place of a not-yet-turned send counts: bind or rebind in
   * flight, a `deliver` between its claim and `enqueueOrPrompt`, the
   * held-for-engine `early` queue, the binding's wait queue, steers
   * pending a pump, a prompt mid-dispatch, and a send claimed into
   * `consumed` whose `turn.started` never landed. A bare binding or a
   * running turn is NOT pending — neither produces the next turn alone.
   */
  private sendCanProduceTurn(conversationId: string): boolean {
    if (this.binds.has(conversationId)) return true;
    if (this.rebinds.has(conversationId)) return true;
    if ((this.inFlightDeliveries.get(conversationId) ?? 0) > 0) return true;
    if ((this.early.get(conversationId)?.length ?? 0) > 0) return true;
    const binding = this.bindings.get(conversationId);
    if (!binding) return false;
    if (binding.queue.length > 0) return true;
    if (binding.steerPending.length > 0) return true;
    if (binding.promptGates.size > 0) return true;
    /* A consumed send whose ref never became a `turnSource` value is
       claimed by the engine but has no turn yet — the post-dispatch,
       pre-`turn.started` stretch. (Size comparison alone lies: a removed
       send's ref lingers in turnSource after `consumed` drops it.) */
    const turned = new Set(binding.turnSource.values());
    for (const id of binding.consumed) if (!turned.has(id)) return true;
    return false;
  }

  /**
   * #402: a parked Stop lives only as long as the send it waits on — once
   * nothing can still produce that send's first turn, keeping it would
   * fire the interrupt on a later unrelated turn instead of the one the
   * user meant.
   */
  private dropParkedInterruptIfOrphaned(
    conversationId: string | null | undefined,
  ) {
    if (!conversationId || !this.pendingInterrupts.has(conversationId)) return;
    if (this.sendCanProduceTurn(conversationId)) return;
    this.pendingInterrupts.delete(conversationId);
  }

  private async bindingFor(
    conv: Conversation,
    channelId: string,
  ): Promise<SessionBinding | undefined> {
    const existing = this.bindings.get(conv.id);
    if (existing) return existing;
    const inFlight = this.binds.get(conv.id);
    if (inFlight) return inFlight;
    const pending = this.bindConversation(conv, channelId).finally(() => {
      this.binds.delete(conv.id);
      /* A parked Stop is moot when the bind produced nothing to stop — drop
         it instead of interrupting whatever turn the next bind creates. */
      if (!this.bindings.has(conv.id)) this.pendingInterrupts.delete(conv.id);
    });
    this.binds.set(conv.id, pending);
    return pending;
  }

  private async bindConversation(
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
          cwd: expandPath(conv.cwd ?? this.opts.workdir, this.home),
          lastSeq: 0,
          queue: [],
          promptGates: new Set(),
          inflightPrompts: new Set(),
          textByTurn: new Map(),
          pickByTurn: new Map(),
          consumed: new Set(),
          turnSource: new Map(),
          steerPending: [],
          stopRequested: false,
        };
        this.bindings.set(conv.id, binding);
        this.conversationBySession.set(conv.engineRef, conv.id);
        this.applyReplay(binding, replay);
        this.rebuildHeldPick(binding, conv, replay.snapshot);
        /* Reattach carries no `engineSessionId` — the stored key was never
           stored on the conversation. Create the gateway session anyway;
           the alias lands on the next `session.ref.changed` (#339). */
        const employee = await this.resolveEmployee(conv);
        const surface = this.createSurfaces(binding, conv, employee);
        binding.gatewaySession = surface?.session;
        return binding;
      } catch (error) {
        if (engineErrorCode(error) !== SESSION_NOT_FOUND) throw error;
      }
    }

    /* A workstream open (#156 mode "new") materializes its worktree before
       the first `session.start`; a failure leaves the thread idle with a
       system note rather than starting the session in the wrong folder.
       The held message re-delivers on the next register (pending list). */
    if (conv.workspace?.mode === "new") {
      try {
        await this.ensureWorktree(conv);
      } catch (error) {
        this.opts.log.error("worktree creation failed", {
          conversationId: conv.id,
          error: String(error),
        });
        await this.postSystem(
          { channelId, conversationId: conv.id },
          `Couldn't create worktree ${conv.workspace.branch} — ${error instanceof Error ? error.message : String(error)}`,
          `sys:${conv.id}:worktree`,
        );
        return undefined;
      }
    }

    const employee = await this.resolveEmployee(conv);
    const agent = await this.ensureAgent(conn, employee);
    const binding: SessionBinding = {
      conversationId: conv.id,
      channelId,
      sessionId: "",
      ref: "",
      cwd: expandPath(conv.cwd ?? this.opts.workdir, this.home),
      lastSeq: 0,
      queue: [],
      promptGates: new Set(),
      inflightPrompts: new Set(),
      textByTurn: new Map(),
      pickByTurn: new Map(),
      consumed: new Set(),
      turnSource: new Map(),
      steerPending: [],
      stopRequested: false,
    };
    const surface = this.createSurfaces(binding, conv, employee);
    const started = await conn.request<{
      sessionId: string;
      ref?: string;
      engineSessionId?: string;
    }>(
      "session.start",
      this.sessionParams(employee, agent, conv, surface?.mcpServer),
    );
    this.aliasSurfaces(surface?.session, started.engineSessionId);
    binding.sessionId = started.sessionId;
    binding.ref = started.ref ?? started.sessionId;
    binding.engineSessionId = started.engineSessionId;
    binding.gatewaySession = surface?.session;
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
    /* Live stream for paired phones (#157): every engine event of a
       conversation-bound session is re-published on the relay, which
       re-emits it on the conversation's channel. Errors are swallowed —
       the phone heals itself via `session.events` replay. */
    if (convId) {
      this.opts.relay
        .request("engine.event", {
          conversationId: convId,
          sessionId: event.sessionId,
          event,
        })
        .catch(() => {});
    }
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
        /* The stop window ends: this turn (prompted or engine-pumped) runs
           to completion — nothing queued or steer-pending is parked on it. */
        binding.stopRequested = false;
        binding.stopParked = false;
        if (binding.steerReconcileTimer) {
          clearTimeout(binding.steerReconcileTimer);
          binding.steerReconcileTimer = undefined;
        }
        /* #400: a Stop fired while this turn's bind was still in its awaits
           parked on `pendingInterrupts` — fire it now that the turn exists
           (the engine acks interrupted:true instead of dropping it). */
        if (convId && this.pendingInterrupts.delete(convId)) {
          this.opts.log.info("interrupt requested", {
            conversationId: convId,
          });
          binding.stopRequested = true;
          const conn = this.engine;
          if (conn)
            void conn
              .request("interrupt", { sessionId: binding.sessionId })
              .catch((e) =>
                this.opts.log.warn("parked interrupt failed", {
                  error: String(e),
                }),
              );
        }
        if (event.payload.ref) {
          binding.consumed.add(event.payload.ref);
          binding.turnSource.set(event.payload.turnId, event.payload.ref);
          /* A pumped steer became a real turn input — it's consumed now,
             not pending (a later Stop has no pending left to drop). */
          binding.steerPending = binding.steerPending.filter(
            (s) => s.messageId !== event.payload.ref,
          );
          /* #377: this turn proves the engine took the message — a copy
             parked in the queue by a transport-error re-queue (the socket
             dropped after the prompt landed) is dead; left in place the
             drain would mint a duplicate turn when this one ends. */
          if (binding.queue.some((m) => m.id === event.payload.ref))
            this.opts.log.warn("turn claimed queued copy", {
              turnId: event.payload.turnId,
              ref: event.payload.ref,
            });
          binding.queue = binding.queue.filter(
            (m) => m.id !== event.payload.ref,
          );
          /* #315 AC-4: the message behind this turn was removed while its
             steer or prompt raced in — the engine pumped it anyway.
             Interrupt the turn the ghost alone created instead of running
             removed text. */
          if (this.dismissed.has(event.payload.ref)) {
            const conn = this.engine;
            if (conn) {
              void conn
                .request("interrupt", { sessionId: binding.sessionId })
                .catch((e) =>
                  this.opts.log.warn("removed-message interrupt failed", {
                    error: String(e),
                  }),
                );
            }
          }
        }
        this.opts.sleep.acquire();
        this.updateConversation(binding.conversationId, {
          state: "active",
        }).catch(() => {});
        break;
      case "session.titled": {
        /* #137: the engine named its session (derived → llm). Write it as the
           conversation title — a host "auto" write, so the relay drops it
           atomically once the row is user-named; the metaSeen check just
           skips a doomed write when we've already seen the rename. */
        if (!binding || !this.hasAutoTitle()) break;
        if (this.metaSeen.get(binding.conversationId)?.titleSource === "user")
          break;
        this.updateConversation(binding.conversationId, {
          title: event.payload.title,
        }).catch((error) =>
          this.opts.log.warn("engine title write failed", {
            error: String(error),
          }),
        );
        break;
      }
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
          /* The rotated ref IS the engine's stored session id — keep the
             gateway alias current so plugin calls resolve this scope. */
          binding.engineSessionId = event.payload.ref;
          this.aliasSurfaces(binding.gatewaySession, event.payload.ref);
          this.opts.log.info("session ref rotated", {
            sessionId: event.sessionId,
            ref: event.payload.ref,
          });
        }
        break;
      case "turn.steered":
        /* The steer landed inside the turn — pair it to its relay message
           (payload carries text only) so it's no longer a pending steer. */
        if (binding) {
          const idx = binding.steerPending.findIndex(
            (s) => s.text === event.payload.text,
          );
          if (idx >= 0) binding.steerPending.splice(idx, 1);
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
      /* The relay dedupes a replayed open, and it can come back already
         resolved: the click landed while our socket was down, so the
         ask.resolved event never reached us (fire-and-forget). Forward it
         or the engine waits forever on an answer that already happened
         (#298). */
      if (result.ask.state === "resolved") {
        void this.onAskResolved(result.ask).catch((error) =>
          this.opts.log.warn("resolved ask forward failed", {
            askId: result.ask.id,
            error: String(error),
          }),
        );
      }
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
      case "settings.changed": {
        // #339: the Connect step's one-time approval toggles the reconciler.
        if (params.key === CONNECT_APPROVAL_KEY)
          void this.opts.connect?.reconcile();
        break;
      }
      case "employee.upserted": {
        // A new hire's profile needs the plugin when Connect is approved.
        void this.opts.connect?.reconcile();
        break;
      }
      case "employee.removed": {
        // Disable the leaving employee's plugin — never delete the profile.
        const parsed = EmployeeRemovedEvent.safeParse(params);
        if (parsed.success) {
          this.opts.connect?.employeeRemoved(parsed.data.employeeId);
          void this.opts.connect?.reconcile();
        }
        break;
      }
      case "ask.resolved": {
        const parsed = AskResolvedEvent.safeParse(params);
        if (parsed.success) {
          void this.onAskResolved(parsed.data.ask).catch((error) =>
            this.opts.log.warn("ask respond forward failed", {
              askId: parsed.data.ask.id,
              error: String(error),
            }),
          );
        }
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
              titleSource: conv.titleSource,
            });
          }
          break;
        }
        if (
          seen &&
          seen.title === conv.title &&
          seen.archived === conv.archived &&
          seen.titleSource === conv.titleSource
        ) {
          break;
        }
        this.mirrorMeta(binding, conv);
        break;
      }
      case "message.changed": {
        /* #315: a tray action flipped `dropped`/`removed` on the relay.
           removed → the engine must never see it: splice it out of every
           in-memory hold and dismiss it permanently. dropped → park it
           out of the queue (re-Send re-delivers it fresh below). */
        const parsed = MessageChangedEvent.safeParse(params);
        if (!parsed.success) break;
        const message = parsed.data.message;
        const binding = message.conversationId
          ? this.bindings.get(message.conversationId)
          : undefined;
        const fromQueue = (list: AppMessage[]) =>
          list.filter((m) => m.id !== message.id);
        if (message.removed) {
          this.dismissed.add(message.id);
          this.delivered.delete(message.id);
          if (binding) {
            binding.queue = fromQueue(binding.queue);
            binding.steerPending = binding.steerPending.filter(
              (s) => s.messageId !== message.id,
            );
            binding.consumed.delete(message.id);
          }
          const early = this.early.get(message.conversationId ?? "");
          if (early?.length)
            this.early.set(message.conversationId ?? "", fromQueue(early));
          /* The send a parked interrupt waited on is gone — clear it
             instead of firing it on a later unrelated turn (#402). */
          this.dropParkedInterruptIfOrphaned(message.conversationId);
        } else if (message.dropped) {
          if (binding) {
            binding.queue = fromQueue(binding.queue);
            binding.steerPending = binding.steerPending.filter(
              (s) => s.messageId !== message.id,
            );
            binding.consumed.delete(message.id);
          }
          const early = this.early.get(message.conversationId ?? "");
          if (early?.length)
            this.early.set(message.conversationId ?? "", fromQueue(early));
          this.dropParkedInterruptIfOrphaned(message.conversationId);
          /* A later Send re-delivers: release the delivery claim AND let it
             past the deliveredSeq watermark (an accepted-then-parked steer
             sits under it). */
          this.delivered.delete(message.id);
          this.redeliver.add(message.id);
        } else if (this.dismissed.has(message.id) || this.redeliver.has(message.id)) {
          /* `dropped` cleared (Send): re-deliver like a fresh send. Only a
             row that was parked here (`dismissed`) or seen dropped
             (`redeliver`, primed in the branch above) can un-drop — other
             `message.changed` frames (e.g. our own `messages.claim`,
             #377) carry no drop to undo, and re-delivering them would
             queue the same send twice behind a re-queue. The `redeliver`
             claim was primed when the drop was parked; if the flag flip
             arrives without a local drop (another client undid it), arm
             it here so the watermark can't swallow the resend. */
          this.dismissed.delete(message.id);
          this.delivered.delete(message.id);
          this.redeliver.add(message.id);
          void this.deliver(message).catch((error) =>
            this.opts.log.warn("message resend failed", {
              error: String(error),
            }),
          );
        }
        break;
      }
      case "conversation.rewound": {
        /* #400: the relay marks the rewound tail in one batch — no per-message
           `message.changed` fires — so fold its removedIds into the same
           kill-set those events feed. A `deliver` still in flight when the
           host-side handler pruned `early`/`queue` lands past the prune;
           every later gate (early flush, enqueue, register pending) consults
           `dismissed`, and re-splicing the holds here removes what slipped
           in between. */
        const parsed = ConversationRewoundEvent.safeParse(params);
        if (!parsed.success) break;
        const { conversationId, removedIds } = parsed.data;
        const binding = conversationId
          ? this.bindings.get(conversationId)
          : undefined;
        const holds = (list: AppMessage[]) =>
          list.filter((m) => !removedIds.includes(m.id));
        for (const removedId of removedIds) {
          this.dismissed.add(removedId);
          this.delivered.delete(removedId);
          if (binding) {
            binding.consumed.delete(removedId);
            binding.steerPending = binding.steerPending.filter(
              (s) => s.messageId !== removedId,
            );
          }
        }
        if (binding) binding.queue = holds(binding.queue);
        const early = this.early.get(conversationId ?? "");
        if (early?.length) this.early.set(conversationId ?? "", holds(early));
        this.dropParkedInterruptIfOrphaned(conversationId);
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
        ConversationsRewindHostParams.parse(params),
      );
    }
    /* `folders.detail` (#156): the relay gates the path to recents and
       forwards here — the only process that can run git on this machine. */
    if (method === "folders.detail") {
      return this.folderDetail(FoldersDetailParams.parse(params));
    }
    /* `folders.browse`/`folders.discover` (#238): the phone's folder
       browser — the home-folder boundary is enforced here, server-side,
       because the caller is a remote device. */
    if (method === "folders.browse") {
      return this.folderBrowse(FoldersBrowseParams.parse(params));
    }
    if (method === "folders.discover") {
      return this.folderDiscover();
    }
    /* `forge.prs` (#159): a thread's PRs — the relay resolves the
       conversation's folder + branch(es) and forwards here, the only
       `gh`-capable process. The host API validates params + result. */
    if (method === "forge.prs") {
      return callHost("forge.prs", params);
    }
    /* `events.since` (#157): the relay's `session.events` maps a
       conversationId onto its bound engine session and forwards here —
       verbatim engine replay, so a device-scope client never sees a
       session id it didn't resolve through the conversation. */
    if (method === "events.since") {
      const parsed = EventsSinceParams.parse(params);
      return this.eventsSince(parsed.sessionId, parsed.after);
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
   * `folders.detail` probe (#156): branches + linked worktrees of one
   * recents-listed folder — the picker's "New workstream from" and
   * "Continue a workstream" rows. The repo's own checkout is filtered out
   * of `workstreams` (it is the "direct" mode, not a workstream).
   */
  private async folderDetail(
    params: FoldersDetailParams,
  ): Promise<FoldersDetailResult> {
    const abs = expandPath(params.path, this.home);
    const empty = {
      path: params.path,
      isRepo: false,
      branches: [] as string[],
      workstreams: [],
    };
    if (!existsSync(abs)) return { ...empty, missing: true };
    const probe = await gitIsRepo({ path: abs });
    if (!probe.isRepo || !probe.root) return { ...empty, missing: false };
    const [branches, worktrees] = await Promise.all([
      gitBranches({ path: abs }),
      gitWorktrees({ path: abs }),
    ]);
    const root = resolve(expandPath(probe.root, this.home));
    return {
      ...empty,
      missing: false,
      isRepo: true,
      root: probe.root,
      current: branches.current,
      branches: branches.branches,
      remote: branches.remote,
      workstreams: worktrees.worktrees
        .filter(
          (w) =>
            w.branch !== undefined &&
            resolve(expandPath(w.path, this.home)) !== root,
        )
        .map((w) => ({
          branch: w.branch ?? "",
          path: w.path,
          ...(w.from ? { from: w.from } : {}),
        })),
    };
  }

  /**
   * `folders.browse` (#238): one folder level under the Mac's home — dirs
   * only, dot-dirs skipped, repo children carrying their branch (the same
   * marks the web AddFolderDialog paints on `fs.list`). The listed dir's
   * own `branch` is its containing repo's current branch (the web's
   * `hostIsRepo`+`hostBranches` probe). Anything that resolves outside
   * home — `..`, absolute paths, symlink hops, dot-dir segments — is
   * refused before any listing happens.
   */
  private async folderBrowse(
    params: FoldersBrowseParams,
  ): Promise<FoldersBrowseResult> {
    const home = this.home;
    const abs = resolveUnderHome(params.path, home);
    if (!abs) {
      throw new HostError(
        HOST_ERRORS.OUTSIDE_ROOT,
        `path is outside the Mac's home folder: ${params.path}`,
      );
    }
    const [list, self] = await Promise.all([
      fsList({ path: abs }),
      gitBranches({ path: abs }).catch(() => null),
    ]);
    return {
      path: collapsePath(abs, home),
      ...(self?.current ? { branch: self.current } : {}),
      folders: list.entries
        .filter((e) => e.kind === "dir" && !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          path: collapsePath(join(abs, e.name), home),
          ...(e.repo?.head ? { branch: e.repo.head } : {}),
        })),
    };
  }

  /**
   * `folders.discover` (#238): repos under the web's "Found on this Mac"
   * roots, each re-checked against the home boundary so a symlinked scan
   * root can't leak outside paths.
   */
  private async folderDiscover(): Promise<FoldersDiscoverResult> {
    const home = this.home;
    /* Same roots as the web picker (apps/web/src/lib/host.ts hostRoots). */
    const roots = ["~/Desktop", "~/Developer", "~/Documents", "~/repos"].map(
      (r) => expandPath(r, home),
    );
    const { repos } = await gitDiscoverRepos({ roots });
    return {
      repos: repos.flatMap((r) => {
        const abs = resolveUnderHome(r.path, home);
        return abs
          ? [
              {
                path: collapsePath(abs, home),
                ...(r.head ? { branch: r.head } : {}),
              },
            ]
          : [];
      }),
    };
  }

  /**
   * A `workspace.mode === "new"` open (#156) carries `cwd` as the worktree
   * path the picker computed (`<repo>/.lilos/wt/<slug>`): make it real with
   * `git worktree add -b <branch> <base>` before the first `session.start`,
   * unless a registered worktree already sits there (rebind after a
   * restart, a redelivered turn).
   */
  private async ensureWorktree(conv: Conversation): Promise<void> {
    const ws = conv.workspace;
    if (ws?.mode !== "new" || !conv.cwd) return;
    const dir = resolve(expandPath(conv.cwd, this.home));
    const { worktrees } = await gitWorktrees({ path: ws.repoPath });
    if (worktrees.some((w) => resolve(expandPath(w.path, this.home)) === dir))
      return;
    await worktreeAdd({
      path: ws.repoPath,
      dir,
      branch: ws.branch,
      base: ws.base,
    });
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
      this.pendingInterrupts.delete(binding.conversationId);
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
    if (!conn) {
      // Engine detached mid-forward: keep the mapping so the next
      // reconcileAsks can retry — dropping it parks the turn forever.
      this.requestByAsk.set(ask.id, rec);
      this.askByRequest.set(`${rec.sessionId}:${rec.requestId}`, ask.id);
      return;
    }
    try {
      await conn.request("request.respond", {
        sessionId: rec.sessionId,
        requestId: rec.requestId,
        outcome: ask.outcome,
        ...(ask.answer ? { answer: ask.answer } : {}),
      });
    } catch (error) {
      if (engineErrorCode(error) !== REQUEST_NOT_FOUND) {
        // Same: a failed forward stays mapped so reconcileAsks retries it.
        this.requestByAsk.set(ask.id, rec);
        this.askByRequest.set(`${rec.sessionId}:${rec.requestId}`, ask.id);
        throw error;
      }
      this.opts.log.warn("engine request already gone", {
        requestId: rec.requestId,
      });
    }
  }

  private async onInterruptRequested(conversationId: string) {
    const binding = this.bindings.get(conversationId);
    if (
      !binding ||
      (!binding.runningTurnId && this.sendCanProduceTurn(conversationId))
    ) {
      /* #400/#402: the UI already reads Running off the send-pending
         marker, so a Stop here is real, not stray — whether the send's
         row hasn't reached the `channelMessages` subscription yet, the
         relay's bus event beating the store path (#402), its first bind
         still mid-flight (#400), or it bound but its prompt hasn't become
         a turn on the engine — an interrupt dispatched in that last
         stretch overtakes `prompt` only to ack `interrupted:false` and
         die. Park on the conversation instead; the send's first
         `turn.started` fires it, when the engine provably has a turn to
         cancel. (A bound-and-idle conv has nothing pending: the Stop
         falls through and the engine acks `interrupted:false`, as
         before.) */
      if (binding) binding.stopRequested = true;
      this.pendingInterrupts.add(conversationId);
      this.opts.log.info("interrupt parked", { conversationId });
      return;
    }
    this.opts.log.info("interrupt requested", { conversationId });
    /* #315 AC-5: park everything still waiting while the stop propagates —
       even a queue item behind a sendPrompt gate must drop rather than
       prompt once the turn clears. */
    binding.stopRequested = true;
    /* #274: a sendPrompt still in its pre-dispatch awaits hasn't put
       `prompt` on the wire — an interrupt sent now overtakes it and the
       engine acks interrupted:false (no live turn), silently swallowing
       the Stop. Wait for in-flight sends to dispatch; the in-order conn
       then lands prompt → interrupt, so the engine has a turn to stop. */
    await Promise.all(binding.promptGates);
    const conn = this.engine;
    // A rebind may have swapped the binding while the gates were held.
    const live = this.bindings.get(conversationId);
    if (!conn || !live) return;
    try {
      await conn.request("interrupt", { sessionId: live.sessionId });
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

    /* #315 AC-5: ■ Stop parks everything still waiting — queued sends and
       accepted-but-unlanded steers alike land in the not-sent tray
       (dropped), never the engine. The sweep rides the delivery chain
       (#377): every `deliver` already in flight when the turn ended is a
       pre-stop send and must park too — running ahead of it would let a
       sent-before-Stop message slip past the tray. Sends arriving after
       the sweep link see the flag cleared and prompt fresh. Parked ids
       join `dismissed` so a late `not_running` steer ack holding a stale
       (pre-drop) row can't re-prompt it; Send clears both. */
    if (binding.stopRequested) {
      void this.ordered(binding.conversationId, async () => {
        binding.stopRequested = false;
        binding.stopParked = true;
        /* #402: every send a pre-bind parked interrupt could still wait on
           just dropped to the tray — the park is moot. */
        this.pendingInterrupts.delete(binding.conversationId);
        for (const pending of binding.steerPending.splice(0)) {
          binding.consumed.delete(pending.messageId);
          this.dismissed.add(pending.messageId);
          this.relayWrite(`drop steer ${pending.messageId}`, () =>
            this.opts.relay.request("messages.drop", {
              messageId: pending.messageId,
            }),
          );
        }
        for (const queued of binding.queue.splice(0)) {
          binding.consumed.delete(queued.id);
          this.dismissed.add(queued.id);
          this.relayWrite(`drop queued ${queued.id}`, () =>
            this.opts.relay.request("messages.drop", { messageId: queued.id }),
          );
        }
      });
      return;
    }
    /* An accepted steer that neither landed nor pumped as this turn's
       replacement is stranded — give it a grace window, then drop it. */
    this.scheduleSteerReconcile(binding);
    this.drainQueue(binding);
  }

  /* #315: an accepted steer (`session.steer` → `steered`) that neither
     landed (`turn.steered`) nor pumped as the next turn's `ref` was
     consumed but will never run — the user sees it "waiting" forever.
     After a short grace for late events, park it in the not-sent tray
     (`messages.drop`) so the user can Send it again. */
  private scheduleSteerReconcile(binding: SessionBinding) {
    if (binding.steerReconcileTimer) clearTimeout(binding.steerReconcileTimer);
    binding.steerReconcileTimer = setTimeout(() => {
      binding.steerReconcileTimer = undefined;
      /* A new turn owns the pend list again — its `turn.steered` / `ref`
         claims pair what the engine actually kept. */
      if (binding.runningTurnId || !binding.steerPending.length) return;
      for (const pending of binding.steerPending.splice(0)) {
        binding.consumed.delete(pending.messageId);
        this.relayWrite(`drop stranded steer ${pending.messageId}`, () =>
          this.opts.relay.request("messages.drop", {
            messageId: pending.messageId,
          }),
        );
      }
    }, 2000);
  }

  private unbind(binding: SessionBinding) {
    if (binding.gatewaySession) {
      const gw = binding.gatewaySession;
      binding.gatewaySession = undefined;
      void this.opts.surfaces?.destroy(gw).catch(() => {});
    }
    this.conversationBySession.delete(binding.sessionId);
    this.bindings.delete(binding.conversationId);
  }

  /**
   * Mint the gateway session backing a binding's surfaces (#337/#339):
   * the scope declares employee/channel/conversation up front; the
   * engine's own session id binds as an alias once `session.start`
   * returns it. `attach === "mcp"` also yields the stdio server spec the
   * session must carry; "plugin" engines reach the same surfaces
   * in-process (Hermes' lilos plugin resolves the alias instead).
   */
  private createSurfaces(
    binding: SessionBinding,
    conv: Conversation | undefined,
    employee: Employee | undefined,
  ): { session: string; mcpServer?: McpServerStdio } | undefined {
    const surfaces = this.opts.surfaces;
    if (!surfaces) return undefined;
    if (binding.gatewaySession) {
      void surfaces.destroy(binding.gatewaySession).catch(() => {});
      binding.gatewaySession = undefined;
    }
    const employeeId = this.employeeIdFor(conv);
    try {
      const handle = surfaces.create({
        cwd: binding.cwd,
        ...(employeeId && employee
          ? {
              binding: {
                employeeId,
                channelId: binding.channelId,
                conversationId: binding.conversationId,
              },
            }
          : {}),
      });
      return {
        session: handle.session,
        ...(this.opts.surfacesAttach === "mcp"
          ? { mcpServer: handle.mcpServer }
          : {}),
      };
    } catch (error) {
      this.opts.log.warn("surfaces session create failed", {
        conversationId: binding.conversationId,
        error: String(error),
      });
      return undefined;
    }
  }

  /** Alias the engine's own session id onto the gateway session (#339). */
  private aliasSurfaces(
    session: string | undefined,
    engineSessionId: string | undefined,
  ): void {
    if (!session || !engineSessionId || !this.opts.surfaces) return;
    try {
      this.opts.surfaces.bindEngineSession(session, engineSessionId);
    } catch {
      /* Late rotation after the gateway session died — next ref retries. */
    }
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
    mcpServer?: McpServerStdio,
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
    const cwd = expandPath(conv?.cwd ?? this.opts.workdir, this.home);
    return {
      ...base,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(effort ? { effort } : {}),
      ...(fast !== undefined ? { fast } : {}),
      cwd,
      ...(mcpServer ? { mcpServers: [mcpServer] } : {}),
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
      title?: string;
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
    target: { channelId: string; conversationId: string },
    text: string,
    dedupeKey?: string,
  ) {
    this.relayWrite(`system note "${text.slice(0, 24)}"`, () =>
      this.opts.relay.request("messages.post", {
        channelId: target.channelId,
        conversationId: target.conversationId,
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
