import { z } from "zod";
import { ConversationAccess } from "../engine/approvals";
import { Capability } from "../engine/capabilities";
import { Usage } from "../engine/events";
import { ModelOption, ModelProvider } from "../engine/models";
import { ApprovalOutcome, EngineRequest } from "../engine/requests";
import { ChannelMessage } from "../index";

/**
 * App-protocol domain objects (issue #25): the records the relay owns and
 * serves to clients. Everything crossing web <-> relay <-> harness is defined
 * here — engines are referenced only by the opaque `engineRef` string; the
 * relay never sees engine transcripts (tools, reasoning).
 */

/** Unix epoch milliseconds. */
export const Timestamp = z.int().min(0);

/** Presence as last stored on the record; live presence is a later slice. */
export const EmployeeStatus = z.enum(["online", "busy", "offline"]);
export type EmployeeStatus = z.infer<typeof EmployeeStatus>;

export const RespondTo = z.enum(["me", "selected", "anyone"]);
export type RespondTo = z.infer<typeof RespondTo>;

/** A company employee — an AI agent identity rendered in the sidebar. */
export const Employee = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string(),
  status: EmployeeStatus,
  profile: z.string(),
  model: z.string(),
  now: z.string(),
  instructions: z.string(),
  respondTo: RespondTo,
  /* A muted employee notifies nowhere (#561): the relay skips its pushes
     and the Mac posts no banners. Optional so pre-#561 rows and fixtures
     read as unmuted. */
  muted: z.boolean().optional(),
  /** Who this person reports to: an employee id. Absent means the owner,
      shown by the profile name — never a stored owner id or a hardcoded
      name (D-#775). */
  reportsTo: z.string().min(1).optional(),
  /** D-#761: the engine runtime this agent's threads bind to — absent or
      the default id means the default engine (every pre-#761 employee), a
      coding agent names its ACP runtime (`"acp:<agent>"`). The harness owns
      routing; the field is set at hire and never widens access. */
  runtime: z.string().min(1).optional(),
  createdAt: Timestamp,
});
export type Employee = z.infer<typeof Employee>;

/** Only `dm` exists today; new kinds bump the protocol version. The wire
    name is kept for protocol compatibility — the product has no DMs
    (D-#25): it is the routing scope of one employee's threads. */
export const ChannelKind = z.enum(["dm"]);
export type ChannelKind = z.infer<typeof ChannelKind>;

/**
 * One internal channel per employee (D-#25): purely the routing scope for
 * that employee's messages, asks and engine events — clients subscribe to
 * every channel and never show it as a place. The product concept is the
 * thread, in a project or a plain chat (D-#771). The relay keeps one per
 * employee via the `channels_dm_employee` unique index. Another employee
 * joins a thread only as a helper in their own session — a link, never a
 * member. Not: DMs or group chats as something the user sees, and not
 * renamed on the wire (`channels.openDm`, kind `"dm"`) — that would break
 * paired phones for a label nobody reads.
 */
export const AppChannel = z.object({
  id: z.string().min(1),
  kind: ChannelKind,
  /** The employee this channel routes for. Required while `dm` is the only kind. */
  employeeId: z.string().min(1),
  /** Highest seq assigned in this channel (0 = no messages yet). */
  lastSeq: z.int().min(0),
  createdAt: Timestamp,
});
export type AppChannel = z.infer<typeof AppChannel>;

/**
 * A conversation is a thread inside a channel; each conversation maps to
 * exactly one engine session via `engineRef` (D-#25; set by the harness
 * once the engine session exists — `null` until then; a rebind swaps it
 * for a fresh session, still one at a time) with one agent, and lives in a
 * project or is a plain chat (D-#771). Not: threads detached from
 * sessions, or a thread in two projects.
 */
export const ConversationState = z.enum(["idle", "active", "closed"]);
export type ConversationState = z.infer<typeof ConversationState>;

/**
 * The engine session's life behind a conversation (#346): `open` = the
 * session exists (loaded, idle or mid-turn), `closed` = suspended — it
 * reopens on the next message. `running` is deliberately absent: that is a
 * derived state (a turn or any subagent live), computed in one place
 * client-side (`sessionLife` / `toSessionTurn`), never stored — the same
 * rule the prototype's life ring uses (#344/#348).
 */
