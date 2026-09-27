import {
  type AnySQLiteColumn,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Relay storage: LilOS domain objects only (issue #25). The relay owns
 * employees, DM channels, conversations, and visible messages — it does NOT
 * store engine transcripts (tools, reasoning); the engine owns those.
 */
export const employees = sqliteTable("employees", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull().default(""),
  status: text("status", { enum: ["online", "busy", "offline"] })
    .notNull()
    .default("offline"),
  profile: text("profile").notNull().default(""),
  model: text("model").notNull().default(""),
  now: text("now").notNull().default(""),
  instructions: text("instructions").notNull().default(""),
  respondTo: text("respond_to", { enum: ["me", "selected", "anyone"] })
    .notNull()
    .default("me"),
  createdAt: integer("created_at").notNull(),
});

export const channels = sqliteTable(
  "channels",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["dm"] }).notNull(),
    employeeId: text("employee_id")
      .notNull()
      .references(() => employees.id),
    /** Per-channel message watermark; assigning seq increments it atomically. */
    lastSeq: integer("last_seq").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("channels_dm_employee").on(t.kind, t.employeeId)],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    /** The message the thread was opened with. */
    rootMessageId: text("root_message_id")
      .notNull()
      .references((): AnySQLiteColumn => messages.id),
    /** Opaque engine session reference owned by the harness. */
    engineRef: text("engine_ref"),
    state: text("state", { enum: ["idle", "active", "closed"] })
      .notNull()
      .default("idle"),
    /** Model pinned on the engine session (issue #30); null = engine default. */
    model: text("model"),
    /** The rest of the session's pick (issue #92): provider slug, effort, fast. */
    provider: text("provider"),
    effort: text("effort"),
    fast: integer("fast", { mode: "boolean" }),
    title: text("title").notNull().default(""),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    /** Host watermark: highest user-message seq handed to the engine (#28). */
    deliveredSeq: integer("delivered_seq").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("conversations_channel").on(t.channelId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    conversationId: text("conversation_id").references(
      (): AnySQLiteColumn => conversations.id,
    ),
    authorId: text("author_id").notNull(),
    authorKind: text("author_kind", {
      enum: ["user", "employee", "system"],
    }).notNull(),
    text: text("text").notNull(),
    /** Display refs JSON (`MessageAttachment[]`); bytes live outside the row. */
    attachments: text("attachments"),
    /** Engine `turn.started.model` on employee answers (issue #30). */
    model: text("model"),
    /** Engine `turn.started` provider / effort / fast on employee answers (#92). */
    provider: text("provider"),
    effort: text("effort"),
    fast: integer("fast", { mode: "boolean" }),
    /** Monotonic per channel; replay cursor (`afterSeq`) points here. */
    seq: integer("seq").notNull(),
    /** Exactly-once write key (#28): retries return the original row. */
    dedupeKey: text("dedupe_key"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("messages_channel_seq").on(t.channelId, t.seq),
    uniqueIndex("messages_dedupe_key").on(t.channelId, t.dedupeKey),
    index("messages_conversation").on(t.conversationId),
  ],
);

/**
 * Engine asks surfaced to the user (#26). `request` is the EngineRequest JSON
 * verbatim; `state` flips to `resolved` when `asks.respond` lands. The
 * (conversation_id, request_id) pair is unique — re-opening the same engine
 * request after a replay returns the same row.
 */
export const asks = sqliteTable(
  "asks",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    turnId: text("turn_id").notNull(),
    requestId: text("request_id").notNull(),
    request: text("request").notNull(),
    state: text("state", { enum: ["open", "resolved"] })
      .notNull()
      .default("open"),
    outcome: text("outcome"),
    answer: text("answer"),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [
    uniqueIndex("asks_conversation_request").on(t.conversationId, t.requestId),
    index("asks_channel").on(t.channelId),
  ],
);

/**
 * LilOS-owned key/value settings (#92): the one home for app-level state the
 * engine doesn't own — e.g. `modelVisibility` (the Edit-models hide list).
 * `value` is JSON text; `settings.get`/`settings.set` expose it on the wire.
 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
