import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createDrizzleStore } from "../src/db/drizzle-store";
import { applyMigrations, MIGRATIONS } from "../src/db/migrate";
import * as schema from "../src/db/schema";

/**
 * #138 fixture: the real SQLite store + FTS index, run under bun:sqlite from
 * message-search.test.ts (vitest is Node — no driver there). Prints one JSON
 * result object per scenario line so the test asserts without log parsing.
 */

const out = (step: string, data: unknown) =>
  console.log(JSON.stringify({ step, data }));

const sqlite = new Database(":memory:");
const store = createDrizzleStore(drizzle(sqlite, { schema }));

// Land on every migration except #138's FTS one (v9), seed pre-index rows
// through today's store, then run v9's own statements — proves the backfill
// picks up messages written before the index existed. (Later migrations such
// as #137's title_source must be in place first: the store writes them.)
const FTS_VERSION = 9;
for (const m of MIGRATIONS.filter((m) => m.version !== FTS_VERSION)) {
  for (const s of m.statements) sqlite.exec(s);
}
const employee = await store.createEmployee({
  name: "Ada",
  role: "eng",
  status: "online",
  profile: "default",
  model: "",
  now: "",
  instructions: "",
  respondTo: "me",
});
const { channel } = await store.openDmChannel(employee.id);
const { conversation } = await store.openConversation({
  channelId: channel.id,
  title: "session alpha",
  text: "please look at the rate limit errors",
  authorId: "user",
});
const { message: reply } = await store.appendMessage({
  channelId: channel.id,
  conversationId: conversation.id,
  authorId: employee.id,
  authorKind: "employee",
  text: "the rate limit was hit twice during ingest",
});
const { conversation: archived } = await store.openConversation({
  channelId: channel.id,
  title: "session beta",
  text: "unrelated root",
  authorId: "user",
});
await store.appendMessage({
  channelId: channel.id,
  conversationId: archived.id,
  authorId: employee.id,
  authorKind: "employee",
  text: "rate limit inside the archived session",
});
await store.updateConversation(archived.id, { archived: true });
// A second channel + employee prove channelId scoping.
const other = await store.createEmployee({
  name: "Bob",
  role: "ops",
  status: "online",
  profile: "default",
  model: "",
  now: "",
  instructions: "",
  respondTo: "me",
});
const { channel: otherChannel } = await store.openDmChannel(other.id);
await store.appendMessage({
  channelId: otherChannel.id,
  authorId: "user",
  authorKind: "user",
  text: "rate limit on the other channel",
});

const fts = MIGRATIONS.find((m) => m.version === FTS_VERSION);
if (!fts) throw new Error("FTS migration missing");
for (const s of fts.statements) sqlite.exec(s);
sqlite.exec(
  `PRAGMA user_version = ${Math.max(...MIGRATIONS.map((m) => m.version))}`,
);
applyMigrations(sqlite); // no-op now: the schema is at the latest version
out("version", sqlite.query("PRAGMA user_version").get());

const search = (params: {
  query: string;
  channelId?: string;
  includeArchived?: boolean;
  limit?: number;
}) =>
  store.searchMessages({
    query: params.query,
    channelId: params.channelId,
    includeArchived: params.includeArchived ?? false,
    limit: params.limit ?? 50,
  });

// AC-1 backfill: the rows written at v8 are searchable right after v9.
const backfill = await search({ query: "rate limit", includeArchived: true });
out("backfill", backfill);

// Trigger: a write after v9 lands in the index immediately.
const { message: postMigration } = await store.appendMessage({
  channelId: channel.id,
  conversationId: conversation.id,
  authorId: "user",
  authorKind: "user",
  text: "rate limit again after the migration",
});
out("insert-trigger", await search({ query: "after the migration" }));

// Trigger: a text update re-indexes (old term gone, new term hits).
sqlite.exec(
  `UPDATE messages SET text = 'renamed to quota reached' WHERE id = '${postMigration.id}'`,
);
out("update-old-term", await search({ query: "after the migration" }));
out("update-new-term", await search({ query: "quota" }));

// Scoping + archived flag.
out(
  "channel-scope",
  await search({ query: "rate limit", channelId: otherChannel.id }),
);
out("archived-excluded", await search({ query: "rate limit" }));
out(
  "archived-included",
  await search({ query: "archived", includeArchived: true }),
);

// FTS syntax in the input is data, never an error.
out("syntax-safe", await search({ query: 'rate" OR "x' }));

// AC-2: a match buried at the end of a long message still produces a marked
// snippet — the excerpt opens a few tokens before it with a leading ….
await store.appendMessage({
  channelId: otherChannel.id,
  authorId: "user",
  authorKind: "user",
  text: `${"routine status note ".repeat(40)}needle lands at the tail`,
});
out(
  "deep-snippet",
  (await search({ query: "needle" })).map((h) => h.snippet),
);

// AC-4 second half: removing the employee deletes its messages — the index
// follows via the delete trigger.
await store.removeEmployee(employee.id);
out(
  "removed-employee",
  await search({ query: "rate limit", includeArchived: true }),
);

// Rebuild a clean DB for the perf leg: 100k rows, one needle.
const perfDb = new Database(":memory:");
applyMigrations(perfDb);
const perfStore = createDrizzleStore(drizzle(perfDb, { schema }));
perfDb.exec(
  `INSERT INTO channels (id, kind, employee_id, last_seq, created_at)
   VALUES ('ch-perf', 'dm', 'emp-perf', 0, 0)`,
);
const stmt = perfDb.prepare(
  `INSERT INTO messages (id, channel_id, author_id, author_kind, text, seq, created_at)
   VALUES (?, 'ch-perf', 'user', 'user', ?, ?, 0)`,
);
const seed = perfDb.transaction((n: number) => {
  for (let i = 0; i < n; i++) {
    stmt.run(
      `m${i}`,
      i === 50_000
        ? "the needle phrase lives in this exact message"
        : `filler message ${i} about everyday work`,
      i,
    );
  }
});
const t0 = performance.now();
seed(100_000);
const seededMs = performance.now() - t0;
const q0 = performance.now();
const hits = await perfStore.searchMessages({
  query: "needle phrase",
  includeArchived: false,
  limit: 50,
});
const queryMs = performance.now() - q0;
out("perf", { seededMs, queryMs, hits: hits.length, id: hits[0]?.messageId });
