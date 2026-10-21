/** #563 on the REAL (drizzle/sqlite) store: `recordConversationFinish`
    stamps a seq strictly past every mark the relay has seen —
    max(channel.lastSeq, readSeq) + 1 — and `markConversationRead` lifts
    `readSeq` to max(channel.lastSeq, finishedSeq), so
    `finishedSeq > readSeq` is the client's "finished, not seen yet" dot.
    The stamp must exceed what a markRead could already have covered.
    A finish on a channel quiet since the last read has to dot too, and
    a reply posted before the engine event (#814) is already in lastSeq
    so +1 still sits past it. The (sessionId, eventSeq) fence keeps a
    replayed finish from the same
    session from re-stamping; a rebound session writes freely. Runs under
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
const finish = (sessionId: string, eventSeq: number) =>
  s.recordConversationFinish({ conversationId: conv.id, sessionId, eventSeq });
console.log("fresh:", JSON.stringify(await state()));

/* A turn end dots the unopened thread. */
await post("turn one done");
await finish("s-live", 10);
console.log("finished:", JSON.stringify(await state()));

/* Opening the thread clears the dot. */
console.log(
  "marked:",
  JSON.stringify((await s.markConversationRead(conv.id))?.readSeq),
);
console.log("cleared:", JSON.stringify(await state()));

/* A finish on a channel quiet since the read — no new message, lastSeq
   already covered — still dots: the stamp lands past the watermark, not
   at the (unchanged) channel seq. */
await finish("s-live", 11);
console.log("quiet-finish:", JSON.stringify(await state()));

/* A stale replay from the same session (older event seq) can't re-stamp:
   it changes nothing the newer finish already recorded. */
await finish("s-live", 9);
console.log("after-stale:", JSON.stringify(await state()));

/* Reading again clears that quiet-finish dot — readSeq lifts to
   finishedSeq even though the channel never moved. */
console.log(
  "marked2:",
  JSON.stringify((await s.markConversationRead(conv.id))?.readSeq),
);
console.log("cleared2:", JSON.stringify(await state()));

/* A rebound session's first finish writes freely (event seqs restart per
   session). */
await post("rebound turn done");
await finish("s-fresh", 2);
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
    /* The stamp lands strictly past the channel's lastSeq — it must out-
       live a markRead that only reads lastSeq. */
    const stamped = (lines.finished as { finishedSeq: number }).finishedSeq;
    expect(stamped).toBeGreaterThan(0);
    expect((lines.finished as { dot: boolean }).dot).toBe(true);
    expect(lines.cleared).toEqual({
      readSeq: lines.marked,
      finishedSeq: stamped,
      dot: false,
    });
    expect((lines.marked as number) >= stamped).toBe(true);
    /* The quiet-channel finish (nothing posted between read and finish)
       still dots — the stamp moved past readSeq, not just lastSeq. */
    expect(lines["quiet-finish"]).toEqual({
      readSeq: lines.marked,
      finishedSeq: stamped + 1,
      dot: true,
    });
    /* The stale replay changed nothing. */
    expect(lines["after-stale"]).toEqual(lines["quiet-finish"]);
    /* markRead lifts readSeq to finishedSeq on an unmoved channel. */
    expect(lines.marked2).toBe(stamped + 1);
    expect(lines.cleared2).toEqual({
      readSeq: stamped + 1,
      finishedSeq: stamped + 1,
      dot: false,
    });
    expect((lines.rebound as { dot: boolean }).dot).toBe(true);
    expect(lines.reopened).toEqual({
      readSeq: (lines.cleared2 as { readSeq: number }).readSeq,
      finishedSeq: (lines.rebound as { finishedSeq: number }).finishedSeq,
    });
    expect(lines.missing).toBeNull();
  });
});