export const ConversationLife = z.enum(["open", "closed"]);
export type ConversationLife = z.infer<typeof ConversationLife>;

/**
 * How a conversation's `cwd` came to be (#156 workstream modes, prototype
 * semantics): `new` = the harness materialized `cwd` as a fresh git
 * worktree of `repoPath` (`git worktree add <cwd> -b <branch> <base>`)
 * before `session.start`; `existing` = `cwd` already was the workstream's
 * worktree. Absent = `cwd` is the picked folder itself (direct) or the
 * default workdir (just chat). `repoPath` is the picker's folder — it is
 * what bumps the recents list, never the `.lilos/wt/*` path in `cwd`.
 */
export const WorkspaceIntent = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("new"),
    /** The folder the worktree belongs to (and recents bump). */
    repoPath: z.string().min(1),
    /** The workstream's branch — created at the worktree. */
    branch: z.string().min(1),
    /** Ref the branch forks from (`git worktree add` start point). */
    base: z.string().min(1),
  }),
  z.strictObject({
    mode: z.literal("existing"),
    /** The folder whose worktree list carried this workstream. */
    repoPath: z.string().min(1),
    /** The workstream's branch — already checked out at `cwd`. */
    branch: z.string().min(1),
  }),
]);
export type WorkspaceIntent = z.infer<typeof WorkspaceIntent>;

/**
 * Why the conversation's last turn failed (D-#419). Host-written, persisted
 * on the row: an interrupted turn orphans with the dead session's event
 * log (a rebind swaps `engineRef`), so the failure card can't ride the
 * turn itself — it lives here until the next `turn.started` clears it.
 * The harness stamps it on `turn.completed.error`, an interrupted turn
 * (slept/restarted engine) and a terminal dispatch failure; the client
 * fold still marks the turn `failed` (vs `done`/`stopped`). Not: deriving
 * the failure from turn replay.
 * `kind` mirrors the ui `SessionAlert` kinds: "sleep" = the Mac slept or
 * the engine restarted (amber), "model"/"generic" = the turn ended on
 * `turn.completed.error` / the prompt never dispatched (red), "context" =
 * the context window was full (#560 — offers Compact now / a new session
 * instead of a bare retry).
 */
export const TurnFailure = z.strictObject({
  kind: z.enum(["model", "sleep", "generic", "context"]),
  /** The user-facing failure line (the engine's error text or the
      interrupt reason). */
  text: z.string().min(1),
});
export type TurnFailure = z.infer<typeof TurnFailure>;

