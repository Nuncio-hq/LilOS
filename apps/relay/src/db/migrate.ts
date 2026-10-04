import type { Database } from "bun:sqlite";

/**
 * Versioned DDL applied at startup (`PRAGMA user_version` tracks position).
 * Runs against bun:sqlite in the entry point; the statements themselves are
 * plain SQL so a later driver swap reuses them verbatim.
 */
export const MIGRATIONS: { version: number; statements: string[] }[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'offline',
        profile TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        now TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        respond_to TEXT NOT NULL DEFAULT 'me',
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        employee_id TEXT NOT NULL REFERENCES employees(id),
        last_seq INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS channels_dm_employee
        ON channels(kind, employee_id)`,
      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        conversation_id TEXT REFERENCES conversations(id),
        author_id TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        text TEXT NOT NULL,
        seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS messages_channel_seq
        ON messages(channel_id, seq)`,
      `CREATE INDEX IF NOT EXISTS messages_conversation
        ON messages(conversation_id)`,
      `CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        root_message_id TEXT NOT NULL REFERENCES messages(id),
        engine_ref TEXT,
        state TEXT NOT NULL DEFAULT 'idle',
        title TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS conversations_channel
        ON conversations(channel_id)`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS asks (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        turn_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open',
        outcome TEXT,
        answer TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS asks_conversation_request
        ON asks(conversation_id, request_id)`,
      `CREATE INDEX IF NOT EXISTS asks_channel ON asks(channel_id)`,
    ],
  },
  {
    // #31: display refs on messages; the bytes are stored outside the row.
    version: 3,
    statements: [`ALTER TABLE messages ADD COLUMN attachments TEXT`],
  },
  {
    // issue #30: the pinned model on a conversation, and the answering model
    // stamped on each employee message.
    version: 4,
    statements: [
      `ALTER TABLE conversations ADD COLUMN model TEXT`,
      `ALTER TABLE messages ADD COLUMN model TEXT`,
    ],
  },
  {
    version: 5,
    statements: [
      // #28: exactly-once message writes + the host delivery watermark that
      // decides which user messages a re-registering harness still owes.
      `ALTER TABLE messages ADD COLUMN dedupe_key TEXT`,
      `ALTER TABLE conversations ADD COLUMN delivered_seq INTEGER NOT NULL DEFAULT 0`,
      // Existing rows predate the watermark: assume every user message up to
      // the last non-user message was delivered (mirrors the old "newest is
      // user" pending rule exactly).
      `UPDATE conversations SET delivered_seq = COALESCE((
        SELECT MAX(seq) FROM messages
        WHERE messages.conversation_id = conversations.id
          AND messages.author_kind != 'user'
      ), 0)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS messages_dedupe_key
        ON messages(channel_id, dedupe_key)`,
    ],
  },
  {
    // #113: the folder a session works in lives on the conversation; the
    // picker's recents are LilOS-owned (one shared list, newest first).
    version: 6,
    statements: [
      `ALTER TABLE conversations ADD COLUMN cwd TEXT`,
      `CREATE TABLE IF NOT EXISTS recent_folders (
        path TEXT PRIMARY KEY,
        last_used_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    // #92: the session pick rides conversations (provider/effort/fast), the
    // answering metadata rides messages, and the LilOS-owned settings KV
    // (modelVisibility = the Edit-models hide list) lands as a table.
    // Shipped after #113's v6 — DBs already at 6 still run this one.
    version: 7,
    statements: [
      `ALTER TABLE conversations ADD COLUMN provider TEXT`,
      `ALTER TABLE conversations ADD COLUMN effort TEXT`,
      `ALTER TABLE conversations ADD COLUMN fast INTEGER`,
      `ALTER TABLE messages ADD COLUMN provider TEXT`,
      `ALTER TABLE messages ADD COLUMN effort TEXT`,
      `ALTER TABLE messages ADD COLUMN fast INTEGER`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    ],
  },
  {
    // #118: the signed-in human's profile — one row, NULL columns until set.
    version: 8,
    statements: [
      `CREATE TABLE IF NOT EXISTS profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        user_name TEXT,
        company_name TEXT,
        avatar_color TEXT
      )`,
    ],
  },
  {
    /* #138: full-text search over stored messages. A FTS5 external-content
       index (content='messages' — text is not duplicated) backfilled from
       existing rows and kept in sync by triggers on write/delete/text-edit.
       Deliberately raw SQL, not a Drizzle table: drizzle can't model virtual
       tables, and the schema test asserts the exact persisted table list. */
    version: 9,
    statements: [
      `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text, content='messages', content_rowid='rowid'
      )`,
      `INSERT INTO messages_fts(rowid, text) SELECT rowid, text FROM messages`,
      `CREATE TRIGGER IF NOT EXISTS messages_fts_insert
        AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
        END`,
      `CREATE TRIGGER IF NOT EXISTS messages_fts_delete
        AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, text)
            VALUES ('delete', old.rowid, old.text);
        END`,
      `CREATE TRIGGER IF NOT EXISTS messages_fts_update
        AFTER UPDATE OF text ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, text)
            VALUES ('delete', old.rowid, old.text);
          INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
        END`,
    ],
  },
  {
    // #137: title provenance — every title that exists was client-chosen
    // before this column, so backfill those as `user`; new opens default to
    // `auto` (placeholder/engine titles the engine may upgrade).
    version: 10,
    statements: [
      `ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto'`,
      `UPDATE conversations SET title_source = 'user' WHERE title != ''`,
    ],
  },
  {
    // #153: phone pairing — one-time grants (hash only) and paired devices
    // (credential hash only; revoked_at closes sockets + blocks hello).
    version: 11,
    statements: [
      `CREATE TABLE IF NOT EXISTS pairing_grants (
        code_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS paired_devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        credential_hash TEXT NOT NULL UNIQUE,
        paired_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER
      )`,
    ],
  },
  {
    /* #134: `conversations.rewind` marks dropped messages (hidden, kept for
       audit) and the harness stamps each user message's pre-turn checkpoint. */
    version: 12,
    statements: [
      `ALTER TABLE messages ADD COLUMN rewound INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE messages ADD COLUMN checkpoint TEXT`,
    ],
  },
  {
    /* #156: workstream opens stamp the pick (`mode` + repoPath + branch/base)
       as JSON — `cwd` then holds the worktree path, `repoPath` the recents
       folder. */
    version: 13,
    statements: [`ALTER TABLE conversations ADD COLUMN workspace TEXT`],
  },
  {
    /* #161: Expo push registrations (token + per-kind prefs per paired
       device) and the per-session engine-event seq watermark that fences
       replayed `engine.event` publishes off the push fan-out. */
    version: 14,
    statements: [
      `CREATE TABLE IF NOT EXISTS device_push (
        device_id TEXT PRIMARY KEY REFERENCES paired_devices(id),
        expo_token TEXT NOT NULL,
        prefs TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS engine_event_marks (
        session_id TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    /* #300: last turn.completed usage (+ contextWindow) on the conversation
       — JSON `Usage` — so the context meter survives replay failure. The
       session/seq pair fences stale replays off the stored numbers. */
    version: 15,
    statements: [
      `ALTER TABLE conversations ADD COLUMN usage TEXT`,
      `ALTER TABLE conversations ADD COLUMN usage_session_id TEXT`,
      `ALTER TABLE conversations ADD COLUMN usage_seq INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    /* #315: `dropped` parks a still-waiting user message in the not-sent
       tray on ■ Stop; `removed` is the tray's Remove — both hidden like
       `rewound`, both excluded from `listPendingTurns` so a restart never
       delivers them to the engine. */
    version: 16,
    statements: [
      `ALTER TABLE messages ADD COLUMN dropped INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE messages ADD COLUMN removed INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    /* #377: `claimed` marks a send whose prompt committed to dispatch — it
       leaves the waiting tray (Remove boundary moves from "delivered" to
       "claimed") but stays owed in `listPendingTurns` until deliveredSeq
       covers it. */
    version: 17,
    statements: [
      `ALTER TABLE messages ADD COLUMN claimed INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    /* #106: the per-conversation access level the composer pill switches —
       `conversations.setAccess` writes it, `conversations.open` stamps the
       Settings default; existing rows keep Ask. */
    version: 18,
    statements: [
      `ALTER TABLE conversations ADD COLUMN access TEXT NOT NULL DEFAULT 'ask'`,
    ],
  },
  {
    /* #346: the engine session's life on the conversation — the host
       writes open/closed (a suspended session is `closed`, reopening on
       the next message); `running` is derived client-side, never stored.
       v18 is #450's conversations.access. */
    version: 19,
    statements: [`ALTER TABLE conversations ADD COLUMN life TEXT`],
  },
];

export function applyMigrations(db: Database): void {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  const current = row.user_version;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    })();
  }
}
