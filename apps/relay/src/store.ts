import { randomUUID } from "node:crypto";
import type {
  AppChannel,
  AppMessage,
  Ask,
  AskHireProposal,
  AskState,
  AuthorKind,
  CompanyUpdate,
  Conversation,
  ConversationLife,
  ConversationState,
  ConversationSummary,
  Employee,
  EmployeeStatus,
  Goal,
  MessageAttachment,
  MessageSearchHit,
  MessagesSearchParams,
  PairedDevice,
  PendingTurn,
  ProfileSettings,
  Project,
  PushPrefs,
  RecentFolder,
  RespondTo,
  ScheduledRunRecord,
  ScheduledTask,
  TaskSchedule,
  TaskWakeEvent,
  Ticket,
  TicketStatus,
  TicketStep,
  TicketWaitingOn,
  TurnFailure,
  WorkspaceIntent,
} from "@lilos/contracts/app";
import type {
  ApprovalOutcome,
  ConversationAccess,
  EngineRequest,
  Usage,
} from "@lilos/contracts/engine";
import { autoTitle } from "@lilos/contracts/engine";

/**
 * Retired system notes dropped on read (#196): the "No folder: working in
 * …" note a pre-#196 harness stored under `sys:<conversationId>:no-folder`
 * (#113 AC-6, superseded). `NO_FOLDER_DEDUPE_LIKE` is its SQL LIKE shape for
 * the SQLite store; `noFolderDedupeKey` the row predicate for the memory one.
 */
export const NO_FOLDER_DEDUPE_LIKE = "sys:%:no-folder";
export const noFolderDedupeKey = (key: string | null | undefined): boolean =>
  !!key && key.startsWith("sys:") && key.endsWith(":no-folder");

/** A project as the relay creates it (D-#771). */
export interface NewProject {
  /** The canonical `~`-collapsed spelling (`projectFolderOf`) — the unique key
      of the record, the same one the recents list uses. */
  folder: string;
  /** Defaults to the folder's basename. */
  name?: string;
  about?: string;
  /** Stamp for a backfilled project: when its oldest thread opened. */
  createdAt?: number;
}

/** A goal the relay creates (D-#776). `ownerId` absent means the human. */
export interface NewGoal {
  projectId: string;
  title: string;
  due?: string;
  why?: string;
  ownerId?: string;
}

/** Fields a ticket create may set. Status defaults from `waitingOn`. */
export interface NewTicket {
  projectId: string;
  /** The project's key — the id is `${key}-${number}`. */
  projectKey: string;
  title: string;
  goalId?: string;
  ownerId?: string;
  status?: TicketStatus;
  waitingOn?: TicketWaitingOn;
  progress?: TicketStep[];
  startsAt?: string;
  stuckWhy?: string;
}

export interface TicketPatch {
  title?: string;
  goalId?: string | null;
  status?: TicketStatus;
  waitingOn?: TicketWaitingOn | null;
  progress?: TicketStep[];
  result?: Ticket["result"] | null;
  /** D-#844: whole-blob replace — the handler merges, the store stamps. */
  task?: Ticket["task"];
  startsAt?: string | null;
  stuckWhy?: string | null;
}

/** `tasks.create` (D-#844): the ticket is the task record; the child is
    an ordinary thread whose root message is `prompt` and nothing else. */
export interface NewTask {
  /** Task + thread title — the caller's `title`, else the prompt's head. */
  title: string;
  /** The calling thread — the child's `parentId` and every op's scope. */
  parentConversationId: string;
  /** The agent doing the work — ticket owner, child channel owner. */
  employeeId: string;
  /** The employee's dm channel — opened before this call. */
  channelId: string;
  /** The child's whole input — never the parent's transcript. */
  prompt: string;
  /** The parent's project — the ticket and thread file under it. */
  projectId: string;
  projectKey: string;
  /** The parent's level — the child's access is never broader (D-#106). */
  access: ConversationAccess;
  /** The child's working folder — the parent's, or the worktree the
      host resolved for an isolated hand-off (D-#848). */
  cwd?: string;
  /** D-#848: the #156 `workspace` intent an isolated child carries —
      `mode:"new"` makes the bind materialize `cwd` as a worktree of
      `repoPath` before `session.start`, same as a workstream open. */
  workspace?: WorkspaceIntent;
  /** D-#848: stamped on the task blob — where the child ran when a
      worktree was forked (the thread can later move folders). */
  worktree?: { path: string; branch: string };
  /** The caller's pick for the child session (#92-style fields). */
  model?: string;
  provider?: string;
  effort?: string;
  fast?: boolean;
  /** Idempotency key — a retry under the same parent returns the
      stored task (`created: false`). */
  requestId?: string;
}