export const Conversation = z.object({
  id: z.string().min(1),
  channelId: z.string().min(1),
  /** The message the thread was opened with. */
  rootMessageId: z.string().min(1),
  /** Opaque engine session reference, owned by the harness/engine. */
  engineRef: z.string().min(1).nullable(),
  state: ConversationState,
  title: z.string(),
  /**
   * Who last wrote `title` (#137): `user` = typed by a human (rename/open) —
   * an engine-written title may NEVER overwrite it; `auto` = placeholder or
   * engine-emitted title, free for the engine to upgrade.
   */
  titleSource: z.enum(["auto", "user"]).default("auto"),
  /**
   * The model pinned on the conversation's engine session (issue #30): the
   * id the engine acked via `session.setModel`, or the pending pick applied
   * at `session.start` before a binding exists. Absent = engine default.
   */
  model: z.string().min(1).optional(),
  /** The rest of the pinned pick — provider slug, effort level, fast tier. */
  provider: z.string().optional(),
  effort: z.string().optional(),
  fast: z.boolean().optional(),
  /**
   * The folder the session works in (issue #113), picked at open time. The
   * engine only ever sees it as `session.start { cwd }`; absent = the
   * harness's default workdir. For a workstream open (#156) this is the
   * worktree path; `workspace.repoPath` is the picked folder.
   */
  cwd: z.string().min(1).optional(),
  /**
   * The project this thread lives in (D-#771); absent = a plain chat. Set
   * only by the relay, from the folder the thread opens or moves into —
   * a workstream thread (`cwd` = its worktree) files under `repoPath`'s
   * project. Clients send a `cwd`, never a project id.
   */
  projectId: z.string().min(1).optional(),
  /**
   * The ticket this thread is a hand of (D-#776). Absent = not on a ticket.
   * Relay-set, and only by `tickets.assign`: one column, so a thread links
   * to at most one ticket. The next hand is a new thread on the same ticket.
   */
  ticketId: z.string().min(1).optional(),
  /**
   * The standing CEO thread (D-#777). The relay sets it when it stores a
   * `ceoWake` message here. Turns on this thread never notify and never
   * count as unseen: the owner reads them as updates. Absent on every
   * other thread. Clients cannot set it.
   */
  ceoThread: z.literal(true).optional(),
  /**
   * The thread that handed this one a task (D-#844): `tasks.create`
   * stamps the caller's conversation here so a turn ending on the child
   * knows whose wake to queue. Relay-set once at create, immutable,
   * never client-written. Absent on every non-child thread.
   */
  parentId: z.string().min(1).optional(),
  /** Workstream mode stamped at open (#156); absent = direct/just chat. */
  workspace: WorkspaceIntent.optional(),
  /**
   * The conversation's access level (#106): `ask` renders every approval
   * request as a card; `full` has the harness answer them itself. Set from
   * Settings' default at open, switched by the composer pill — the switch
   * applies from the agent's next action.
   */
  access: ConversationAccess.default("ask"),
  /* D-#862: `settled` is the real model — a settled thread parks on the
     Settled shelf (`settledAt`/`settledReason`/`settledPr` say when and
     why). `archived` stays on the wire as its synced mirror so pre-#862
     clients keep working: it is true exactly while `settledAt` is set, and
     an `archived` write maps to settle/un-settle (reason `manual`). */
  archived: z.boolean(),
  /**
   * D-#862: pinned to the top of the thread list, epoch ms (newest pin
   * first). Absent = not pinned. Settling removes the pin. Relay-stamped;
   * clients write it through `conversations.pin`.
   */
  pinnedAt: Timestamp.optional(),
  /**
   * D-#862: when the thread settled, epoch ms — the shelf's stamp and its
   * sort order. Absent = the thread is live. Relay-stamped by
   * `conversations.settle`, the auto-settle sweep, or an `archived` write.
   */
  settledAt: Timestamp.optional(),
  /**
   * D-#862: why it settled — `manual` (the owner, or a legacy `archived` write),
   * `idle` (the 3-day sweep), `pr` (its PR merged or closed). Present on
   * every settled row.
   */
  settledReason: z.enum(["manual", "idle", "pr"]).optional(),
  /**
   * D-#862: the PR whose merge/close settled the thread — only when
   * `settledReason` is `pr` and the thread knew the link (a workstream
   * thread's `workspace.branch`).
   */
  settledPr: z
    .strictObject({ num: z.int(), state: z.enum(["merged", "closed"]) })
    .optional(),
  /**
   * D-#862: hidden until this epoch-ms time — the thread keeps working but
   * leaves every list. Wakes early on a new ask, a failed turn, or the
   * user's own message; `conversations.snooze {until: null}` wakes it now.
   */
  snoozedUntil: Timestamp.optional(),
  /**
   * D-#862: the auto-settle switch for this thread — `false` leaves it in
   * the list forever (Auto-settle → Disabled). Absent = on.
   */
  autoSettle: z.boolean().optional(),
  /**
   * D-#862 review: the newest owner park action's stamp (pin, settle,
   * un-settle, snooze, wake, auto-settle flip — and the wake paths). The
   * sweep counts it as activity, so a thread the owner just un-parked or
   * touched doesn't bounce straight back onto the shelf, and an un-settle
   * newer than a PR's terminal stamp rescues it from the PR path.
   * Relay-stamped; never a client write.
   */
  lastParkActionAt: Timestamp.optional(),
  /**
   * Host-owned watermark: highest user-message seq the harness has handed to
   * the engine. User messages beyond it are the owed turns — this is what
   * survives a restart when a message queued mid-turn sits behind the
   * previous turn's answer in seq order.
   */
  deliveredSeq: z.int().min(0).default(0),
  /**
   * The engine session's life (#346, AC-4): the host writes `open`/`closed`
   * — a suspended session is `closed` and reopens on the next message.
   * Absent on rows that predate the field = treated as `open`. `running`
   * never crosses the wire — it's derived in one place (the same rule as
   * the prototype's `sessionLife`).
   */
  life: ConversationLife.optional(),
  /**
   * The newest turn.completed's usage the relay saw (#300) — the meter's
   * lifetime input/output/cache counts + engine-reported `context` (current
   * occupancy, #415) and `contextWindow`. Relay-persisted so the meter
   * survives replay failure entirely: a dead engine session (legacy bare
   * engineRefs, forgotten sessions) yields an empty `events.since` but this
   * row still carries the last numbers.
   */
  usage: Usage.optional(),
  /**
   * The last turn's failure (#419) — the thread row's alert card.
   * Absent once a turn started fresh or no turn has failed yet.
   */
  turnFailure: TurnFailure.optional(),
  /**
   * The last turn ended stopped (#583) — the thread row's "stopped"
   * word. Same lifecycle as `turnFailure`: host-written at turn end,
   * cleared on the next `turn.started`. A released or replayed session's
   * row still shows it once the live turn model is gone.
   */
  turnStopped: z.boolean().optional(),
  /**
   * The running turn is stuck (D-#772): a plain reason ("Same web search
   * 6 times", "No new step for 20 minutes"). The host writes it and
   * clears it (`null` on the update) when the next step differs, a new
   * message lands, or the turn is stopped. Absent = not stuck.
   */
  stuck: z.object({ reason: z.string().min(1) }).optional(),
  /**
   * When this thread was last marked stuck, epoch ms (issue #775). The
   * relay sets it when `stuck` goes from unset to set. Clearing the mark
   * leaves it; a later episode overwrites it. Absent means never stuck.
   * Not host-written — `conversations.update` has no field for it, so the
   * week's tally cannot be backdated from a client.
   */
  stuckAt: Timestamp.optional(),
  /**
   * Count of this session's still-running background jobs (#583 AC-3).
   * Same lifecycle as `turnStopped`: host-written on `job.started` /
   * `job.exited`, so the row's "N in background" badge — and the
   * session feed it keeps alive — survive a released session.
   */
  bgJobs: z.number().int().nonnegative().optional(),
  /**
   * The user's read watermark (D-#563): how far he has opened this thread.
   * `conversations.markRead` stamps `max(channel.lastSeq, finishedSeq)`
   * — every finish the relay has seen counts as read. A thread whose
   * `finishedSeq` sits past it shows the "finished, not seen yet" dot,
   * computed client-side; one relay-owned mark for every device, so
   * opening the thread anywhere clears it everywhere (`conversation.updated`).
   * Not: a stored unseen/read boolean (desyncs on restart/replay),
   * client-computed stamps (clock skew across Mac and phone), or
   * per-device read state (the phone must clear the mark the Mac set).
   */
  readSeq: z.int().min(0).default(0),
  /**
   * The last turn end the relay observed (#563): a `turn.completed` (a
   * user-stopped turn doesn't stamp — the user who stopped it was
   * watching) or a `session.state` error. Stamped by the relay, never
   * client-written, at `max(channel.lastSeq, readSeq) + 1` — strictly
   * past every mark seen so far, since the finish's own channel writes
   * land after its engine event. The "finished, not seen" dot is
   * `finishedSeq > readSeq`, so it survives restart and reconnect.
   */
  finishedSeq: z.int().min(0).default(0),
  /**
   * Set on a session a scheduled task opened (#136): the thread is marked and
   * the chip opens the task. Host-stamped at `conversations.open`.
   */
  scheduled: z
    .object({ taskId: z.string().min(1), name: z.string() })
    .optional(),
  createdAt: Timestamp,
});
export type Conversation = z.infer<typeof Conversation>;

