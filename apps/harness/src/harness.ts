// biome-ignore-all lint/correctness/noUnusedPrivateClassMembers: the moved
// harness/*.ts functions read/write these fields through the `this: HarnessCtx`
// receiver type; the class body itself only touches a few of them (#441).
import { homedir } from "node:os";
import { join } from "node:path";
import type { RelayClient } from "@lilos/client-runtime";
import type {
  AppMessage,
  Conversation,
  Employee,
  ProfileConnection,
  ScheduledTask,
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
  RESUME_AWARE_TIMEOUT_MS,
  SESSION_NOT_FOUND,
} from "./engine/client";
import type { EngineRegistry } from "./engine/registry";
import {
  DEFAULT_RUNTIME,
  normalizeRuntime,
  parseSessionRef,
  qualifySessionRef,
} from "./engine/runtimes";
import type { EngineGapCause, EngineHostState } from "./engine/supervisor";
import {
  checkTaskModel,
  codingAgentDefaults,
  ensureAgent,
  sessionParams,
} from "./harness/agents";
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
import { stopCeoLoop, wireCeoLoop } from "./harness/ceo-loop";
import { execSlashCommand, slashFor } from "./harness/commands";
import {
  conversationFromAtom,
  employeeIdFor,
  findConversation,
  postSystem,
  releaseIdleFailedRuntimes,
  resolveEmployee,
  runtimeFailedFor,
  runtimeFailureDetail,
  runtimeForConversation,
  updateConversation,
} from "./harness/conversations";
import type { HarnessCtx, SessionBinding } from "./harness/ctx";
import {
  deliver,
  deliverOrdered,
  dropEarlyWithError,
  flushEarly,
  flushEarlyOrdered,
  ordered,
  scheduleEarlyFlush,
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
  agentsListMerged,
  ensureWorktree,
  folderBrowse,
  folderDetail,
  folderDiscover,
  moveConversationFolder,
  onRelayRequest,
  rewindConversation,
} from "./harness/relay-requests";
import {
  fireScheduledTask,
  onScheduledConversationUpdate,
  onScheduleRemoved,
  onScheduleUpserted,
  scheduledRunStillGoing,
  skipScheduledRun,
  syncScheduledTasks,
  wireScheduler,
} from "./harness/scheduler";
import {
  dropStopped,
  exemptFromCurrentStop,
  onInterruptRequested,
  seqOfMessage,
  stopOwns,
} from "./harness/stops";
import { stopStuckWatches } from "./harness/stuck";
import { stopTaskLoop } from "./harness/task-wake";
import {
  aliasSurfaces,
  createSurfaces,
  finishTurn,
  scheduleSteerReconcile,
  unbind,
} from "./harness/turns";
import { cleanupSettledWorktree } from "./harness/worktree-cleanup";
import type { Logger } from "./log";
import { type ReaperCandidate, SessionReaper } from "./reaper";
import type { TaskScheduler } from "./scheduler";
import type { SleepGuard } from "./sleep";

/**
 * The workspace harness: the ONLY component that talks to the engine
 * (D-#26). It connects to the relay, registers as the engine
 * host, binds each conversation (thread) to one engine session, forwards user
 * messages as prompts, surfaces engine asks (approvals/questions) on the
 * relay, posts final answers back, and holds the sleep assertion while a
 * turn runs. It also owns the engine's lifecycle: launch
 * (`engine/launcher.ts` — the packages/engine-hermes adapter, which runs
 * `hermes serve` on 127.0.0.1 with a generated token; D-#482) and crash
 * restart with bounded backoff (`engine/supervisor.ts`). The app reads
 * engine state only through the harness feed (`feed.ts`, read-only); the
 * relay forwards its few engine calls here (`ENGINE_PASSTHROUGH_METHODS`).
 * Not: the app or relay calling an engine directly.
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
      /** Held the CEO position at this session's start (D-#778). */
      ceoAtStart?: boolean;
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
  /**
   * Where harness-owned state lives (LILOS_HARNESS_HOME). File attachments
   * to folder-less sessions decode under it — they have no session folder
   * to land in but the agent still needs a readable path.
   */
  stateDir?: string;
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
  /**
   * D-#761: the runtime registry — one supervised engine per runtime id.
   * Absent in unit fixtures (a plain `attachEngine` populates
   * `engineConns` directly); the entry point always wires it.
   */
  runtimes?: EngineRegistry;
}

