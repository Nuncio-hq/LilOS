// biome-ignore-all lint/correctness/noUnusedPrivateClassMembers: the moved
// harness/*.ts functions read/write these fields through the `this: HarnessCtx`
// receiver type; the class body itself only touches a few of them (#441).
import { homedir } from "node:os";
import type { RelayClient } from "@lilos/client-runtime";
import type {
  AppMessage,
  Employee,
  ProfileConnection,
} from "@lilos/contracts/app";
import type {
  DescribeResult,
  EngineEvent,
  EventsSinceResult,
  McpServer,
} from "@lilos/contracts/engine";
import type { CheckpointStore } from "@lilos/host";
import {
  type EngineConnection,
  engineErrorCode,
  SESSION_NOT_FOUND,
} from "./engine/client";
import type { EngineHostState } from "./engine/supervisor";
import { ensureAgent, sessionParams } from "./harness/agents";
import {
  autoApprove,
  onAskResolved,
  onEngineRequestResolved,
  openAsk,
  reconcileAsks,
} from "./harness/asks";
import {
  bindConversation,
  bindingFor,
  dropParkedInterruptIfOrphaned,
  onReaperSuspended,
  reaperCandidates,
  sendCanProduceTurn,
  sessionHasOpenAsk,
  suspendBinding,
  writeLife,
} from "./harness/bind";
import {
  conversationFromAtom,
  employeeIdFor,
  findConversation,
  postSystem,
  resolveEmployee,
  updateConversation,
} from "./harness/conversations";
import type { SessionBinding } from "./harness/ctx";
import {
  deliver,
  deliverOrdered,
  flushEarly,
  flushEarlyOrdered,
  ordered,
} from "./harness/delivery";
import {
  dispatchPrompt,
  markDelivered,
  sendPrompt,
  stampCheckpoint,
  unclaimMessage,
} from "./harness/dispatch";
import {
  applyReplay,
  describeAndHire,
  markTurnInterrupted,
  resyncBinding,
  surfaceBackendDown,
} from "./harness/engine-attach";
import { onEngineEvent } from "./harness/engine-events";
import {
  applyHeldPick,
  doApplyHeldPick,
  onModelRequested,
  rebuildHeldPick,
  setSessionModel,
} from "./harness/model-picks";
import {
  bindingNow,
  employeeNowLine,
  noteNow,
  pushEmployeeNow,
  sweepNow,
} from "./harness/now-line";
import { flushOutbox, relayWrite } from "./harness/outbox";
import {
  drainQueue,
  enqueueOrPrompt,
  insertQueued,
  liveBinding,
  promptOrQueue,
} from "./harness/queue";
import {
  doRebindConversation,
  mirrorMeta,
  rebindConversation,
} from "./harness/rebind";
import { onRelayReady } from "./harness/register";
import {
  onChannelRemoved,
  onRelayEvent,
  watchChannel,
} from "./harness/relay-events";
import {
  ensureWorktree,
  folderBrowse,
  folderDetail,
  folderDiscover,
  moveConversationFolder,
  onRelayRequest,
  rewindConversation,
} from "./harness/relay-requests";
import {
  dropStopped,
  exemptFromCurrentStop,
  onInterruptRequested,
  seqOfMessage,
  stopOwns,
} from "./harness/stops";
import {
  aliasSurfaces,
  createSurfaces,
  finishTurn,
  scheduleSteerReconcile,
  unbind,
} from "./harness/turns";
import type { Logger } from "./log";
import { type ReaperCandidate, SessionReaper } from "./reaper";
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
    }): { session: string; mcpServer: McpServer };
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
  /** #339 Connect reconciler: reconciles the lilos plugin per employee
     profile after approval, reports the rows on `harness.report`.
     Undefined on engines without Connect support (#413: hermes, and
     engine-fake under LILOS_CONNECT_FAKE for e2e). */
  connect?: {
    reconcile(): Promise<void>;
    employeeRemoved(employeeId: string): void;
    report(): ProfileConnection[];
  };
  /** #346 AC-3: suspend a bound session after this much quiet time (ms).
     `0`/undefined = never — the AC's 30-minute default arrives via
     `LILOS_SESSION_IDLE_MINUTES` in config.ts. */
  sessionIdleMs?: number;
  /** #346 AC-3: the reaper's check period — the AC's "every minute".
     Tests shrink it; the env knob only sets `sessionIdleMs`. */
  reaperIntervalMs?: number;
  /** #459: e2e-only probe — hold every session bind this long (ms) at its
     start, so a send arriving pre-bind lands in the same ~1s window the
     loaded run measured. `0`/unset = no hold (`LILOS_BIND_DELAY_MS`). */
  bindDelayMs?: number;
}

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

  /* #403: the causal line a Stop stamped on its conversation. The relay
     emits `turn.interruptRequested` on the event bus while the sends it
     logically follows travel `channelMessages` — the two paths are not
     ordered against each other, so a pre-Stop send can land AFTER the
     Stop's drain ran and prompt a fresh turn past it. `afterSeq` is the
     channel seq the interrupt follows: sends at or below it park in the
     not-sent tray wherever they surface (queue, steer, a late `deliver`),
     sends above it postdate the Stop and run. `stopExempt` marks rows the
     user re-Sent from the tray — same id, same seq, new intent — so the
     gate can't park a Send twice. The exemption is scoped to the Stop it
     escaped: `stopGenerations` counts interrupt events per conversation
     and a Send records the generation it was made under — the next Stop,
     stamped or not, owns the send like any other row. */
  private readonly stopSeqs = new Map<string, number>();

  private readonly stopGenerations = new Map<string, number>();

  private readonly stopExempt = new Map<
    string,
    { conversationId: string; generation: number }
  >();

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

  /** #422: monotonic clock — per-binding now-line freshness. */
  private nowClock = 0;

  /** #422: employeeId -> the now-line the harness last pushed. */
  private readonly nowWritten = new Map<string, string>();

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

  /** #346 AC-3: suspends bound sessions idle past `sessionIdleMs`. */
  private readonly reaper: SessionReaper;

  /** Per-conversation delivery chains (#377): `deliver`'s own awaits
      (conversation lookup, bind, replay) leave a window where a later send
      enqueues first — the queue and the wire then disagree on send order.
      Each link always resolves so a failed send can't park the convo. */
  private deliveryChains = new Map<string, Promise<void>>();

  /** Live engine sessions the harness owns (status reports this — #33). */
  get liveSessionCount(): number {
    return this.conversationBySession.size;
  }

  /* The Mac user's home this harness serves — `~` on the wire means this
     directory (device-scope folder reads stay under it). */
  private readonly home: string;

  constructor(private readonly opts: HarnessOptions) {
    this.home = opts.homeDir ?? homedir();
    this.reaper = new SessionReaper({
      idleMs: opts.sessionIdleMs ?? 0,
      intervalMs: opts.reaperIntervalMs ?? 60_000,
      log: opts.log,
      candidates: () => this.reaperCandidates(),
      suspend: (sessionId) => this.suspendBinding(sessionId),
      onSuspended: (conversationId, sessionId) =>
        this.onReaperSuspended(conversationId, sessionId),
    });
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
    this.reaper.start();
  }

  declare private onRelayReady: () => Promise<void>;

  async stop(): Promise<void> {
    this.reaper.stop();
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

  declare private describeAndHire: (conn: EngineConnection) => Promise<void>;

  declare private resyncBinding: (binding: SessionBinding) => Promise<void>;

  /* ------------------------- message -> engine -------------------------- */

  declare private flushEarly: (convId: string) => Promise<void>;

  /* ------------------------- #346 idle reaper ------------------------- */

  declare private reaperCandidates: () => ReaperCandidate[];

  declare private suspendBinding: (sessionId: string) => Promise<void>;

  declare private onReaperSuspended: (
    conversationId: string,
    sessionId: string,
  ) => void;

  /* ------------------------- engine -> relay ---------------------------- */

  declare private onEngineEvent: (event: EngineEvent) => void;

  /* --------------------------- relay -> engine -------------------------- */

  declare onRelayEvent: (
    method: string,
    params: Record<string, unknown>,
  ) => void;

  declare private onRelayRequest: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}