/**
 * A folder the user picked (or ran a session in) — the picker's recents
 * (#113). LilOS-owned: stored by the relay, shared across employees, survives
 * restarts; existence/branch info is probed live via the host API.
 */
export const RecentFolder = z.object({
  path: z.string().min(1),
  lastUsedAt: Timestamp,
});
export type RecentFolder = z.infer<typeof RecentFolder>;

/**
 * The signed-in human's identity — name, company name, avatar colour
 * (#118). LilOS-owned domain data (D-#25): the relay stores it and every
 * surface rendering `ME` or the company reads it. All fields optional — an
 * untouched install stores nothing and the app prefills from the OS.
 */
export const ProfileSettings = z.object({
  userName: z.string().min(1).optional(),
  companyName: z.string().min(1).optional(),
  /** Tailwind `bg-*` class backing the human's avatar chip. */
  avatarColor: z.string().min(1).optional(),
});
export type ProfileSettings = z.infer<typeof ProfileSettings>;

export const AuthorKind = z.enum(["user", "employee", "system"]);
export type AuthorKind = z.infer<typeof AuthorKind>;

/**
 * A phone (or other device) paired to this install (#153): created by
 * exchanging a one-time grant, listed and revoked on the Mac. The record
 * carries no credential material — the store keeps only the credential's
 * hash; the raw value exists once, in the exchange response.
 */