/** A project's name when none is given: the folder's last segment; the home
    folder itself (`~`) has no segment worth showing, so it is "Home". */
export function projectNameFor(folder: string): string {
  if (folder === "~") return "Home";
  return folder.replace(/\/+$/, "").split("/").pop() || folder;
}

/**
 * The short tag a project gets from its name (D-#771): one word → its first
 * three letters ("LilOS" → "LIL"), several → their initials ("Heard Back" →
 * "HB"), uppercased, ASCII only; a name with no letters or digits is "P".
 * A tag already taken gets a counter ("LIL2") so keys stay unique without
 * ever renaming the older project. Shared by both stores.
 */
export function deriveProjectKey(
  name: string,
  taken: ReadonlySet<string>,
): string {
  const words = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const base = (
    words.length > 1
      ? words
          .slice(0, 3)
          .map((w) => w[0])
          .join("")
      : (words[0] ?? "").slice(0, 3)
  ).toUpperCase();
  const stem = base || "P";
  let key = stem;
  for (let n = 2; taken.has(key); n++) key = `${stem}${n}`;
  return key;
}

/** A hire. When a CEO holds the position, `createEmployee` defaults
    `reportsTo` to that id — the same thing the Hire page says (D-#778).
    With no CEO, a new person reports to the owner until `employees.update`
    says otherwise (D-#775). */
interface NewEmployee {
  name: string;
  role: string;
  status: EmployeeStatus;
  profile: string;
  model: string;
  now: string;
  instructions: string;
  respondTo: RespondTo;
  /** D-#761: engine runtime id ("acp:devin"); absent = the default engine. */
  runtime?: string;
}

/** `reportsTo: null` clears the link (back to the owner). */
type EmployeePatchInput = Partial<NewEmployee> & {
  reportsTo?: string | null;
};

export interface ConversationPatch {
  title?: string;
  /** Provenance of a `title` write (#137) — caller identity, not a wire
      field: `user` (non-host client) marks the name user-chosen forever;
      `auto` (engine host) applies only while the row isn't user-titled. */
  titleSource?: "auto" | "user";
  /* D-#862: `archived` is the legacy alias for settle — the stores
     translate it into the settled_* fields and keep the mirror column
     (archived ⇔ settledAt non-null) inside updateConversation, the only
     writer. */
  archived?: boolean;
  /* D-#862: thread-parking columns. `pinnedAt`/`snoozedUntil`/`settledAt`
     are epoch-ms stamps (`null` clears); `settledReason`/`settledPr` land
     together with `settledAt`. */
  pinnedAt?: number | null;
  settledAt?: number | null;
  settledReason?: "manual" | "idle" | "pr" | null;
  settledPr?: { num: number; state: "merged" | "closed" } | null;
  snoozedUntil?: number | null;
  autoSettle?: boolean;
  state?: ConversationState;
  engineRef?: string;
  /** The model pinned on the engine session (issue #30). `null` clears
      (a failed-pick restore, #92) — like the other pick fields. */
  model?: string | null;
  /** The rest of the session's pick (issue #92). `null` clears — a pick
      that drops a field must not leave the old value on the row. */
  provider?: string | null;
  effort?: string | null;
  fast?: boolean | null;
  deliveredSeq?: number;
  /** The composer pill's level (#106) — `conversations.setAccess`. */
  access?: ConversationAccess;
  /** The engine session's life (#346): `open`/`closed` — `running` is a
      client-derived state and never lands on the row. */
  life?: ConversationLife;
  /** Host-only (#419): stamp the last turn's failure for the thread's alert
      card; `null` clears it (next `turn.started`). */
  turnFailure?: TurnFailure | null;
  /** Host-only (#581): the thread's working folder — `conversations.moveFolder`
      writes it after re-homing the session; `null` clears it. */
  cwd?: string | null;
  /** The project the thread lives in (D-#771) — relay-set when `cwd` lands
      (open, move, backfill), never a wire field; `null` = a plain chat. */
  projectId?: string | null;
  /** #583: the last turn ended stopped — host-written, same lifecycle
      as `turnFailure`. */
  turnStopped?: boolean | null;
  /** #583: running background-job count — host-written, same lifecycle. */
  bgJobs?: number | null;
  /** Host-only (D-#772): the running turn is stuck; `null` clears it. */
  stuck?: { reason: string } | null;
}

