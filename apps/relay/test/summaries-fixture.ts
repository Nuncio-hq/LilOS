import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createDrizzleStore } from "../src/db/drizzle-store";
import {
  applyMigrations,
  backupBeforeMigrations,
  MIGRATIONS,
} from "../src/db/migrate";
import * as schema from "../src/db/schema";

/**
 * #571 fixture (AC-1/AC-2): a file-backed DB left at v20 — the pre-issue
 * schema — seeded to the audit's scale, then backed up and migrated to v21
 * before the perf legs run. Prints one JSON {step, data} line per check so
 * summaries-perf.test.ts asserts without log parsing (vitest is Node — no
 * sqlite driver there; the message-search.ts fixture pattern).
 */

const out = (step: string, data: unknown) =>
  console.log(JSON.stringify({ step, data }));

const dir = mkdtempSync(join(tmpdir(), "lilos-571-"));
const dbPath = join(dir, "relay.db");
const sqlite = new Database(dbPath);

/* Replay shipped history only up to v20 — the migration under test is v21
   (#571's index swap). The seed inserts use only columns v20 already has. */
const PRE = 20;
for (const m of MIGRATIONS.filter((m) => m.version <= PRE)) {
  for (const s of m.statements) sqlite.exec(s);
  sqlite.exec(`PRAGMA user_version = ${m.version}`);
}
out("version-before", sqlite.query("PRAGMA user_version").get());

/* The audit shape: 1,658 sessions in one DM channel, each a root plus ~11
   turns of ~500-char bodies (the size that made the old per-message read
   pay full text for every row). */