export class Harness {
  private engine?: EngineConnection;

  /** D-#761: the registry — own field so `HarnessCtx.runtimes` resolves
      to the same instance moved members read. */
  private readonly runtimes?: EngineRegistry;

  /** D-#761: live conn per runtime id — `engine` mirrors the default row
      for the single-engine readers that predate the registry. */
  private readonly engineConns = new Map<string, EngineConnection>();

  /** #834: what took the last engine continuity away (the supervisor
      stamps it at each attach) — a turn the gap killed is worded
      "went to sleep" vs "the engine restarted" from it. */
  private gapCause?: EngineGapCause;

  /** D-#761: the gap cause is per-runtime — one engine's restart words
      only the turns running on its sessions. */
  private readonly gapCauseByRuntime = new Map<string, EngineGapCause>();

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

  /* #136: run convs opened but not yet bound — AC-4's overlap window. */
  private readonly scheduledRunsInFlight = new Map<string, string>();

  /** engine requestId -> relay ask id (per session). */
  private readonly askByRequest = new Map<string, string>();

  private readonly requestByAsk = new Map<
    string,
    { sessionId: string; requestId: string }
  >();

  private readonly delivered = new Set<string>(); // relay message ids claimed

  /** Messages that arrived while the engine was down; drained on attach. */
  private readonly early = new Map<string, AppMessage[]>();

  /** The latest bind rejection per conversation — surfaced verbatim when
      the parked send is dropped (D-#866 r5). */
  private readonly lastBindError = new Map<string, string>();

  /** Bounded re-bind retries for sends parked in `early` on a bind
      failure (`scheduleEarlyFlush`). */
  private readonly earlyFlushTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly earlyFlushAttempts = new Map<string, number>();

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

  /** D-#881: `settledAt` stamp per conversation the worktree cleanup
      already answered — kept on un-settle; it also stamps the
      worktree-note dedupe key so a fresh settle cycle's line is its own
      incident. */
  private readonly worktreeCleaned = new Map<string, number>();

  /** D-#881: per-conversation serialization for settle/retry bursts. */
  private readonly worktreeCleanup = new Map<string, Promise<void>>();

  /** Latest `describe` result (hideCaps already filtered out) — the
      DEFAULT runtime's row; per-runtime rows live in describeByRuntime. */
  private describeResult?: DescribeResult;

  /** D-#761: each runtime's last describe (hideCaps applied). */
  private readonly describeByRuntime = new Map<string, DescribeResult>();

  /** D-#761: per-engine `models.list` caches (#790's lazy catalog). */
  private readonly modelCatalogs = new Map<
    string,
    Promise<readonly { id: string; name?: string; provider?: string }[]>
  >();

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

  /** The turn a conversation's engine is running right now — the gateway's
      approval asks bind to it so the card renders inside the live feed. */
  runningTurnFor(conversationId: string): string | undefined {
    return this.bindings.get(conversationId)?.runningTurnId;
  }

  /** D-#817: a plugin refresh may restart the engine only when nothing is
   *  mid-turn. A running turn, or a prompt already handed to the engine,
   *  would be dropped by the kill. */
  engineIdle(): boolean {
    for (const binding of this.bindings.values()) {
      if (binding.runningTurnId) return false;
      if (binding.inflightPrompts.size > 0) return false;
    }
    return true;
  }

  /* The Mac user's home this harness serves — `~` on the wire means this
     directory (device-scope folder reads stay under it). */
  private readonly home: string;
  /* Harness-owned state root — folder-less sessions' attachment files
     live under it (`stateDir/attachments`). */
  private readonly stateDir: string;

  constructor(private readonly opts: HarnessOptions) {
    this.runtimes = opts.runtimes;
    this.home = opts.homeDir ?? homedir();
    this.stateDir = opts.stateDir ?? join(homedir(), ".lilos", "harness");
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
    this.wireScheduler();
    /* start() runs after Object.assign puts the HarnessCtx methods on the
       prototype. The class type does not list them (D-#777). */
    wireCeoLoop(this as unknown as HarnessCtx);
  }

  declare private onRelayReady: () => Promise<void>;

