/** #563 on the REAL (drizzle/sqlite) store: `recordConversationFinish`
    stamps the channel's seq at the turn's end (`finishedSeq`) and
    `markConversationRead` lifts `readSeq` to the channel's `lastSeq`, so
    `finishedSeq > readSeq` is the client's "finished, not seen yet" dot —
    no stored boolean to desync. The (sessionId, eventSeq) fence keeps a
    replayed finish from the same session from re-stamping an older turn
    end at a newer channel seq; a rebound session writes freely. Runs under
    bun:sqlite via a subprocess (vitest itself is Node). */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUN, homes, RELAY_DIR } from "./helpers";

const SCRIPT = (dbPath: string) => `
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createDrizzleStore } from "./src/db/drizzle-store.ts";
import { applyMigrations } from "./src/db/migrate.ts";
import * as schema from "./src/db/schema.ts";

const open = () => {
  const db = new Database(${JSON.stringify(dbPath)});
  applyMigrations(db);
  return createDrizzleStore(drizzle(db, { schema }));
};
const s = open();
const emp = await s.createEmployee({
  name: "T", role: "eng", status: "online", profile: "default",
  model: "", now: "", instructions: "", respondTo: "me",
});
const { channel } = await s.openDmChannel(emp.id);
const { conversation: conv } = await s.openConversation({
  channelId: channel.id, title: "", text: "first", authorId: "u",
});
const post = async (text: string) =>
  (await s.appendMessage({
    channelId: channel.id, conversationId: conv.id,
    authorId: "u", authorKind: "user", text,
  })).message;
const state = async () => {
  const c = await s.getConversation(conv.id);
  return { readSeq: c?.readSeq, finishedSeq: c?.finishedSeq, dot: (c?.finishedSeq ?? 0) > (c?.readSeq ?? 0) };
};
const finish = (sessionId: string, eventSeq: number, channelSeq: number) =>
  s.recordConversationFinish({
    conversationId: conv.id, sessionId, eventSeq, channelSeq,
  });
console.log("fresh:", JSON.stringify(await state()));

/* A turn end at the channel's current lastSeq dots the unopened thread. */
const m1 = await post("turn one done");
await finish("s-live", 10, m1.seq);
console.log("finished:", JSON.stringify(await state()));

/* Opening the thread marks it read at the channel's current lastSeq. */
console.log(
  "marked:",
  JSON.stringify((await s.markConversationRead(conv.id))?.readSeq),
);
console.log("cleared:", JSON.stringify(await state()));

/* A stale replay from the same session (older event seq, newer channel
   seq) can't re-stamp: the dot stays cleared once read. */
const m2 = await post("turn two done");
await finish("s-live", 9, m2.seq);
console.log("after-stale:", JSON.stringify(await state()));

/* A newer finish from the same session moves the stamp forward — a second
   turn ended after the thread was read, so the dot comes back. */
await finish("s-live", 11, m2.seq);
console.log("refinished:", JSON.stringify(await state()));

/* An even newer channel seq for the same turn end is ignored: the stamp
   recorded when the finish first landed stands. */
await finish("s-live", 11, m2.seq + 99);
console.log("same-finish-later-seq:", JSON.stringify(await state()));

/* A rebound session's first finish writes at whatever channel seq it sees
   (event seqs restart per session). */
const m3 = await post("rebound turn done");
await finish("s-fresh", 2, m3.seq);
console.log("rebound:", JSON.stringify(await state()));

/* Fresh store on the same file — the watermark survives a relay restart. */
const s2 = open();
const row = await s2.getConversation(conv.id);
console.log("reopened:", JSON.stringify({ readSeq: row?.readSeq, finishedSeq: row?.finishedSeq }));

/* markConversationRead on an unknown conversation is a clean null (the
   wire layer maps it to notFound). */
console.log("missing:", JSON.stringify(await s.markConversationRead("nope")));
`;

describe("conversation read watermark on the real store (#563)", () => {
  it("finish stamps the dot, markRead clears it, the fence and restart hold", () => {
    const home = mkdtempSync(join(tmpdir(), "lilos-relay-563-"));
    homes.push(home);
    const out = spawnSync(BUN, ["-e", SCRIPT(join(home, "relay.db"))], {
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
    expect(lines.fresh).toEqual({ readSeq: 0, finishedSeq: 0, dot: false });
    expect(lines.finished).toEqual({
      readSeq: 0,
      finishedSeq: lines.marked,
      dot: true,
    });
    expect(lines.cleared).toEqual({
      readSeq: lines.marked,
      finishedSeq: lines.marked,
      dot: false,
    });
    expect(lines["after-stale"]).toEqual({
      readSeq: lines.marked,
      finishedSeq: lines.marked,
      dot: false,
    });
    expect((lines.refinished as { finishedSeq: number }).finishedSeq).toBe(
      (lines["after-stale"] as { readSeq: number }).readSeq + 1,
    );
    expect((lines.refinished as { dot: boolean }).dot).toBe(true);
    /* The newer channel seq for the same turn end was ignored. */
    expect(lines["same-finish-later-seq"]).toEqual(lines.refinished);
    expect((lines.rebound as { dot: boolean }).dot).toBe(true);
    expect(lines.reopened).toEqual({
      readSeq: (lines.cleared as { readSeq: number }).readSeq,
      finishedSeq: (lines.rebound as { finishedSeq: number }).finishedSeq,
    });
    expect(lines.missing).toBeNull();
  });
});
