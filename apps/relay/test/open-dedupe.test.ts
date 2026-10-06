/** #552 AC-3 on the REAL (drizzle/sqlite) store: `openConversation` dedupes
    on the messages table's (channel_id, dedupe_key) unique index — the
    wire tests run the memory store, this proves the production store's
    retry path returns the stored thread (and that open keys share the
    posts' dedupe slot). Runs under bun:sqlite via a subprocess (vitest
    itself is Node). */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BUN, RELAY_DIR } from "./helpers";

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
  name: "T", role: "eng", status: "online", profile: "default",
  model: "", now: "", instructions: "", respondTo: "me",
});
const { channel } = await s.openDmChannel(emp.id);

const first = await s.openConversation({
  channelId: channel.id, title: "", text: "weak-network send",
  authorId: "u", dedupeKey: "u-1",
});
console.log("first:", JSON.stringify({
  created: first.created, conv: first.conversation.id, root: first.rootMessage.id,
}));

/* The stored-but-unanswered resend: same key, same rows back. */
const retry = await s.openConversation({
  channelId: channel.id, title: "", text: "weak-network send",
  authorId: "u", dedupeKey: "u-1",
});
console.log("retry:", JSON.stringify({
  created: retry.created, conv: retry.conversation.id, root: retry.rootMessage.id,
}));

/* One (channel, key) namespace: the open's key marks its root message,
   so a messages.post retry that reuses it also dedupes. */
const post = await s.appendMessage({
  channelId: channel.id, conversationId: first.conversation.id,
  authorId: "u", authorKind: "user", text: "same key", dedupeKey: "u-1",
});
console.log("post:", JSON.stringify({ created: post.created, msg: post.message.id }));

/* A fresh key is a fresh thread. */
const next = await s.openConversation({
  channelId: channel.id, title: "", text: "new send", authorId: "u",
  dedupeKey: "u-2",
});
console.log("next:", JSON.stringify({ created: next.created, conv: next.conversation.id }));
`;

describe("conversations.open dedupe on the real store (#552)", () => {
  it("AC-3 a resent open returns the stored conversation + root message", () => {
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
    expect(lines.first.created).toBe(true);
    expect(lines.retry).toEqual({
      created: false,
      conv: lines.first.conv,
      root: lines.first.root,
    });
    expect(lines.post).toEqual({ created: false, msg: lines.first.root });
    expect(lines.next.created).toBe(true);
    expect(lines.next.conv).not.toBe(lines.first.conv);
  });
});
