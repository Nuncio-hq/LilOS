import { z } from "zod";
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
  archived: z.boolean(),
  createdAt: Timestamp,
});
export type Conversation = z.infer<typeof Conversation>;

export const AuthorKind = z.enum(["user", "employee", "system"]);
export type AuthorKind = z.infer<typeof AuthorKind>;

/** A visible message the relay stores — extends the base channel envelope. */
export const AppMessage = z.object({
  ...ChannelMessage.shape,
  /** Thread this message belongs to; `null` = top-level channel message. */
  conversationId: z.string().min(1).nullable(),
  authorKind: AuthorKind,
});
export type AppMessage = z.infer<typeof AppMessage>;