export const PairedDevice = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  pairedAt: Timestamp,
  lastSeenAt: Timestamp,
});
export type PairedDevice = z.infer<typeof PairedDevice>;

/**
 * Display-only reference to a stored attachment (issue #31): the relay keeps
 * the bytes behind `attachments.get`, so message records, history pages and
 * replay frames carry only this ref — never the blob.
 */
export const MessageAttachment = z.object({
  id: z.string().min(1),
  /** Original filename; pasted images can carry a generic one. */
  name: z.string(),
  mimeType: z.string().min(1),
  /** Decoded byte size. */
  sizeBytes: z.int().min(0),
});
export type MessageAttachment = z.infer<typeof MessageAttachment>;

/** A visible message the relay stores — extends the base channel envelope. */
export const AppMessage = z.object({
  ...ChannelMessage.shape,
  /** Thread this message belongs to; `null` = top-level channel message. */
  conversationId: z.string().min(1).nullable(),
  authorKind: AuthorKind,
  /**
   * A CEO wake (D-#777). Present only when true. The engine reads `text`;
   * delivery, the LilOS note, and a restart's pending turns key off this
   * flag. The relay sets it, and only for a host system message.
   */
  ceoWake: z.literal(true).optional(),
  /**
   * A task wake (D-#844): a child task's finished turn waking the parent
   * thread. Same rule as `ceoWake` — the flag, not the text, makes the
   * engine take it as a prompt and the restart pending list owe it.
   */
  taskWake: z.literal(true).optional(),
  /** Attachment refs for display; bytes are fetched per id. */
  attachments: z.array(MessageAttachment).optional(),
  /**
   * The model that produced an employee turn (engine `turn.started.model`,
   * passed through by the harness). Absent on user/system lines.
   */
  model: z.string().min(1).optional(),
  /** The turn's provider slug / effort level / fast tier, when reported. */
  provider: z.string().optional(),
  effort: z.string().optional(),
  fast: z.boolean().optional(),
  /**
   * True when a `conversations.rewind` dropped this message (issue #134):
   * hidden from every thread/summary read, kept in the store for audit —
   * never hard-deleted.
   */
  rewound: z.boolean().default(false),
  /**
   * User message ■ Stop parked in the not-sent tray (#315): the harness was
   * told to drop it instead of letting it reach the engine. Hidden from
   * default `messages.list` reads and from `listPendingTurns`; `messages.send`
   * un-parks it (re-delivers), `messages.remove` deletes it for good.
   */
  dropped: z.boolean().default(false),
  /**
   * User removed a still-waiting or parked message (#315): the engine must
   * never get it. Hidden from every read and pending list, kept for audit.
   */
  removed: z.boolean().default(false),
  /**
   * The harness committed this send to the engine pipeline (#377): its
   * prompt is dispatching — checkpoint stamped, frame on the wire or about
   * to be — but the turn hasn't started yet, so `deliveredSeq` still sits
   * below it. Claimed rows are NOT "waiting": the tray's Remove boundary
   * is delivery intent, and a send this far along can't be retracted from
   * the tray (a `messages.remove` raced in anyway still kills it via the
   * harness's dismissed set). The row renders as its own sent bubble.
   * Clears when the send comes to rest short of the wire — queued behind
   * a turn, accepted as a pending steer, re-queued — and on Remove or
   * un-park (#403): a resting send is waiting again, and removable.
   */
  claimed: z.boolean().default(false),
  /**
   * Pre-turn folder checkpoint id stamped by the harness (#134): the point
   * `conversations.rewind` restores the session folder to. Only user
   * messages that ran a turn carry one.
   */
  checkpoint: z.string().optional(),
});
export type AppMessage = z.infer<typeof AppMessage>;

/* --------------------- session-list summaries (#571) --------------------- */

