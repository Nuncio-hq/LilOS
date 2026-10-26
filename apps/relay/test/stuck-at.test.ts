/** Issue #775: stuckAt is set when stuck goes unset → set, kept when the
    mark clears, and overwritten by a later episode. The memory store runs
    in vitest; the SQL null and the summary's raw-SQL column show on the
    real store via bun:sqlite (vitest itself is Node). */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BUN, RELAY_DIR } from "./helpers";
import { createMemoryStore } from "./memory-store";

const REASON = "Same web search 6 times";

async function openThread() {
  const store = createMemoryStore();
  const emp = await store.createEmployee({
    name: "Ada",
    role: "eng",
    status: "online",
    profile: "default",
    model: "",
    now: "",
    instructions: "",
    respondTo: "me",
  });
  const { channel } = await store.openDmChannel(emp.id);
  const { conversation } = await store.openConversation({
    channelId: channel.id,
    title: "",
    text: "first message for the thread",
    authorId: "u",
  });
  return { store, id: conversation.id };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("stuckAt on the memory store (issue #775)", () => {
  it("marks, keeps the stamp across a clear, and overwrites it next time", async () => {
    const { store, id } = await openThread();
    const marked = await store.updateConversation(id, {
      stuck: { reason: REASON },
    });
    expect(marked?.stuck).toEqual({ reason: REASON });
    expect(marked?.stuckAt).toBeGreaterThan(0);
    const first = marked?.stuckAt ?? 0;

    /* A rewrite while the mark is still set is not a new episode. */
    const rewrite = await store.updateConversation(id, {
      stuck: { reason: REASON },
    });
    expect(rewrite?.stuckAt).toBe(first);

    const cleared = await store.updateConversation(id, { stuck: null });
    expect(cleared?.stuck).toBeUndefined();
    expect(cleared?.stuckAt).toBe(first);

    await sleep(5);
    const again = await store.updateConversation(id, {
      stuck: { reason: "No new step for 20 minutes" },
    });
    expect(again?.stuckAt).toBeGreaterThan(first);
  });
});

const SCRIPT = `
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createDrizzleStore } from "./src/db/drizzle-store.ts";
import { applyMigrations } from "./src/db/migrate.ts";
import * as schema from "./src/db/schema.ts";

const db = new Database(":memory:");
applyMigrations(db);
const s = createDrizzleStore(drizzle(db, { schema }));
const emp = await s.createEmployee({
  name: "Ada", role: "eng", status: "online", profile: "default",
  model: "", now: "", instructions: "", respondTo: "me",
});
const { channel } = await s.openDmChannel(emp.id);
const { conversation } = await s.openConversation({
  channelId: channel.id, title: "", text: "first message for the thread",
  authorId: "u",
});
const marked = await s.updateConversation(conversation.id, {
  stuck: { reason: ${JSON.stringify(REASON)} },
});
const rewrite = await s.updateConversation(conversation.id, {
  stuck: { reason: ${JSON.stringify(REASON)} },
});
const cleared = await s.updateConversation(conversation.id, { stuck: null });
await Bun.sleep(5);
const again = await s.updateConversation(conversation.id, {
  stuck: { reason: "No new step for 20 minutes" },
});
const listed = await s.listConversations({});
const summaries = await s.listConversationSummaries({ includeArchived: true });
const summary = summaries.find((row) => row.conversation.id === conversation.id);
console.log(JSON.stringify({
  version: db.query("PRAGMA user_version").get().user_version,
  marked: marked?.stuckAt ?? null,
  markedStuck: marked?.stuck ?? null,
  rewrite: rewrite?.stuckAt ?? null,
  cleared: cleared?.stuckAt ?? null,
  clearedStuck: cleared?.stuck ?? null,
  again: again?.stuckAt ?? null,
  listed: listed.find((row) => row.id === conversation.id)?.stuckAt ?? null,
  summary: summary?.conversation.stuckAt ?? null,
}));
`;

describe("stuckAt on the real store (issue #775)", () => {
  it("marks, keeps the stamp across a clear, and overwrites it next time", () => {
    const run = spawnSync(BUN, ["-e", SCRIPT], {
      cwd: RELAY_DIR,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null") as {
      version: number;
      marked: number | null;
      markedStuck: { reason: string } | null;
      rewrite: number | null;
      cleared: number | null;
      clearedStuck: { reason: string } | null;
      again: number | null;
      listed: number | null;
      summary: number | null;
    };
    expect(out.version).toBe(38);
    expect(out.markedStuck).toEqual({ reason: REASON });
    expect(out.marked).toBeGreaterThan(0);
    expect(out.rewrite).toBe(out.marked);
    expect(out.clearedStuck).toBeNull();
    expect(out.cleared).toBe(out.marked);
    expect(out.again).toBeGreaterThan(out.marked ?? 0);
    expect(out.listed).toBe(out.again);
    expect(out.summary).toBe(out.again);
  });
});