/* ------------------------- moved members (#441) -------------------------
   The private section methods live in `./harness/*.ts` as
   `(this: HarnessCtx, …)` functions. Assigning them to the prototype
   keeps `this.name()` dispatch identical inside both the moved bodies
   and the class methods above — same call sites, no delegate bodies.
   (`declare` fields above are the type-level half for the few the class
   itself calls.) */
Object.assign(Harness.prototype, {
  aliasSurfaces,
  applyHeldPick,
  applyReplay,
  autoApprove,
  bindConversation,
  bindingFor,
  bindingNow,
  conversationFromAtom,
  createSurfaces,
  deliver,
  deliverOrdered,
  describeAndHire,
  dispatchPrompt,
  doApplyHeldPick,
  doRebindConversation,
  drainQueue,
  dropParkedInterruptIfOrphaned,
  dropStopped,
  employeeIdFor,
  employeeNowLine,
  enqueueOrPrompt,
  ensureAgent,
  ensureWorktree,
  exemptFromCurrentStop,
  findConversation,
  finishTurn,
  flushEarly,
  flushEarlyOrdered,
  flushOutbox,
  folderBrowse,
  folderDetail,
  folderDiscover,
  insertQueued,
  liveBinding,
  markDelivered,
  markTurnInterrupted,
  mirrorMeta,
  moveConversationFolder,
  noteNow,
  onAskResolved,
  onChannelRemoved,
  onEngineEvent,
  onEngineRequestResolved,
  onInterruptRequested,
  onModelRequested,
  onReaperSuspended,
  onRelayEvent,
  onRelayReady,
  onRelayRequest,
  openAsk,
  ordered,
  postSystem,
  promptOrQueue,
  pushEmployeeNow,
  reaperCandidates,
  rebindConversation,
  rebuildHeldPick,
  reconcileAsks,
  relayWrite,
  resolveEmployee,
  resyncBinding,
  rewindConversation,
  scheduleSteerReconcile,
  sendCanProduceTurn,
  sendPrompt,
  seqOfMessage,
  sessionHasOpenAsk,
  sessionParams,
  setSessionModel,
  stampCheckpoint,
  stopOwns,
  surfaceBackendDown,
  suspendBinding,
  sweepNow,
  unbind,
  unclaimMessage,
  updateConversation,
  watchChannel,
  writeLife,
});