/**
 * Preview cap for a summary row's non-root texts (#571): the row renders a
 * two-line snippet — anything longer is wire weight. `truncated` marks the
 * cut so a surface can pull the full row via `messages.list`.
 */
export const SUMMARY_TEXT_LIMIT = 500;

/**
 * The message columns a `conversations.summaries` row renders (#571): a
 * subset of `AppMessage` without the fields no list reads (`channelId` —
 * the conversation carries it — `dedupeKey`/`claimed`/`checkpoint`/
 * `dropped`/`removed`; `rewound` stays because a rewound root still
 * headlines its row and surfaces suppress it where it shouldn't show).
 */
export const SummaryMessage = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1).nullable(),
  authorId: z.string().min(1),
  authorKind: AuthorKind,
  text: z.string(),
  /** The row is a CEO wake (D-#777). Same flag as `AppMessage.ceoWake`. */
  ceoWake: z.literal(true).optional(),
  /** The row is a task wake (D-#844). Same flag as `AppMessage.taskWake`. */
  taskWake: z.literal(true).optional(),
  seq: z.int().min(1),
  createdAt: Timestamp,
  /** The hidden row still headlines its summary (a rewind to the root);
      boolean (not literal-true) so pre-#571 cached rows with an explicit
      `rewound: false` still parse — the device cache fails closed on a
      schema break. */
  rewound: z.boolean().optional(),
  /** `text` was cut to SUMMARY_TEXT_LIMIT — `messages.list` has the rest. */
  truncated: z.literal(true).optional(),
  attachments: z.array(MessageAttachment).optional(),
  model: z.string().min(1).optional(),
  effort: z.string().optional(),
  fast: z.boolean().optional(),
});
export type SummaryMessage = z.infer<typeof SummaryMessage>;

/** AppMessage → its summary row, text kept whole (the root's card). */
export function toSummaryMessage(m: AppMessage): SummaryMessage {
  return {
    id: m.id,
    conversationId: m.conversationId,
    authorId: m.authorId,
    authorKind: m.authorKind,
    text: m.text,
    ...(m.ceoWake ? { ceoWake: true as const } : {}),
    ...(m.taskWake ? { taskWake: true as const } : {}),
    seq: m.seq,
    createdAt: m.createdAt,
    ...(m.rewound ? { rewound: true as const } : {}),
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    ...(m.model !== undefined ? { model: m.model } : {}),
    ...(m.effort !== undefined ? { effort: m.effort } : {}),
    ...(m.fast !== undefined ? { fast: m.fast } : {}),
  };
}

/** `toSummaryMessage` for the preview texts — capped + flagged. */
export function toSummaryPreview(m: AppMessage): SummaryMessage {
  const s = toSummaryMessage(m);
  return m.text.length > SUMMARY_TEXT_LIMIT
    ? { ...s, text: s.text.slice(0, SUMMARY_TEXT_LIMIT), truncated: true }
    : s;
}

/* ------------------------------ asks (#26) ------------------------------ */

/**
 * An engine ask (`request.opened`) surfaced on the relay so the app can answer
 * it. `request` is the engine's EngineRequest verbatim — the relay passes it
 * through and never interprets it; kinds outside the engine's
 * approval/question union cannot be represented here by construction.
 */
export const AskState = z.enum(["open", "resolved"]);
export type AskState = z.infer<typeof AskState>;

/**
 * The hire draft a gateway `team_hire` ask carries so the card can render
 * the real hire proposal instead of text. Host-produced only — an
 * engine ask never sets it.
 */
export const AskHireProposal = z.strictObject({
  name: z.string().min(1),
  role: z.string(),
  model: z.string(),
  instructions: z.string(),
  provider: z.string().optional(),
  /* Reusing an existing engine profile instead of minting one is a
     different action — the card has to say so. */
  profile: z.string().optional(),
});
export type AskHireProposal = z.infer<typeof AskHireProposal>;