  /* #136 moved members (harness/scheduler.ts) — Object.assign below binds
     them; `scheduler` itself is created in `wireScheduler` at start. */
  declare scheduler: TaskScheduler;
  declare private wireScheduler: () => void;
  declare private syncScheduledTasks: () => Promise<void>;
  declare private onScheduleUpserted: (task: ScheduledTask) => Promise<void>;
  declare private onScheduleRemoved: (taskId: string) => void;
  declare private scheduledRunStillGoing: (task: ScheduledTask) => boolean;
  declare private fireScheduledTask: (
    task: ScheduledTask,
    due: { at: number; key: string },
  ) => Promise<void>;
  declare private skipScheduledRun: (
    task: ScheduledTask,
    at: number,
  ) => Promise<void>;
  declare private onScheduledConversationUpdate: (
    conversation: Conversation,
  ) => Promise<void>;

  async stop(): Promise<void> {
    this.reaper.stop();
    this.scheduler?.stop();
    /* D-#772: a quiet timer must not fire after the harness stops.
       D-#777: the CEO coalesce timer is the same kind of quiet timer.
       D-#844: the task-wake timer too — pending batches re-enter via
       `harness.register`'s `taskWakes` catch-up on the next start. */
    stopCeoLoop(this as unknown as HarnessCtx);
    stopTaskLoop(this as unknown as HarnessCtx);
    stopStuckWatches(this.bindings.values());
    for (const t of this.earlyFlushTimers.values()) clearTimeout(t);
    this.earlyFlushTimers.clear();
    for (const unsub of this.unsubs.splice(0)) unsub();
    this.opts.relay.close();
    this.engine = undefined;
    this.engineConns.clear();
    this.opts.log.close();
  }

  /* --------------------------- engine wiring ---------------------------- */

  /**
   * Supervisor calls this on every fresh connection (first + reconnect).
   * D-#761: `runtime` names which engine attached — absent = the default.
   * Resync touches only this runtime's bindings: a restarted `acp:devin`
   * must not replay or drain sessions the healthy `hermes` still owns.
   */
  attachEngine(
    conn: EngineConnection,
    gapCause?: EngineGapCause,
    runtime: string = DEFAULT_RUNTIME,
  ): void {
    /* #834: remember why the engine gapped — a turn this attach proves
       dead is worded "went to sleep" or "the engine restarted" from it. */
    const cause = gapCause ?? "restart";
    this.gapCauseByRuntime.set(runtime, cause);
    if (runtime === DEFAULT_RUNTIME) this.gapCause = cause;
    const prev = this.engineConns.get(runtime);
    if (prev && prev !== conn) prev.close();
    this.engineConns.set(runtime, conn);
    if (runtime === DEFAULT_RUNTIME) this.engine = conn;
    this.unsubs.push(conn.onEvent((e) => this.onEngineEvent(e, runtime)));
    void this.describeAndHire(conn, runtime).catch((error) =>
      this.opts.log.warn("describe/hire failed", {
        runtime,
        error: String(error),
      }),
    );
    // Resync every bound session ON THIS RUNTIME: replay events past the
    // watermark, re-open asks, adopt a turn already running (harness
    // restart mid-turn). Messages held while an engine was down become
    // turns now — a flush re-binds through `ensureRuntime`, so a conv
    // parked for a still-idle engine lands once it starts.
    for (const convId of this.early.keys()) {
      void this.flushEarly(convId).catch((error) =>
        this.opts.log.warn("early message flush failed", {
          conversationId: convId,
          error: String(error),
        }),
      );
    }
    for (const binding of this.bindings.values()) {
      if (binding.runtime !== runtime) continue;
      /* #834: a send requeued while the engine was down must run on its
         own now — the queue's other drains (turn.completed, rebind) never
         fire when the session survived the restart (the adapter resumes
         its stored row, so nothing rebinds). Once resync has settled the
         lane truth, the parked send drains; a resync failure still gets
         the attempt — a dead sessionId prompts into SESSION_NOT_FOUND
         and rebinds, and a still-running lane no-ops. */
      void this.resyncBinding(binding)
        .catch((error) =>
          this.opts.log.warn("session resync failed", {
            sessionId: binding.sessionId,
            error: String(error),
          }),
        )
        .finally(() => this.drainQueue(binding));
    }
  }

