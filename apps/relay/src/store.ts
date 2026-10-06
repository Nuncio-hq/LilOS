import { randomUUID } from "node:crypto";
import type {
  AppChannel,
  AppMessage,
  Ask,
  AskState,
  AuthorKind,
  Conversation,
  ConversationLife,
  ConversationState,
  ConversationSummary,
  Employee,
  EmployeeStatus,
  MessageAttachment,
  MessageSearchHit,
  MessagesSearchParams,
  PairedDevice,
  PendingTurn,
  ProfileSettings,
  PushPrefs,
  RecentFolder,
  RespondTo,
  TurnFailure,
  WorkspaceIntent,
} from "@lilos/contracts/app";
import type {
  ApprovalOutcome,
  ConversationAccess,
  EngineRequest,
  Usage,
} from "@lilos/contracts/engine";

/**
 * Retired system notes dropped on read (#196): the "No folder: working in
 * …" note a pre-#196 harness stored under `sys:<conversationId>:no-folder`
 * (#113 AC-6, superseded). `NO_FOLDER_DEDUPE_LIKE` is its SQL LIKE shape for
 * the SQLite store; `noFolderDedupeKey` the row predicate for the memory one.
 */
export const NO_FOLDER_DEDUPE_LIKE = "sys:%:no-folder";
export const noFolderDedupeKey = (key: string | null | undefined): boolean =>
  !!key && key.startsWith("sys:") && key.endsWith(":no-folder");

interface NewEmployee {
  name: string;
  role: string;
  status: EmployeeStatus;
  profile: string;
  model: string;
  now: string;
  instructions: string;
  respondTo: RespondTo;
}

type EmployeePatchInput = Partial<NewEmployee>;

export interface ConversationPatch {
  title?: string;
  /** Provenance of a `title` write (#137) — caller identity, not a wire
      field: `user` (non-host client) marks the name user-chosen forever;
      `auto` (engine host) applies only while the row isn't user-titled. */
  titleSource?: "auto" | "user";
  archived?: boolean;
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
  /** Host-only (#419): stamp the last turn's failure for the DM alert
      card; `null` clears it (next `turn.started`). */
  turnFailure?: TurnFailure | null;
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
  /** The access level stamped at open (#106) — the relay resolves
      `params.access ?? Settings' defaultAccess ?? "ask"` before landing. */
  access?: ConversationAccess;
  /** Exactly-once key for retried opens (#552): stamped on the root
      message's (channelId, key) slot — the same index `appendMessage`
      dedupes on — so a resend answers the stored thread. */
  dedupeKey?: string;
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
}

export interface NewAsk {
  channelId: string;
  conversationId: string;
  turnId: string;
  requestId: string;
  request: EngineRequest;
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
   * Deletes the employee plus its whole LilOS-side graph (DM channel,
   * conversations, messages, asks) in one step. The engine profile is never
   * touched — engines own profiles; the relay only drops its own records.
   * Returns the deleted row + removed channel ids, or null when unknown.
   */
  removeEmployee(
    id: string,
  ): Promise<{ employee: Employee; channelIds: string[] } | null>;

  listChannels(): Promise<AppChannel[]>;
  getChannel(id: string): Promise<AppChannel | null>;
  /** Get-or-create the DM channel with this employee. */
  openDmChannel(
    employeeId: string,
  ): Promise<{ channel: AppChannel; created: boolean }>;

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
   * Idempotent on (conversationId, requestId): re-opening the same engine
   * request returns the existing ask unchanged (the harness may re-open after
   * a reconnect replay).
   */
  createAsk(input: NewAsk): Promise<{ ask: Ask; created: boolean }>;
  getAsk(id: string): Promise<Ask | null>;
  resolveAsk(id: string, resolution: ResolveAskInput): Promise<Ask | null>;
  listAsks(query: ListAsksQuery): Promise<Ask[]>;

  /**
   * User messages past each conversation's `deliveredSeq` watermark — the
   * turns the engine host still owes. Surfaced by `harness.register`.
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
 * the first ~6 words / ~60 chars of the first message — the same rule
 * Synara uses — or `Image` for an image-only send. Collapses whitespace so
 * multi-line pastes read as one line.
 */
function placeholderTitle(text: string, hasAttachments: boolean): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return hasAttachments ? "Image" : "";
  const words = clean.split(" ");
  let title = words.slice(0, 6).join(" ");
  if (title.length > 60) {
    // Over-long first words: cut under 60 chars at a word boundary.
    const cut = title.slice(0, 59);
    const boundary = cut.lastIndexOf(" ");
    title = boundary > 0 ? cut.slice(0, boundary) : cut;
    return `${title}…`;
  }
  return words.length > 6 ? `${title}…` : title;
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