export const Ask = z.object({
  id: z.string().min(1),
  channelId: z.string().min(1),
  conversationId: z.string().min(1),
  /** Engine turn the ask belongs to (opaque to the relay). */
  turnId: z.string().min(1),
  /** Engine request id the harness echoes back in `request.respond`. */
  requestId: z.string().min(1),
  request: EngineRequest,
  /**
   * Gateway `ask` lines (D-#773): why this is asked, and what yes and no
   * do. Absent on an engine approval — that ask keeps its command on
   * `request`. No deadline.
   */
  why: z.string().min(1).optional(),
  ifYes: z.string().min(1).optional(),
  ifNo: z.string().min(1).optional(),
  /** Structured hire draft when the ask proposes a hire. */
  hire: AskHireProposal.optional(),
  state: AskState,
  outcome: ApprovalOutcome.optional(),
  answer: z.string().optional(),
  createdAt: Timestamp,
  resolvedAt: Timestamp.optional(),
});
export type Ask = z.infer<typeof Ask>;

/**
 * A user-authored turn awaiting the engine: a conversation whose newest
 * message is a user message the harness has not answered yet. Returned by
 * `harness.register` so a restarting harness catches up.
 */
export const PendingTurn = z.object({
  conversation: Conversation,
  channel: AppChannel,
  /** Newest undelivered user message — `messages.at(-1)`. */
  message: AppMessage,
  /**
   * Every user message past `conversation.deliveredSeq`, oldest first
   * (`message` included). A message sent while the previous turn ran can sit
   * behind that turn's answer in seq order, so the watermark — not the
   * newest message — decides what a restarting harness still owes.
   */
  messages: z.array(AppMessage).min(1),
});
export type PendingTurn = z.infer<typeof PendingTurn>;

/**
 * Everything the session list renders for one conversation, so rows survive
 * beyond the channel's snapshot window: the conversation itself plus the
 * messages a row needs (root text, first answer, latest activity) without
 * paging the whole thread.
 */
export const ConversationSummary = z.object({
  conversation: Conversation,
  /** The user message that opened the thread — full text: the desktop feed
      renders it as the session's card. */
  root: SummaryMessage,
  /** First non-user message in the thread — the "answer preview" (capped). */
  firstAnswer: SummaryMessage.optional(),
  /** Newest message in the thread (any author) — preview text only. */
  last: SummaryMessage,
  /** Total visible messages in the thread, root included; a rewind to the
      root (or a removed opener) can leave none. */
  messageCount: z.int().min(0),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

/**
 * Engine state as reported by the registered engine host via
 * `harness.report` (supervisor lifecycle names, not engine SessionState).
 */
export const EngineHostState = z.enum([
  "starting",
  "running",
  "restarting",
  "failed",
  "stopped",
]);
export type EngineHostState = z.infer<typeof EngineHostState>;

export const EngineHostStatus = z.object({
  /** Whether an engine host is registered on this relay right now. */
  connected: z.boolean(),
  state: EngineHostState.optional(),
  /** Freeform one-liner, e.g. crash detail or engine name. */
  detail: z.string().optional(),
  /**
   * What the engine declares, from the host's `harness.report` probe
   * (issue #30): the app renders capability-gated controls (e.g. the model
   * picker only when `models` is present) straight from this.
   */
  capabilities: z.array(Capability).optional(),
  /** The engine's selectable models (`models.list`), grouped by `provider`. */
  models: z.array(ModelOption).optional(),
  /** Provider rows from the same `models.list` (group headers in the picker). */
  providers: z.array(ModelProvider).optional(),
  /** The engine's default model id (`models.list.default`) and its provider. */
  defaultModel: z.string().optional(),
  defaultProvider: z.string().optional(),
});
export type EngineHostStatus = z.infer<typeof EngineHostStatus>;

/**
 * D-#761: one row per engine runtime the harness knows — the default
 * plus lazily-started coding runtimes (`acp:<agent>`, ...).
 * `available` = the runtime's own install probe passed, so the hire flow
 * may offer it; `state`/`detail` are the runtime's own supervisor verdict
 * when it has run (absent = never started).
 */
export const RuntimeStatusRow = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  available: z.boolean().optional(),
  state: EngineHostState.optional(),
  detail: z.string().optional(),
  /* Once the runtime has run and been described: the profile fields its
     `agents` capability lets the app write (`detail.updatable`, D-#19),
     verbatim. Absent = never described — an agent page on this runtime
     keeps its engine fields read-only rather than offering a write the
     engine would refuse (#872). */
  agentsUpdatable: z.array(z.string()).optional(),
});
export type RuntimeStatusRow = z.infer<typeof RuntimeStatusRow>;