  /** Supervisor state changes → relay `harness.report` (host heartbeat).
      D-#761: a non-default runtime's report carries `engine.runtime` so
      the relay keys it under `host.engines` — `host.engine` stays the
      default engine's row. */
  onEngineStateChange(
    state: EngineHostState,
    detail?: string,
    runtime?: string,
  ): void {
    /* D-#761 review: a terminal failure settles every send parked on
       this runtime — a `!binding` park has no flush timer, so without
       this it would wait on an engine that can never come. The drop
       surfaces the error on the thread (and a task wake on a hand-off
       parent); then, with nothing left needing the runtime, its
       supervisor is released. */
    if (state === "failed" && runtime && runtime !== DEFAULT_RUNTIME) {
      void (async () => {
        for (const convId of [...this.early.keys()]) {
          const conv = await this.findConversation(convId);
          if (conv && (await this.runtimeForConversation(conv)) === runtime) {
            await this.dropEarlyWithError(convId).catch(() => {});
          }
        }
        await this.releaseIdleFailedRuntimes();
      })().catch(() => {});
    }
    if (!this.hostId) return;
    this.opts.relay
      .request("harness.report", {
        engine: {
          state,
          ...(detail ? { detail } : {}),
          ...(runtime && runtime !== DEFAULT_RUNTIME ? { runtime } : {}),
        },
      })
      .catch((error) =>
        this.opts.log.warn("harness.report failed", { error: String(error) }),
      );
  }

  /* ------------------------- D-#761 runtime routing --------------------- */

  /** The live conn for a binding's runtime; undefined = that engine down. */
  connFor(binding: SessionBinding): EngineConnection | undefined {
    return this.connForRuntime(binding.runtime);
  }

  connForRuntime(runtime: string): EngineConnection | undefined {
    /* A registry row that's down resolves to undefined — never to the
       map's stale conn (the supervisor already discarded that socket).
       Runtimes the registry doesn't know (unit fixtures that attach
       directly) resolve from the attach-time map. */
    if (this.runtimes?.get(runtime)) return this.runtimes.connFor(runtime);
    return this.engineConns.get(runtime);
  }

  /**
   * Bind-time resolution: the registry lazily starts a configured runtime
   * on first demand (D-#761); without one (unit fixtures) only
   * already-attached conns resolve. An unknown/failed runtime returns
   * undefined — the caller takes the existing engine-down park path.
   */
  async ensureRuntime(runtime: string): Promise<EngineConnection | undefined> {
    const norm = normalizeRuntime(runtime);
    try {
      /* A runtime the registry doesn't know (a unit fixture's direct-
         attach map, or a stale employee.runtime naming a row this
         build's catalog lacks) resolves from already-attached conns —
         never lazily started and never blocking the default lane. */
      if (this.runtimes && !this.runtimes.has(norm)) {
        return this.connForRuntime(norm);
      }
      return (await this.runtimes?.ensure(norm)) ?? this.connForRuntime(norm);
    } catch (error) {
      this.opts.log.warn("runtime unavailable", {
        runtime: norm,
        error: String(error),
      });
      return undefined;
    }
  }

  /** `conversationBySession` key — qualified for non-default runtimes so
      two engines' session ids can't collide on the one map (D-#761). */
  sessionKey(runtime: string, sessionId: string): string {
    return qualifySessionRef(runtime, sessionId);
  }

  /** The binding holding an engine-local session on a given runtime. */
  bindingBySession(
    runtime: string,
    sessionId: string,
  ): SessionBinding | undefined {
    const convId = this.conversationBySession.get(
      this.sessionKey(runtime, sessionId),
    );
    return convId ? this.bindings.get(convId) : undefined;
  }

  describeForRuntime(runtime: string): DescribeResult | undefined {
    return (
      this.describeByRuntime.get(runtime) ??
      (runtime === DEFAULT_RUNTIME ? this.describeResult : undefined)
    );
  }

  hasCapabilityFor(runtime: string, id: string): boolean {
    return (
      this.describeForRuntime(runtime)?.capabilities.some((c) => c.id === id) ??
      false
    );
  }

  /** Runtime rows for the StatusReporter (`harness.report.status.runtimes`). */
  runtimeRows() {
    return this.runtimes?.statusRows();
  }

  /* ---------------- client session feed (read-only) ---------------------- */

  /** Engine identity + capabilities as clients see them (hideCaps
      applied) — the default engine's row. D-#761: the agent roster the
      picker reads merges across runtimes inside `agents.list`
      (agentsListMerged), not here — `describe` carries no roster. */
  engineDescribe(): DescribeResult | undefined {
    return this.describeResult;
  }