export interface OpenConversationInput {
  channelId: string;
  /** Empty = store derives a placeholder from `text`/`attachments` (#137). */
  title: string;
  /** What an explicit `title` means (#137): the opener is a user client
      ("user") or the engine host ("auto"). Ignored for placeholders. */
  titleSource?: "auto" | "user";
  text: string;
  authorId: string;
  /** Display refs only — bytes already stored via the AttachmentStore. */
  attachments?: MessageAttachment[];
  /** The composer's pick stamped at open (#92) — `session.start` applies it. */
  model?: string;
  provider?: string;
  effort?: string;
  fast?: boolean;
  /** Folder the session works in (#113); also bumps the recents list. For a
      workstream open (#156) this is the worktree path and `workspace.repoPath`
      bumps recents instead. */
  cwd?: string;
  /** Workstream pick stamped at open (#156): new/existing worktree of
      `repoPath`; absent = `cwd` is the folder itself. */
  workspace?: WorkspaceIntent;
  /** The project the relay filed this thread under (D-#771), resolved from
      `workspace.repoPath ?? cwd` before landing; absent = a plain chat. */
  projectId?: string;
  /** The ticket this thread is a hand of (D-#776). Only `tickets.assign`
      sets it — a normal open is not on a ticket. */
  ticketId?: string;
  /** D-#844: the thread that handed this one a task — only `tasks.create`
      (via `createTask`) sets it. */
  parentId?: string;
  /** The access level stamped at open (#106) — the relay resolves
      `params.access ?? Settings' defaultAccess ?? "ask"` before landing. */
  access?: ConversationAccess;
  /** Exactly-once key for retried opens (#552): stamped on the root
      message's (channelId, key) slot — the same index `appendMessage`
      dedupes on — so a resend answers the stored thread. */
  dedupeKey?: string;
  /** Host-only (D-#777). Absent is the owner's send. */
  authorKind?: AuthorKind;
  /** Host-only (D-#777): the root message is a CEO wake, and this
      conversation is the standing thread. */
  ceoWake?: true;
  /** Host-only (#136): the scheduled task the run was fired for — the
      thread is marked and the chip opens the task. */
  scheduled?: { taskId: string; name: string };
}

/* Scheduled tasks (#136): the store keeps the row the host's scheduler
   reads; run bookkeeping fields come from the host only. */
export interface NewScheduledTask {
  employeeId: string;
  name: string;
  prompt: string;
  folder?: string;
  schedule: TaskSchedule;
  access: ConversationAccess;
}

export interface ScheduledTaskPatch {
  name?: string;
  prompt?: string;
  folder?: string | null;
  schedule?: TaskSchedule;
  access?: ConversationAccess;
  paused?: boolean;
  lastRun?: ScheduledRunRecord | null;
  skippedAt?: number | null;
  lastFiredAt?: number | null;
  requestedAt?: number | null;
}

export interface AppendMessageInput {
  channelId: string;
  conversationId?: string;
  authorId: string;
  authorKind: AuthorKind;
  text: string;
  /** Display refs only — bytes already stored via the AttachmentStore. */
  attachments?: MessageAttachment[];
  /** Engine `turn.started.model` on employee answers (issue #30). */
  model?: string;
  /** Engine `turn.started` provider / effort / fast on employee answers (#92). */
  provider?: string;
  effort?: string;
  fast?: boolean;
  /** Exactly-once key: a retry with a recorded key returns the original message. */
  dedupeKey?: string;
  /** Host-only (D-#777): this message is a CEO wake. Storing it also
      marks the conversation as the standing thread. */
  ceoWake?: true;
  /** Host-only (D-#844): this message is a task wake — a child's
      finished turn prompting the parent thread. */
  taskWake?: true;
}

