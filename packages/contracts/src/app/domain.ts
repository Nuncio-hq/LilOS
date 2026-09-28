import { z } from "zod";
import { Capability } from "../engine/capabilities";
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
  createdAt: Timestamp,
});
export type Employee = z.infer<typeof Employee>;

/** Only `dm` exists today; new kinds bump the protocol version. */
export const ChannelKind = z.enum(["dm"]);
export type ChannelKind = z.infer<typeof ChannelKind>;

/**
 * A DM channel is the private channel between the user and one employee
 * (decision: DM = private channel with exactly one employee).
 */
export const AppChannel = z.object({
  id: z.string().min(1),
  kind: ChannelKind,
  /** The employee this DM is with. Required while `dm` is the only kind. */
  employeeId: z.string().min(1),
  /** Highest seq assigned in this channel (0 = no messages yet). */
  lastSeq: z.int().min(0),
  createdAt: Timestamp,
});
export type AppChannel = z.infer<typeof AppChannel>;

/**
 * A conversation is a thread inside a channel; each conversation maps to
 * exactly one engine session via `engineRef` (set by the harness once the
 * engine session exists — `null` until then).
 */
export const ConversationState = z.enum(["idle", "active", "closed"]);
export type ConversationState = z.infer<typeof ConversationState>;

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
   * harness's default workdir.
   */
  cwd: z.string().min(1).optional(),
  archived: z.boolean(),
  /**
   * Host-owned watermark: highest user-message seq the harness has handed to
   * the engine. User messages beyond it are the owed turns — this is what
   * survives a restart when a message queued mid-turn sits behind the
   * previous turn's answer in seq order.
   */
  deliveredSeq: z.int().min(0).default(0),
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
});
export type AppMessage = z.infer<typeof AppMessage>;

/* ------------------------------ asks (#26) ------------------------------ */

/**
 * An engine ask (`request.opened`) surfaced on the relay so the app can answer
 * it. `request` is the engine's EngineRequest verbatim — the relay passes it
 * through and never interprets it; kinds outside the engine's
 * approval/question union cannot be represented here by construction.
 */
export const AskState = z.enum(["open", "resolved"]);
export type AskState = z.infer<typeof AskState>;

export const Ask = z.object({
  id: z.string().min(1),
  channelId: z.string().min(1),
  conversationId: z.string().min(1),
  /** Engine turn the ask belongs to (opaque to the relay). */
  turnId: z.string().min(1),
  /** Engine request id the harness echoes back in `request.respond`. */
  requestId: z.string().min(1),
  request: EngineRequest,
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
  /** The user message that opened the thread. */
  root: AppMessage,
  /** First non-user message in the thread — the "answer preview". */
  firstAnswer: AppMessage.optional(),
  /** Newest message in the thread (any author). */
  last: AppMessage,
  /** Total messages in the thread, root included. */
  messageCount: z.int().min(1),
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