  /** `events.since` passthrough — replay a session's event log for a client.
      D-#761: the ref is runtime-qualified; it routes the call and is
      stripped before the engine sees it (the engine knows its own ids). */
  async eventsSince(ref: string, after: number): Promise<EventsSinceResult> {
    const { runtime, sessionId } = parseSessionRef(ref);
    const conn = this.connForRuntime(runtime);
    if (!conn) throw new Error("engine not connected");
    try {
      /* #834: the feed's replay lands on the same lazy-resume path —
         a transcript reopened while the adapter rebuilds must outwait
         the rebuild, not error into "transcript replay failed". */
      return await conn.request<EventsSinceResult>(
        "events.since",
        {
          sessionId,
          after,
        },
        RESUME_AWARE_TIMEOUT_MS,
      );
    } catch (error) {
      /* D-#300: a session the engine forgot — legacy bare ids (`s1`) with
         no registry row, or any SESSION_NOT_FOUND — must not surface as a
         replay error. The client degrades to "no live transcript": relay
         messages + the persisted context meter still render, and the write
         path rebinds on `session.start` the same way a gateway 404 does.
         Not: rebinding here, on thread open — that mints sessions on view. */
      if (engineErrorCode(error) !== SESSION_NOT_FOUND) throw error;
      return {
        events: [],
        latestSeq: after,
        truncated: false,
        openRequests: [],
        snapshot: { sessionId: ref, state: "closed" },
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
    return this.hasAutoTitleFor(DEFAULT_RUNTIME);
  }

  /** D-#761: the capability check, scoped to the binding's engine. */
  hasAutoTitleFor(runtime: string): boolean {
    return (
      this.describeForRuntime(runtime)?.capabilities.find(
        (c) => c.id === "session_meta",
      )?.detail?.autoTitle === true
    );
  }

  declare private describeAndHire: (
    conn: EngineConnection,
    runtime?: string,
  ) => Promise<void>;

  declare private resyncBinding: (binding: SessionBinding) => Promise<void>;
  /* #872: task_create's model check — a prototype mixin like the rest. */
  declare checkTaskModel: HarnessCtx["checkTaskModel"];

  declare private drainQueue: (binding: SessionBinding) => void;

  /* ------------------------- message -> engine -------------------------- */

  declare private flushEarly: (convId: string) => Promise<void>;
  declare private scheduleEarlyFlush: (convId: string) => void;
  declare private dropEarlyWithError: (convId: string) => Promise<void>;
  declare private conversationFromAtom: (
    conversationId: string,
  ) => Conversation | undefined;
  declare private findConversation: (
    conversationId: string,
  ) => Promise<Conversation | undefined>;
  declare private runtimeForConversation: (
    conv: Conversation | undefined,
  ) => Promise<string>;
  declare private releaseIdleFailedRuntimes: () => Promise<void>;

  /* ------------------------- #346 idle reaper ------------------------- */

  declare private reaperCandidates: () => ReaperCandidate[];

  declare private suspendBinding: (sessionId: string) => Promise<void>;

  declare private onReaperSuspended: (
    conversationId: string,
    sessionId: string,
  ) => void;

  /* ------------------------- engine -> relay ---------------------------- */

  declare private onEngineEvent: (event: EngineEvent, runtime?: string) => void;

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
  agentsListMerged,
  aliasSurfaces,
  applyHeldPick,
  applyReplay,
  autoApprove,
  bindConversation,
  bindingFor,
  bindingNow,
  cleanupSettledWorktree,
  codingAgentDefaults,
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
  execSlashCommand,
  employeeNowLine,
  enqueueOrPrompt,
  ensureAgent,
  ensureWorktree,
  exemptFromCurrentStop,
  findConversation,
  finishTurn,
  dropEarlyWithError,
  flushEarly,
  flushEarlyOrdered,
  scheduleEarlyFlush,
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
  scheduledRunStillGoing,
  fireScheduledTask,
  skipScheduledRun,
  onScheduleUpserted,
  onScheduleRemoved,
  onScheduledConversationUpdate,
  syncScheduledTasks,
  wireScheduler,
  reconcileAsks,
  relayWrite,
  releaseIdleFailedRuntimes,
  resolveEmployee,
  resyncBinding,
  runtimeFailedFor,
  runtimeFailureDetail,
  runtimeForConversation,
  rewindConversation,
  scheduleSteerReconcile,
  sendCanProduceTurn,
  sendPrompt,
  seqOfMessage,
  sessionHasOpenAsk,
  sessionParams,
  checkTaskModel,
  setSessionModel,
  slashFor,
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
