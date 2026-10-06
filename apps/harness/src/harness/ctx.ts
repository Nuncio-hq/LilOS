import type {
  AppMessage,
  Ask,
  Conversation,
  ConversationLife,
  ConversationsMoveFolderHostParams,
  ConversationsMoveFolderHostResult,
  ConversationsRewindHostParams,
  ConversationsRewindHostResult,
  Employee,
  FoldersBrowseParams,
  FoldersBrowseResult,
  FoldersDetailParams,
  FoldersDetailResult,
  FoldersDiscoverResult,
  TurnFailure,
} from "@lilos/contracts/app";
import type {
  ConversationAccess,
  DescribeResult,
  EngineEvent,
  EngineRequest,
  EventsSinceResult,
  McpServer,
} from "@lilos/contracts/engine";
import type { EngineConnection } from "../engine/client";
import type { EngineHostState } from "../engine/supervisor";
import type { HarnessOptions } from "../harness";
import type { ReaperCandidate, SessionReaper } from "../reaper";

/**
 * The shared surface the moved `harness/*.ts` functions close over (#441):
 * every Harness field and method the moved bodies touch via `this`.
 *
 * At runtime `this` IS the Harness — `harness.ts` assigns these functions
 * to `Harness.prototype` (`Object.assign` at its bottom), so every
 * read/write lands on the real member and `private` stays compile-time
 * private. Type order: the moved value types first, then the interface.
 */

export interface SessionBinding {
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
  /**
   * The conversation picked a real folder (`conv.cwd`) — #412: folder-less
   * sessions run in `~` too, but folder-only state (checkpoints, file
   * restores) must never key off that fallback cwd.
   */
  hasFolder: boolean;
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
      queue so nothing waiting can auto-run after it (#315). `seq` rides
      along so the Stop's `afterSeq` scope applies here too (#403). */
  steerPending: { messageId: string; text: string; seq: number }[];
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
  /** #106: the conversation's access level at last seen — `full` routes
      every `approval` request.opened through autoApprove instead of the
      card path; `conversation.updated` refreshes it mid-turn. */
  access: ConversationAccess;
  /** #422: this session's line for the employee's live "now:" —
      `thinking` from `turn.started` until the first `tool.started` names a
      step; absent when no turn runs. */
  nowStep?: string;
  /** #422: engine requests currently waiting on the user —
      requestId -> its wait line. */
  nowWaits: Map<string, string>;
  /** #422: bumped on every now-state mutation — the freshness key when
      several sessions of one employee race for the line. */
  nowAt: number;
  /** #422: the DM channel's employee, resolved at bind — the atom can lag
      the RPC view, so the now-line never re-derives it per event. */
  employeeId?: string;
  /** #346 AC-3: epoch ms of the session's last engine event — the
      reaper's "idle for 30 minutes" clock. Engine events are the signal:
      a session still reporting can't be idle, and a send not yet an
      event is guarded by `sendCanProduceTurn` instead. */
  lastActivity: number;
  /** #346 AC-3: subagent ids still running — a session under one never
      suspends, even when the parent turn is quiet. */
  openSubagents: Set<string>;
  /** #346: marked after `session.suspend` so the reaper skips it; any
      engine event or a dispatched send clears it — the session is live
      again through the resume path. */
  suspended: boolean;
}

/** A pick as the app sends it (#92): `{provider?, id}` plus its legs. */
export type ModelPick = {
  model: string;
  provider?: string;
  effort?: string;
  fast?: boolean;
};

/** Pick fields as the conversation row stores them — `null` clears. */
export type ConversationPickPatch = {
  model?: string | null;
  provider?: string | null;
  effort?: string | null;
  fast?: boolean | null;
};

export interface HarnessCtx {
  engine?: EngineConnection;
  hostId?: string;
  started: boolean;
  readonly bindings: Map<string, SessionBinding>;
  readonly modelPickQueue: Map<string, Promise<void>>;
  readonly conversationBySession: Map<string, string>;
  readonly rebinds: Map<string, Promise<void>>;
  readonly binds: Map<string, Promise<SessionBinding | undefined>>;
  readonly pendingInterrupts: Set<string>;
  readonly stopSeqs: Map<string, number>;
  readonly stopGenerations: Map<string, number>;
  readonly stopExempt: Map<
    string,
    { conversationId: string; generation: number }
  >;
  readonly inFlightDeliveries: Map<string, number>;
  readonly askByRequest: Map<string, string>;
  readonly requestByAsk: Map<string, { sessionId: string; requestId: string }>;
  readonly delivered: Set<string>;
  readonly early: Map<string, AppMessage[]>;
  nowClock: number;
  readonly nowWritten: Map<string, string>;
  readonly dismissed: Set<string>;
  readonly redeliver: Set<string>;
  readonly channelSeen: Map<string, number>;
  readonly channelWatch: Map<string, () => void>;
  readonly unsubs: Array<() => void>;
  readonly outbox: { label: string; run: () => Promise<unknown> }[];
  flushingOutbox: boolean;
  registering: boolean;
  registerAgain: boolean;
  readonly metaSeen: Map<
    string,
    { title: string; archived: boolean; titleSource?: "auto" | "user" }
  >;
  describeResult?: DescribeResult;
  readonly feedListeners: Set<(event: EngineEvent) => void>;
  hired: boolean;
  readonly reaper: SessionReaper;
  deliveryChains: Map<string, Promise<void>>;
  readonly home: string;
  readonly opts: HarnessOptions;
  readonly liveSessionCount: number;