const CONVS = 1658;
const MSGS_PER_CONV = 12;
const seed0 = performance.now();
sqlite.exec(
  `INSERT INTO employees (id, name, role, status, profile, model, now, instructions, respond_to, created_at)
   VALUES ('emp-1', 'Ada', 'eng', 'online', 'default', '', '', '', 'me', 0),
          ('emp-2', 'Bob', 'ops', 'online', 'default', '', '', '', 'me', 0)`,
);
const insChannel = sqlite.prepare(
  `INSERT INTO channels (id, kind, employee_id, last_seq, created_at)
   VALUES (?, 'dm', ?, 0, 0)`,
);
insChannel.run("ch-1", "emp-1");
insChannel.run("ch-big", "emp-2");
const insConv = sqlite.prepare(
  `INSERT INTO conversations (id, channel_id, root_message_id, state, title, created_at)
   VALUES (?, ?, ?, 'idle', ?, ?)`,
);
const insMsg = sqlite.prepare(
  `INSERT INTO messages (id, channel_id, conversation_id, author_id, author_kind, text, seq, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const body = "x".repeat(500);
sqlite.transaction(() => {
  let seq = 1;
  for (let i = 0; i < CONVS; i++) {
    const cid = `conv-${i}`;
    insConv.run(cid, "ch-1", `root-${i}`, `session ${i}`, i);
    insMsg.run(
      `root-${i}`,
      "ch-1",
      cid,
      "me",
      "user",
      `please look at ${i} ${body}`,
      seq++,
      i,
    );
    for (let j = 1; j < MSGS_PER_CONV; j++) {
      insMsg.run(
        `m-${i}-${j}`,
        "ch-1",
        cid,
        "emp-1",
        "employee",
        `reply ${j} ${body}`,
        seq++,
        i,
      );
    }
  }
})();

/* AC-1's second leg: 100k messages in one channel where the read target is
   a sparse 12-message thread — the composite (conversation_id, seq) index
   is what turns this from a full channel scan into 12 seeks. */
const BIG = 100_000;
const SPARSE_CONV = "conv-sparse";
insConv.run(SPARSE_CONV, "ch-big", "root-sparse", "sparse", 1);
const insBig = sqlite.prepare(
  `INSERT INTO messages (id, channel_id, conversation_id, author_id, author_kind, text, seq, created_at)
   VALUES (?, 'ch-big', ?, ?, ?, ?, ?, 0)`,
);
sqlite.transaction(() => {
  let s = 0;
  for (let i = 0; i < BIG; i++) {
    const sparse = s < 12 && i % 8192 === 0;
    insBig.run(
      `b-${i}`,
      sparse ? SPARSE_CONV : "conv-bulk",
      sparse ? "me" : "emp-1",
      sparse ? "user" : "employee",
      sparse ? `sparse turn ${s++}` : `bulk ${i}`,
      i + 1,
    );
  }
  insBig.run("root-sparse", SPARSE_CONV, "me", "user", "sparse root", BIG + 1);
})();
const seededMs = performance.now() - seed0;
out("seeded", { seededMs, conversations: CONVS + 1 });

/* AC-2: the pre-migration backup lands as <path>.v20.bak with the data —
   the undo path if v21 misbehaves on a real install. */
const bak = backupBeforeMigrations(sqlite, dbPath);
const bakInfo = bak
  ? (() => {
      const b = new Database(bak);
      const v = b.query("PRAGMA user_version").get() as {
        user_version: number;
      };
      const n = (
        b.query("SELECT count(*) AS n FROM conversations").get() as {
          n: number;
        }
      ).n;
      b.close();
      return { path: bak, version: v.user_version, conversations: n };
    })()
  : null;
out("backup", bakInfo);

applyMigrations(sqlite);
out("version-after", sqlite.query("PRAGMA user_version").get());
out(
  "indexes",
  (
    sqlite
      .query(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'",
      )
      .all() as { name: string }[]
  ).map((r) => r.name),
);

const store = createDrizzleStore(drizzle(sqlite, { schema }));

/* AC-1 leg 1: the full summary list at the audit's 1,658-conversation
   scale. CI boxes vary and share CPU, so the reported figure is the
   median of three warm runs — and the test compares it against a
   baseline measured in the SAME process: the pre-#571 shape (one
   per-conversation read materializing every row). */
const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
await store.listConversationSummaries({ includeArchived: true });
const summaryRuns: number[] = [];
let summaries = await store.listConversationSummaries({
  includeArchived: true,
});
for (let i = 0; i < 3; i++) {
  const s0 = performance.now();
  summaries = await store.listConversationSummaries({
    includeArchived: true,
  });
  summaryRuns.push(performance.now() - s0);
}
const convIds = summaries.map((s) => s.conversation.id);
const msgScan = sqlite.prepare(
  "SELECT * FROM messages WHERE conversation_id = ?",
);
const baselineRuns: number[] = [];
for (let i = 0; i < 3; i++) {
  const b0 = performance.now();
  for (const c of convIds) msgScan.all(c);
  baselineRuns.push(performance.now() - b0);
}
const baselineMs = median(baselineRuns);
const frame = JSON.stringify({ summaries });
out("summaries", {
  ms: median(summaryRuns),
  runs: summaryRuns.map((ms) => Math.round(ms * 10) / 10),
  baselineMs,
  rows: summaries.length,
  rawKb: Math.round(frame.length / 1024),
  deflateKb: Math.round(deflateSync(frame).length / 1024),
  firstRootLen: summaries[0]?.root.text.length,
  firstLastLen: summaries[0]?.last.text.length,
  firstCount: summaries[0]?.messageCount,
});

/* AC-1 leg 2: the sparse thread read inside the 100k-message channel.
   The plan assertion is the deterministic half — the composite index is
   what AC-1 actually asks for; the ms bound is only a sanity floor. */
await store.listMessages("ch-big", { conversationId: SPARSE_CONV });
const listRuns: number[] = [];
let page = await store.listMessages("ch-big", {
  conversationId: SPARSE_CONV,
});
for (let i = 0; i < 5; i++) {
  const l0 = performance.now();
  page = await store.listMessages("ch-big", {
    conversationId: SPARSE_CONV,
  });
  listRuns.push(performance.now() - l0);
}
out("list-sparse", { ms: median(listRuns), rows: page.messages.length });
out(
  "sparse-plan",
  sqlite
    .query(
      `EXPLAIN QUERY PLAN
       SELECT * FROM messages
       WHERE channel_id = 'ch-big' AND conversation_id = '${SPARSE_CONV}'
         AND (dedupe_key IS NULL OR dedupe_key NOT LIKE 'sys:%:no-folder')
         AND removed = 0 AND dropped = 0 AND rewound = 0
       ORDER BY seq DESC`,
    )
    .all()
    .map((r) => (r as { detail?: string }).detail ?? JSON.stringify(r)),
);

/* Nothing to undo: no backup for an in-memory handle, a fresh v0 file, or
   a DB already at the latest version. */
const fresh = new Database(join(dir, "fresh.db"));
const mem = new Database(":memory:");
out("backup-skips", {
  memory: backupBeforeMigrations(mem, ":memory:") ?? "none",
  fresh: backupBeforeMigrations(fresh, join(dir, "fresh.db")) ?? "none",
  current: backupBeforeMigrations(sqlite, dbPath) ?? "none",
});
fresh.close();
mem.close();

sqlite.close();
rmSync(dir, { recursive: true, force: true });