/**
 * Push kinds a phone can toggle individually (#161): the two attention
 * transitions (an ask the user must approve, an ask waiting on input),
 * the two terminal ones (turn completed, turn/session failed), and a
 * thread marked stuck (D-#772).
 */
export const PushKind = z.enum([
  "needs_approval",
  "waiting_for_input",
  "completed",
  "failed",
  /* D-#772: a thread marked stuck. The phone registers this with its
     other prefs; absent means off. */
  "stuck",
]);
export type PushKind = z.infer<typeof PushKind>;

/**
 * Per-kind push toggles a device registers with the relay (#161, D-#772):
 * the relay fans a transition out only to registrations whose flag for
 * that kind is on. The four attention and terminal kinds default on when
 * the phone first registers. `stuck` defaults off — a phone is not told
 * a thread is stuck until that phone turns it on.
 */
export const PushPrefs = z.object({
  needsApproval: z.boolean(),
  waitingForInput: z.boolean(),
  completed: z.boolean(),
  failed: z.boolean(),
  stuck: z.boolean().default(false),
});
export type PushPrefs = z.infer<typeof PushPrefs>;

/* ----------------------- workbench targets (#340) ----------------------- */

/**
 * What `workbench_open` shows in a thread's Workbench — the tab plus the focus
 * inside it. `{file, line?}` opens that file — on Changes when it is a
 * changed file, otherwise on the Files tab — scrolled to `line` when given;
 * `{diff, path?}` opens Changes, filtered to `path` when given; `{pr}`
 * opens the PR tab; `{url}` opens Preview (the session browser navigates to
 * it too). It never opens an editor on the Mac.
 *
 * A flat object, not a union: `z.toJSONSchema` on a union emits a bare
 * `anyOf` (no `type:"object"`/`properties`), so function-calling clients
 * advertised the tool with NO arguments and models had to guess them
 * (found in the real-provider live leg of #340). Exactly one of
 * `file`/`diff`/`pr`/`url`/`tab` must be given; `line` only with `file`,
 * `path` only with `diff`. `file`/`diff`/`pr`/`url` need a session folder;
 * `tab` names an engine tab — the only kind a session with no folder
 * accepts (#543).
 */
export const WorkbenchOpenTarget = z
  .strictObject({
    /** The session-folder file to open (on Changes when it is a changed
       file, otherwise on the Files tab). */
    file: z.string().min(1).optional().describe("Session-folder file to show"),
    /** 1-based line inside `file` to scroll to and highlight. */
    line: z
      .int()
      .min(1)
      .optional()
      .describe("1-based line inside `file` to highlight"),
    /** Open the Changes tab (the session's live git diff). */
    diff: z
      .literal(true)
      .optional()
      .describe("Open the Changes tab — the session's live git diff"),
    /** Filter the Changes tab to one file; only together with `diff`. */
    path: z
      .string()
      .min(1)
      .optional()
      .describe("Filter Changes to one file (with `diff`)"),
    /** Open the PR tab (the thread's pull requests). */
    pr: z
      .literal(true)
      .optional()
      .describe("Open the PR tab for the thread's pull requests"),
    /** A preview URL to open on the Preview tab. */
    url: z
      .string()
      .min(1)
      .optional()
      .describe("Preview URL to open on the Preview tab"),
    /** An engine tab to open — the only kind that works for a session
       with no folder (#543). */
    tab: z
      .enum(["subagents", "background", "plan"])
      .optional()
      .describe(
        "Engine tab to open (the only kind a folderless session accepts)",
      ),
  })
  .check((ctx) => {
    const v = ctx.value;
    if (
      [v.file, v.diff, v.pr, v.url, v.tab].filter((x) => x !== undefined)
        .length !== 1
    )
      ctx.issues.push({
        code: "custom",
        message:
          "exactly one of `file`, `diff`, `pr`, `url`, `tab` must be set",
        input: v,
      });
    if (v.line !== undefined && v.file === undefined)
      ctx.issues.push({
        code: "custom",
        message: "`line` only applies together with `file`",
        input: v,
      });
    if (v.path !== undefined && v.diff === undefined)
      ctx.issues.push({
        code: "custom",
        message: "`path` only applies together with `diff`",
        input: v,
      });
  });
export type WorkbenchOpenTarget = z.infer<typeof WorkbenchOpenTarget>;