  start(): Promise<void>;
  onRelayReady(): Promise<void>;
  stop(): Promise<void>;
  attachEngine(conn: EngineConnection): void;
  onEngineStateChange(state: EngineHostState, detail?: string): void;
  engineDescribe(): DescribeResult | undefined;
  eventsSince(sessionId: string, after: number): Promise<EventsSinceResult>;
  subscribeEngineEvents(fn: (event: EngineEvent) => void): () => void;
  hasCapability(id: string): boolean;
  hasAutoTitle(): boolean;
  describeAndHire(conn: EngineConnection): Promise<void>;
  resyncBinding(binding: SessionBinding): Promise<void>;
  relayWrite(label: string, run: () => Promise<unknown>): void;
  flushOutbox(): Promise<void>;
  applyReplay(binding: SessionBinding, replay: EventsSinceResult): void;
  markTurnInterrupted(binding: SessionBinding, turnId: string): Promise<void>;
  surfaceBackendDown(binding: SessionBinding, sourceId: string): Promise<void>;
  rebindConversation(binding: SessionBinding): Promise<void>;
  doRebindConversation(binding: SessionBinding): Promise<void>;
  mirrorMeta(
    binding: SessionBinding,
    conv:
      | { title: string; archived: boolean; titleSource?: "auto" | "user" }
      | undefined,
  ): void;
  ordered<T>(conversationId: string, fn: () => Promise<T>): Promise<T>;
  deliver(message: AppMessage): Promise<void>;
  deliverOrdered(message: AppMessage): Promise<void>;
  flushEarly(convId: string): Promise<void>;
  flushEarlyOrdered(convId: string): Promise<void>;
  enqueueOrPrompt(binding: SessionBinding, message: AppMessage): void;
  liveBinding(binding: SessionBinding): SessionBinding;
  insertQueued(binding: SessionBinding, message: AppMessage): void;
  promptOrQueue(binding: SessionBinding, message: AppMessage): void;
  drainQueue(binding: SessionBinding): void;
  sendPrompt(binding: SessionBinding, message: AppMessage): Promise<void>;
  dispatchPrompt(
    binding: SessionBinding,
    message: AppMessage,
    promptOnWire: () => void,
  ): Promise<boolean>;
  stampCheckpoint(binding: SessionBinding, message: AppMessage): Promise<void>;
  rewindConversation(
    params: ConversationsRewindHostParams,
  ): Promise<ConversationsRewindHostResult>;
  moveConversationFolder(
    params: ConversationsMoveFolderHostParams,
  ): Promise<ConversationsMoveFolderHostResult>;
  markDelivered(binding: SessionBinding, message: AppMessage): void;
  writeLife(conversationId: string, life: ConversationLife): void;
  reaperCandidates(): ReaperCandidate[];
  sessionHasOpenAsk(sessionId: string): boolean;
  suspendBinding(sessionId: string): Promise<void>;
  onReaperSuspended(conversationId: string, sessionId: string): void;
  sendCanProduceTurn(conversationId: string): boolean;
  dropParkedInterruptIfOrphaned(
    conversationId: string | null | undefined,
  ): void;
  bindingFor(
    conv: Conversation,
    channelId: string,
  ): Promise<SessionBinding | undefined>;
  bindConversation(
    conv: Conversation,
    channelId: string,
  ): Promise<SessionBinding | undefined>;
  onEngineEvent(event: EngineEvent): void;
  openAsk(
    binding: SessionBinding,
    turnId: string,
    requestId: string,
    request: EngineRequest,
  ): Promise<void>;
  autoApprove(
    binding: SessionBinding,
    requestId: string,
    request: EngineRequest,
  ): Promise<void>;
  reconcileAsks(): Promise<void>;
  onEngineRequestResolved(
    sessionId: string,
    requestId: string,
    outcome: string,
    answer?: string,
  ): Promise<void>;
  onRelayEvent(method: string, params: Record<string, unknown>): void;
  onRelayRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
  folderDetail(params: FoldersDetailParams): Promise<FoldersDetailResult>;
  folderBrowse(params: FoldersBrowseParams): Promise<FoldersBrowseResult>;
  folderDiscover(): Promise<FoldersDiscoverResult>;
  ensureWorktree(conv: Conversation): Promise<void>;
  onChannelRemoved(channelId: string): Promise<void>;
  watchChannel(channelId: string): void;
  onAskResolved(ask: Ask): Promise<void>;
  unclaimMessage(message: AppMessage): void;
  exemptFromCurrentStop(conversationId: string, messageId: string): boolean;
  stopOwns(conversationId: string, message: AppMessage): boolean;
  dropStopped(binding: SessionBinding, message: AppMessage): void;
  seqOfMessage(channelId: string, messageId: string): number | undefined;
  onInterruptRequested(
    conversationId: string,
    afterSeq?: number,
  ): Promise<void>;
  onModelRequested(conversationId: string, pick: ModelPick): Promise<void>;
  setSessionModel(
    binding: SessionBinding,
    pick: ModelPick,
  ): Promise<ConversationPickPatch>;
  applyHeldPick(binding: SessionBinding): Promise<void>;
  rebuildHeldPick(
    binding: SessionBinding,
    conv: Conversation,
    snap: EventsSinceResult["snapshot"],
  ): void;
  doApplyHeldPick(binding: SessionBinding): Promise<void>;
  finishTurn(
    binding: SessionBinding,
    event: Extract<EngineEvent, { type: "turn.completed" }>,
  ): Promise<void>;
  scheduleSteerReconcile(binding: SessionBinding): void;
  unbind(binding: SessionBinding): void;
  createSurfaces(
    binding: SessionBinding,
    conv: Conversation | undefined,
    employee: Employee | undefined,
  ): { session: string; mcpServer?: McpServer } | undefined;
  aliasSurfaces(
    session: string | undefined,
    engineSessionId: string | undefined,
  ): void;
  ensureAgent(
    conn: EngineConnection,
    employee: Employee | undefined,
  ): Promise<string>;
  sessionParams(
    employee: Employee | undefined,
    agentId: string,
    conv?: Conversation,
    mcpServer?: McpServer,
  ): {
    agent: string;
    model?: string;
    provider?: string;
    effort?: string;
    fast?: boolean;
    cwd: string;
    access?: ConversationAccess;
    mcpServers?: McpServer[];
  };
  bindingNow(binding: SessionBinding): string;
  noteNow(binding: SessionBinding): void;
  employeeNowLine(employeeId: string): string;
  pushEmployeeNow(employeeId: string): void;
  sweepNow(): Promise<void>;
  employeeIdFor(conv: Conversation | undefined): string | undefined;
  resolveEmployee(
    conv: Conversation | undefined,
  ): Promise<Employee | undefined>;
  conversationFromAtom(conversationId: string): Conversation | undefined;
  findConversation(conversationId: string): Promise<Conversation | undefined>;
  updateConversation(
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
      life?: ConversationLife;
      /** #419: stamp the last turn's failure (DM alert card); `null`
          clears it. */
      turnFailure?: TurnFailure | null;
      /** #581: the thread's working folder — `conversations.moveFolder`
          writes it after re-homing the session; `null` clears it. */
      cwd?: string | null;
    },
  ): Promise<void>;
  postSystem(
    target: { channelId: string; conversationId: string },
    text: string,
    dedupeKey?: string,
  ): Promise<void>;
}
