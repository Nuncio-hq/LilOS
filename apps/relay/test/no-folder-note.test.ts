/** #196 AC-1: the retired "No folder: working in …" note (#113 AC-6,
    superseded) is dropped on read — `sys:<conv>:no-folder`-keyed rows never
    come back through messages.list, conversations.summaries, or
    messages.search. The memory store is exercised in-process; the drizzle
    store via a bun:sqlite subprocess (vitest itself is Node). */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./memory-store";

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUN = process.env.LILOS_BUN_BIN ?? "bun";

async function seedConversation(store: ReturnType<typeof createMemoryStore>) {
  const employee = await store.createEmployee({
    name: "Ada",
    role: "eng",
    status: "online",
    profile: "builder",
    model: "",
    now: "",
    instructions: "",
    respondTo: "me",
  });
  const { channel } = await store.openDmChannel(employee.id);
  const { conversation } = await store.openConversation({
    channelId: channel.id,
    title: "",
    text: "please help with the deploy",
    authorId: "u",
  });
  return { channel, conversation };
}

const seedNote = (
  store: ReturnType<typeof createMemoryStore>,
  channelId: string,
  conversationId: string,
) =>
  store.appendMessage({
    channelId,
    conversationId,
    authorId: "",
    authorKind: "system",
    text: "No folder: working in /tmp/lilos/harness/work",
    dedupeKey: `sys:${conversationId}:no-folder`,
  });

describe("no-folder note dropped on read (memory store)", () => {
  it("AC-1 listMessages, summaries and search never return the note", async () => {
    const store = createMemoryStore();
    const { channel, conversation } = await seedConversation(store);
    await seedNote(store, channel.id, conversation.id);
    await store.appendMessage({
      channelId: channel.id,
      conversationId: conversation.id,
      authorId: "ada",
      authorKind: "employee",
      text: "Deploy finished cleanly",
    });

    const page = await store.listMessages(channel.id, {
      conversationId: conversation.id,
    });
    expect(page.messages.some((m) => m.text.startsWith("No folder:"))).toBe(
      false,
    );
    // Channel-wide reads (snapshot window) drop it too.
    const channelPage = await store.listMessages(channel.id, {});
    expect(
      channelPage.messages.some((m) => m.text.startsWith("No folder:")),
    ).toBe(false);

    const summaries = await store.listConversationSummaries({
      channelId: channel.id,
      includeArchived: false,
    });
    const summary = summaries.find(
      (s) => s.conversation.id === conversation.id,
    );
    expect(summary).toBeDefined();
    // Root + employee answer — the note does not count or surface anywhere.
    expect(summary?.messageCount).toBe(2);
    expect(summary?.firstAnswer?.text).toBe("Deploy finished cleanly");
    expect(summary?.last.text).toBe("Deploy finished cleanly");

    const hits = await store.searchMessages({
      query: "No folder",
      includeArchived: false,
      limit: 50,
    });
    expect(hits.length).toBe(0);
    // Searching real text still finds the note's neighbors.
    const neighborHits = await store.searchMessages({
      query: "deploy",
      includeArchived: false,
      limit: 50,
    });
    expect(neighborHits.length).toBeGreaterThan(0);
  });

  it("AC-1 a retry of the same dedupe key stays hidden", async () => {
    const store = createMemoryStore();
    const { channel, conversation } = await seedConversation(store);
    const first = await seedNote(store, channel.id, conversation.id);
    const retry = await seedNote(store, channel.id, conversation.id);
    expect(retry.created).toBe(false);
    expect(retry.message.id).toBe(first.message.id);
    const page = await store.listMessages(channel.id, {
      conversationId: conversation.id,
    });
    expect(page.messages.some((m) => m.text.startsWith("No folder:"))).toBe(
      false,
    );
  });
});

/** Same assertions on the real SQLite store — the suppression must live in
    the SQL, not the app layer. Prints key:JSON lines like title-drizzle. */
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
  name: "Ada", role: "eng", status: "online", profile: "builder",
  model: "", now: "", instructions: "", respondTo: "me",
});
const { channel } = await s.openDmChannel(emp.id);
const { conversation: conv } = await s.openConversation({
  channelId: channel.id, title: "", text: "please help with the deploy",
  authorId: "u",
});
await s.appendMessage({
  channelId: channel.id, conversationId: conv.id, authorId: "",
  authorKind: "system", text: "No folder: working in /tmp/lilos/harness/work",
  dedupeKey: "sys:" + conv.id + ":no-folder",
});
await s.appendMessage({
  channelId: channel.id, conversationId: conv.id, authorId: "ada",
  authorKind: "employee", text: "Deploy finished cleanly",
});

const page = await s.listMessages(channel.id, { conversationId: conv.id });
console.log("list:", JSON.stringify({
  anyNote: page.messages.some((m) => m.text.startsWith("No folder:")),
  count: page.messages.length,
}));
const summaries = await s.listConversationSummaries({
  channelId: channel.id, includeArchived: false,
});
const summary = summaries.find((x) => x.conversation.id === conv.id);
console.log("summary:", JSON.stringify({
  messageCount: summary?.messageCount,
  firstAnswer: summary?.firstAnswer?.text ?? null,
  last: summary?.last?.text ?? null,
}));
const hits = await s.searchMessages({
  query: "No folder", includeArchived: false, limit: 50,
});
console.log("search:", JSON.stringify({ hits: hits.length }));
const neighbors = await s.searchMessages({
  query: "deploy", includeArchived: false, limit: 50,
});
console.log("neighbors:", JSON.stringify({ hits: neighbors.length }));
`;

describe("no-folder note dropped on read (drizzle store)", () => {
  it("AC-1 listMessages, summaries and search never return the note", () => {
    const out = spawnSync(BUN, ["-e", SCRIPT], {
      cwd: RELAY_DIR,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(out.status, out.stderr).toBe(0);
    const lines = Object.fromEntries(
      out.stdout
        .trim()
        .split("\n")
        .map((l) => {
          const i = l.indexOf(":");
          return [l.slice(0, i), JSON.parse(l.slice(i + 1))];
        }),
    );
    expect(lines.list.anyNote).toBe(false);
    expect(lines.list.count).toBe(2);
    expect(lines.summary.messageCount).toBe(2);
    expect(lines.summary.firstAnswer).toBe("Deploy finished cleanly");
    expect(lines.summary.last).toBe("Deploy finished cleanly");
    expect(lines.search.hits).toBe(0);
    expect(lines.neighbors.hits).toBeGreaterThan(0);
  });
});
