import type { Database } from "bun:sqlite";

/**
 * Versioned DDL applied at startup (`PRAGMA user_version` tracks position).
 * Runs against bun:sqlite in the entry point; the statements themselves are
 * plain SQL so a later driver swap reuses them verbatim.
 */
const MIGRATIONS: { version: number; statements: string[] }[] = [
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
