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
    /** Folder the session runs in (issue #113); null = harness default dir.
        For a workstream open (#156) this is the worktree path. */
    cwd: text("cwd"),
    /** Workstream mode stamped at open (#156): JSON WorkspaceIntent; null =
        direct folder / just chat. */
    workspace: text("workspace"),
    title: text("title").notNull().default(""),
    /** Who named the conversation (#137): `user` wins over every later
        engine/auto title write; `auto` is free to be upgraded. */
    titleSource: text("title_source", { enum: ["auto", "user"] })
      .notNull()
      .default("auto"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    /** Host watermark: highest user-message seq handed to the engine (#28). */
    deliveredSeq: integer("delivered_seq").notNull().default(0),
    /** The newest turn.completed's usage (#300): JSON engine `Usage`
        (input/output/reasoning/cache + optional contextWindow) — the context
        meter's numbers, kept on the row so a dead engine session can't take
        the meter with it. */
    usage: text("usage"),
    /** Freshness fence for `usage` writes (#300): the session + seq of the
        turn.completed that stored it. A replayed older turn from the same
        session can't regress the row; a rebound session writes freely. */
    usageSessionId: text("usage_session_id"),
    usageSeq: integer("usage_seq").notNull().default(0),
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
    /** Rewound by `conversations.rewind` (#134): hidden, kept for audit. */
    rewound: integer("rewound", { mode: "boolean" }).notNull().default(false),
    /** ■ Stop parked it in the not-sent tray (#315): hidden, never delivered. */
    dropped: integer("dropped", { mode: "boolean" }).notNull().default(false),
    /** User removed it while still waiting (#315): hidden, never delivered. */
    removed: integer("removed", { mode: "boolean" }).notNull().default(false),
    /** Harness committed its prompt to dispatch (#377): not "waiting". */
    claimed: integer("claimed", { mode: "boolean" }).notNull().default(false),
    /** Pre-turn folder checkpoint id stamped by the harness (#134). */
    checkpoint: text("checkpoint"),
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
 * LilOS-owned recent folders for the session picker (#113): one shared list,
 * newest-first by `last_used_at`. `folders.add` upserts; `conversations.open`
 * with `cwd` bumps the same row.
 */
export const recentFolders = sqliteTable("recent_folders", {
  path: text("path").primaryKey(),
  lastUsedAt: integer("last_used_at").notNull(),
});

/**
 * LilOS-owned key/value settings (#92): the one home for app-level state the
 * engine doesn't own — e.g. `modelVisibility` (the Edit-models hide list).
 * `value` is JSON text; `settings.get`/`settings.set` expose it on the wire.
 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * The signed-in human's profile (#118): one row (`id` = 1) of relay-owned
 * identity — name, company name, avatar colour. Columns stay NULL until the
 * user sets them; the app prefills from the OS on an untouched install.
 */
export const profile = sqliteTable("profile", {
  id: integer("id").primaryKey(),
  userName: text("user_name"),
  companyName: text("company_name"),
  avatarColor: text("avatar_color"),
});

/**
 * One-time pairing grants (#153): the code shown in the Pair phone QR is
 * stored only as `code_hash` (SHA-256) — the raw value lives in the QR and
 * the exchange request, never on disk. A set `consumed_at` means spent;
 * `expires_at` is the 5-minute TTL.
 */
export const pairingGrants = sqliteTable("pairing_grants", {
  codeHash: text("code_hash").primaryKey(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
});

/**
 * Devices paired to this install (#153): phones that exchanged a grant for
 * their own credential. The credential is stored only as `credential_hash`;
 * a set `revoked_at` closes live sockets and blocks future hellos.
 */
export const pairedDevices = sqliteTable("paired_devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  credentialHash: text("credential_hash").notNull().unique(),
  pairedAt: integer("paired_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  revokedAt: integer("revoked_at"),
});

/**
 * Expo push registrations (#161): one row per paired phone — its Expo push
 * token and the four per-kind toggles it last registered. Tied to
 * `paired_devices.id`; a revoke deletes the row so a dead phone stops
 * receiving pushes.
 */
export const devicePush = sqliteTable("device_push", {
  deviceId: text("device_id")
    .primaryKey()
    .references(() => pairedDevices.id),
  expoToken: text("expo_token").notNull(),
  /** Per-kind toggles as JSON (`PushPrefs`). */
  prefs: text("prefs").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Engine-event freshness watermark (#161): the highest `engine.event` seq
 * the relay has seen per engine session. A host replay after a restart
 * re-sends old events at/under this mark → no re-push. Persisted — an
 * in-memory mark would let a relay restart re-notify.
 */
export const engineEventMarks = sqliteTable("engine_event_marks", {
  sessionId: text("session_id").primaryKey(),
  lastSeq: integer("last_seq").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