export interface ListMessagesQuery {
  conversationId?: string;
  afterSeq?: number;
  limit?: number;
  /** Audit reads can ask for dropped messages back (#134); default hides them. */
  includeRewound?: boolean;
  /** The not-sent tray reads Stop-parked rows (#315); default hides them. */
  includeDropped?: boolean;
}

export interface ListMessagesPage {
  messages: AppMessage[];
  lastSeq: number;
}

/**
 * #138: search semantics shared by both stores — whitespace-split lowercase
 * terms, all must match (AND), except the last which is a prefix so the box
 * can filter while the user is mid-word.
 */
export function searchTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Word tokens the way the FTS unicode61 tokenizer sees them. */
const textTokens = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);

/** Term match: earlier terms must hit a whole token; the last is a prefix.
    Shared with the test memory store (test/memory-store.ts). */
export function messageMatchesTerms(text: string, terms: string[]): boolean {
  if (!terms.length) return false;
  const toks = textTokens(text);
  return terms.every((t, i) =>
    i < terms.length - 1 ? toks.includes(t) : toks.some((w) => w.startsWith(t)),
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* A relay-snippet-shaped excerpt for the memory store: a ~12-word window
   opening a few words before the first match (the SQLite side uses
   snippet(…, 12)), `…` at clipped edges, `<mark>` around every term hit.
   Shared with the test memory store (test/memory-store.ts). */
export function markSnippet(text: string, terms: string[]): string {
  if (!terms.length) return text.slice(0, 96);
  const patterns = terms.map(
    (t, i) =>
      `(?<![\\w])${escapeRe(t)}${i < terms.length - 1 ? `(?![\\w])` : `[\\w]*`}`,
  );
  const re = new RegExp(patterns.join("|"), "gi");
  const first = re.exec(text);
  if (!first) return text.slice(0, 96);
  const words = [...text.matchAll(/\S+/g)];
  const hit = words.findIndex((w) => w.index + w[0].length > first.index);
  if (hit < 0) return text.slice(0, 96);
  const from = Math.max(0, hit - 3);
  const last = Math.min(words.length - 1, from + 11);
  const start = words[from].index;
  const end = words[last].index + words[last][0].length;
  const marked = text.slice(start, end).replace(re, (s) => `<mark>${s}</mark>`);
  return `${start > 0 ? "…" : ""}${marked}${end < text.length ? "…" : ""}`;
}

export interface ListConversationsQuery {
  channelId?: string;
  includeArchived: boolean;
  /** Scope to one conversation (#571's incremental summary refresh). */
  conversationId?: string;
}

export interface NewAsk {
  channelId: string;
  conversationId: string;
  turnId: string;
  requestId: string;
  request: EngineRequest;
  /** Gateway `team_hire` ask's hire draft. */
  hire?: AskHireProposal;
  /** D-#773: Needs you lines. Omitted on an engine approval. */
  why?: string;
  ifYes?: string;
  ifNo?: string;
}

export interface ResolveAskInput {
  outcome: ApprovalOutcome;
  answer?: string;
}

export interface ListAsksQuery {
  channelId?: string;
  conversationId?: string;
  state?: AskState;
}

/**
 * What the ws layer needs from persistence. Implemented by Drizzle+SQLite in
 * production (`db/drizzle-store.ts`) and by memory in tests — the protocol
 * machine is identical against both.
 */
export interface RelayStore {
  listEmployees(): Promise<Employee[]>;
  getEmployee(id: string): Promise<Employee | null>;
  createEmployee(input: NewEmployee): Promise<Employee>;
  updateEmployee(
    id: string,
    patch: EmployeePatchInput,
  ): Promise<Employee | null>;
  /**
   * Deletes the employee plus its whole LilOS-side graph (channel,
   * conversations, messages, asks) in one step. The engine profile is never
   * touched — engines own profiles; the relay only drops its own records.
   * Returns the deleted row + removed channel ids, or null when unknown.
   * `clearedCeo` is true when this person held the position: the same
   * write drops `ceoId` (D-#778).
   */
  removeEmployee(id: string): Promise<{
    employee: Employee;
    channelIds: string[];
    clearedCeo: boolean;
  } | null>;
  /**
   * One write for the CEO position (D-#778): `ceoId` in the settings KV
   * and the `reportsTo` edges that follow it. `changed` is false when
   * this employee already holds it (no events). `employees` is only the
   * rows whose link changed. Null when the employee does not exist.
   * Throws `CeoGraphError` if the result would cycle.
   */
  setCeo(employeeId: string): Promise<{
    ceoId: string;
    employees: Employee[];
    changed: boolean;
  } | null>;

  listChannels(): Promise<AppChannel[]>;
  getChannel(id: string): Promise<AppChannel | null>;
  /** Get-or-create the employee's internal channel (the wire's "dm" kind). */
  openDmChannel(
    employeeId: string,
  ): Promise<{ channel: AppChannel; created: boolean }>;

  /* --------------------- scheduled tasks (#136) ---------------------- */
  /** Every task, or one employee's — the host reads all, the app its own. */
  listScheduledTasks(employeeId?: string): Promise<ScheduledTask[]>;
  getScheduledTask(id: string): Promise<ScheduledTask | null>;
  createScheduledTask(input: NewScheduledTask): Promise<ScheduledTask>;
  updateScheduledTask(
    id: string,
    patch: ScheduledTaskPatch,
  ): Promise<ScheduledTask | null>;
  /** Returns the removed task so subscribers can be told, null when unknown. */
  deleteScheduledTask(id: string): Promise<ScheduledTask | null>;

  /* ------------------------- projects (D-#771) ------------------------- */
  /** Every project, oldest first. */
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  /**
   * Get-or-create the project for `folder` (already in the canonical
   * spelling — `projectFolderOf` normalizes). One atomic step, so two opens
   * into a new folder
   * can never make two projects: `created: false` answers the stored row
   * unchanged (name/about are only applied on create). The key is derived
   * from the name and made unique here.
   */
  ensureProject(
    input: NewProject,
  ): Promise<{ project: Project; created: boolean }>;

  /* --------------------- goals and tickets (D-#776) -------------------- */
  listGoals(): Promise<Goal[]>;
  createGoal(input: NewGoal): Promise<Goal>;
  listTickets(projectId?: string): Promise<Ticket[]>;
  getTicket(id: string): Promise<Ticket | null>;
  /** Allocates the project's next number inside the write. */
  createTicket(input: NewTicket): Promise<Ticket>;
  /**
   * Apply a field write. When the ticket becomes done, every ticket waiting
   * on it moves in the same transaction. The first row is the one written;
   * the rest are the waiters.
   */
  updateTicket(id: string, patch: TicketPatch): Promise<Ticket[] | null>;
  /**
   * Checkout: set the owner and open their thread in one transaction.
   * `channelId` is the owner's channel, opened before this call. A planned
   * ticket becomes working. Reassigning adds another thread; the previous
   * hand stays.
   */
  assignTicket(input: {
    id: string;
    ownerId: string;
    channelId: string;
    /** Resolved like `conversations.open`: the company's default, else ask. */
    access?: ConversationAccess;
  }): Promise<{
    ticket: Ticket;
    conversation: Conversation;
    rootMessage: AppMessage;
  } | null>;
  commentTicket(
    id: string,
    update: { by: string; text: string },
  ): Promise<Ticket | null>;
  /** Newest first (D-#777). */
  listUpdates(): Promise<CompanyUpdate[]>;
  postUpdate(input: {
    kind: CompanyUpdate["kind"];
    text: string;
    ticketId?: string;
    goalId?: string;
    authorKind: "employee" | "system";
    authorId?: string;
  }): Promise<CompanyUpdate>;
  /** Threads that are a hand of this ticket, newest first. */
  threadsOnTicket(ticketId: string): Promise<Conversation[]>;

  /* ------------------- agent hand-off tasks (D-#844) ------------------- */
  /**
   * Ticket + child thread in one transaction — `assignTicket`'s shape.
   * `requestId` lands on the ticket's task columns, so a retry under the
   * same parent answers the stored pair (`created: false`) — the
   * (parent, requestId) index is what makes the repeat a hit. The child's
   * `access` is the parent's own, never broader (D-#106).
   */
  createTask(input: NewTask): Promise<{
    ticket: Ticket;
    conversation: Conversation;
    rootMessage: AppMessage;
    created: boolean;
  }>;
  /** The task a caller's `requestId` already made under this parent. */
  findTaskTicket(
    parentConversationId: string,
    requestId: string,
  ): Promise<Ticket | null>;
  /** Threads this parent created via `tasks.create` — the `thread_*`
      follow-up scope (D-#844). */
  childConversations(parentId: string): Promise<Conversation[]>;
  /**
   * One coalesced wake per parent, all writes in one step: drop events
   * for cancelled tasks, turn ids already in `wakedTurnIds`, and results
   * the child's `finishedSeq` already covers (`lastResult.finishedSeq`),
   * then post each parent's `taskWake` message and stamp each surviving
   * ticket — the post and the fence commit together (D-#844). `text`
   * formats one parent's batch; the stamp flips the ticket done/failed
   * and wakes its waiters like any finish (D-#776).
   */
  postTaskWake(
    events: readonly TaskWakeEvent[],
    text: (events: readonly TaskWakeEvent[]) => string,
  ): Promise<{
    delivered: string[];
    messages: AppMessage[];
    tickets: Ticket[];
  }>;

  listConversations(query: ListConversationsQuery): Promise<Conversation[]>;
  /**
   * Session-folder recents (#113): one shared list, newest-first. `add` is
   * an upsert on `path`; `openConversation` bumps the same row for `cwd`.
   */
  listRecentFolders(): Promise<RecentFolder[]>;
  addRecentFolder(path: string): Promise<RecentFolder>;
  /**
   * The signed-in human's profile (#118) — `{}` until the user sets it; the
   * app layers OS-derived prefill on top (AC-4). `updateProfile` merges
   * the given keys and returns the stored profile.
   */
  getProfile(): Promise<ProfileSettings>;
  updateProfile(patch: ProfileSettings): Promise<ProfileSettings>;
  /**
   * One row per conversation carrying the messages the session list renders
   * — the list survives the channel's snapshot window (#28 AC-1).
   */
  listConversationSummaries(
    query: ListConversationsQuery,
  ): Promise<ConversationSummary[]>;
  getConversation(id: string): Promise<Conversation | null>;
  /**
   * Root message + conversation in one transaction. `dedupeKey` makes the
   * write idempotent (#552): `created: false` answers the stored pair for
   * a key the channel already recorded.
   */
  openConversation(input: OpenConversationInput): Promise<{
    conversation: Conversation;
    rootMessage: AppMessage;
    created: boolean;
  }>;
  updateConversation(
    id: string,
    patch: ConversationPatch,
  ): Promise<Conversation | null>;
  /**
   * File many threads in one transaction (the boot backfill, D-#771): one
   * commit instead of one fsync per thread on an install with thousands.
   * Unknown conversation ids are skipped.
   */
  setConversationProjects(
    filings: readonly { conversationId: string; projectId: string }[],
  ): Promise<void>;
  /**
   * Persist a turn.completed's usage on the conversation row (#300) — the
   * context meter's numbers, kept off the event stream so a dead engine
   * session can't take the meter with it. `sessionId`+`seq` are the
   * freshness fence: a replayed turn from the SAME session only writes
   * past the stored seq; a different session always writes (seq restarts
   * per session, so a rebind's first turn replaces the dead session's
   * numbers — dead sessions emit nothing, so a late same-id write can't
   * arrive post-rebind). Unknown conversations are dropped silently.
   */
  recordTurnUsage(input: {
    conversationId: string;
    sessionId: string;
    seq: number;
    usage: Usage;
  }): Promise<void>;

  /**
   * Stamp a turn end on the conversation (#563): `finishedSeq` becomes a
   * stamp strictly past every mark the relay has seen —
   * `max(channel.lastSeq, readSeq) + 1` — so the "finished, not seen" dot
   * (`finishedSeq > readSeq`) always fires, even on a channel quiet since
   * the last read (the finish's own channel writes arrive after the
   * engine event that stamps it). `sessionId`/`eventSeq` are the
   * freshness fence (same rule as `recordTurnUsage`): a replayed older
   * finish from the same session can't rewrite; a rebound session writes
   * freely.
   */
  recordConversationFinish(input: {
    conversationId: string;
    sessionId: string;
    eventSeq: number;
  }): Promise<void>;

  /**
   * The user's read watermark (#563): set `readSeq` past every finish the
   * relay has stamped — `max(channel.lastSeq, finishedSeq)` — so opening
   * the thread counts every finish up to now as seen, on every device at
   * once. Returns the updated row, or null for an unknown conversation.
   */
  markConversationRead(conversationId: string): Promise<Conversation | null>;

  listMessages(
    channelId: string,
    query: ListMessagesQuery,
  ): Promise<ListMessagesPage>;
  /**
   * Full-text search over stored message text (#138). Hits come back ordered
   * by relevance (best first); `includeArchived` keeps hits in archived
   * conversations, off by default like `conversations.list`. Only the hit
   * set is contractual — rank order differs between implementations.
   */
  searchMessages(params: MessagesSearchParams): Promise<MessageSearchHit[]>;
  /**
   * Appends with the channel's next seq (atomic with the counter bump).
   * `dedupeKey` makes the write idempotent: `created: false` returns the
   * message the first call stored.
   */
  appendMessage(
    input: AppendMessageInput,
  ): Promise<{ message: AppMessage; created: boolean }>;

  getMessage(id: string): Promise<AppMessage | null>;
  /** Stamp the pre-turn folder checkpoint onto a user message (#134). */
  setMessageCheckpoint(
    messageId: string,
    checkpoint: string,
  ): Promise<AppMessage | null>;
  /**
   * Flip a message's `dropped`/`removed`/`claimed` delivery flags (#315,
   * #377). Returns the updated row for the `message.changed` broadcast,
   * null when missing.
   */
  setMessageFlags(
    messageId: string,
    flags: { dropped?: boolean; removed?: boolean; claimed?: boolean },
  ): Promise<AppMessage | null>;
  /**
   * Mark every message on the conversation with `seq >= fromSeq` as rewound
   * (#134): hidden from thread/summary reads, kept for audit. Returns the
   * messages it marked, oldest first.
   */
  markRewound(conversationId: string, fromSeq: number): Promise<AppMessage[]>;

  /**
   * D-#862: the newest user-authored message's stamp in a thread — the user's
   * resume clock for the PR-settle guard (only his messages resume a
   * thread; agent turns and background wakes do not). `undefined` when the
   * thread has no user row.
   */
  lastUserMessageAt(conversationId: string): Promise<number | undefined>;

  /**
   * Idempotent on (conversationId, requestId): re-opening the same engine
   * request returns the existing ask unchanged (the harness may re-open after
   * a reconnect replay).
   */
  createAsk(input: NewAsk): Promise<{ ask: Ask; created: boolean }>;
  getAsk(id: string): Promise<Ask | null>;
  resolveAsk(id: string, resolution: ResolveAskInput): Promise<Ask | null>;
  listAsks(query: ListAsksQuery): Promise<Ask[]>;

  /**
   * User messages, and CEO wakes, past each conversation's `deliveredSeq`
   * watermark — the turns the engine host still owes. A wake is owed by
   * its flag, not by its text (D-#777). Surfaced by `harness.register`.
   */
  listPendingTurns(): Promise<PendingTurn[]>;

  /**
   * LilOS-owned key/value settings (#92): `settings.get` returns the stored
   * JSON value or null; `settings.set` upserts it. The Edit-models hide
   * list (`modelVisibility`) lives here — one list for the whole company.
   */
  getSetting(key: string): Promise<unknown | null>;
  setSetting(key: string, value: unknown): Promise<void>;

  /* ---------------------- phone pairing (#153) ------------------------ */
  /**
   * A pairing grant is stored only as a hash — the raw code exists in the QR
   * and the exchange request, never in the DB. `consumedAt` set = spent.
   */
  insertPairingGrant(grant: {
    codeHash: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<void>;
  /**
   * Spend a grant atomically: marks it consumed when it is known, unexpired
   * (`expiresAt > at`) and unused; the failure string classifies the refusal
   * so the exchange endpoint can answer `unknown` | `expired` | `used`.
   */
  consumePairingGrant(
    codeHash: string,
    at: number,
  ): Promise<"ok" | "unknown" | "expired" | "used">;
  /**
   * Spend a grant AND record the new device in one transaction — a
   * device-insert failure rolls the spend back so the phone can retry the
   * same code instead of losing it to an opaque 500.
   */
  exchangePairingGrant(input: {
    codeHash: string;
    device: NewPairedDevice;
    at: number;
  }): Promise<
    { device: PairedDevice } | { error: "unknown" | "expired" | "used" }
  >;
  /** Drop spent/expired grant rows; called on every mint so the table stays small. */
  prunePairingGrants(at: number): Promise<void>;
  insertPairedDevice(device: NewPairedDevice): Promise<PairedDevice>;
  /**
   * Device-credential hello: a hash match on an unrevoked device bumps
   * `lastSeenAt` and returns the record; anything else returns null.
   */
  authenticateDevice(input: {
    deviceId: string;
    credentialHash: string;
    seenAt: number;
  }): Promise<PairedDevice | null>;
  listPairedDevices(): Promise<PairedDevice[]>;
  /** Mark revoked; returns the public record, null when unknown/already off.
      Also drops the device's push registration (#161 AC-1). */
  revokePairedDevice(
    id: string,
    revokedAt: number,
  ): Promise<PairedDevice | null>;

  /* ------------------------- push registration (#161) ----------------------- */

  /** Upsert a device's Expo push token + per-kind toggles (idempotent). */
  setDevicePush(input: {
    deviceId: string;
    token: string;
    prefs: PushPrefs;
    at: number;
  }): Promise<void>;
  /** Every phone still registered for pushes — the fan-out targets. */
  listDevicePush(): Promise<DevicePush[]>;
  /** Drop a registration (push.unregister, dead token, revoke). */
  dropDevicePush(deviceId: string): Promise<void>;
  /**
   * Engine-event freshness watermark (#161): records `seq` as the highest
   * engine-event seq the relay has seen for `sessionId` and answers whether
   * this call advanced it. A replayed `engine.event` (`seq` at/under the
   * stored mark) answers false so a relay or harness restart can't
   * re-notify an old transition. Persisted — an in-memory mark would let a
   * relay restart re-push.
   */
  advanceEngineEventSeq(input: {
    sessionId: string;
    seq: number;
    at: number;
  }): Promise<boolean>;
}

/** A phone's Expo push registration (#161), tied to its paired device id. */
export interface DevicePush {
  deviceId: string;
  token: string;
  prefs: PushPrefs;
  updatedAt: number;
}

/** A new paired device as written (credential arrives pre-hashed). */
export interface NewPairedDevice {
  id: string;
  name: string;
  credentialHash: string;
  pairedAt: number;
  lastSeenAt: number;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * The name a conversation wears before the engine titles it (#137 AC-3):
 * the first full sentence of the first message, ≤ ~60 chars — the shared
 * `autoTitle` rule (#886) — or `Image` for an image-only send.
 */
function placeholderTitle(text: string, hasAttachments: boolean): string {
  return autoTitle(text) || (hasAttachments ? "Image" : "");
}

/** Resolve the title + provenance for a new conversation (#137). */
export function openTitle(input: OpenConversationInput): {
  title: string;
  titleSource: "auto" | "user";
} {
  if (input.title !== "") {
    // A title passed at open is a chosen name — user unless the engine
    // host itself opened the conversation.
    return { title: input.title, titleSource: input.titleSource ?? "user" };
  }
  return {
    title: placeholderTitle(input.text, (input.attachments?.length ?? 0) > 0),
    titleSource: "auto",
  };
}

/**
 * Fold title provenance into an update patch (#137 AC-2): an `auto` write
 * (engine host) applies only while the row isn't user-titled; a `user`
 * write always applies and marks the row user-named.
 */
export function titlePatch(
  patch: ConversationPatch,
  current: Conversation | { titleSource: "auto" | "user" },
): ConversationPatch {
  if (patch.title === undefined) return patch;
  const provenance = patch.titleSource ?? "user";
  if (provenance === "auto" && current.titleSource === "user") {
    // A late engine title never overwrites a rename.
    const { title: _title, titleSource: _ts, ...rest } = patch;
    return rest;
  }
  return { ...patch, titleSource: provenance };
}
