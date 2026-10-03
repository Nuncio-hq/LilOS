/** #300 on the REAL (drizzle/sqlite) store: `recordTurnUsage` persists the
    last turn.completed's usage + contextWindow on the conversation row so the
    context meter renders even when the engine session is gone (legacy
    engineRefs, dead sessions, cold starts). The (sessionId, seq) fence keeps
    a replayed older turn from regressing the stored numbers. Runs under
    bun:sqlite via a subprocess (vitest itself is Node). */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUN = process.env.LILOS_BUN_BIN ?? "bun";
const homes: string[] = [];

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

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

const usage = { input: 12000, output: 3400, reasoning: 200, cache: 5000, context: 15400, contextWindow: 200000 };
await s.recordTurnUsage({
  conversationId: conv.id, sessionId: "s-live", seq: 12, usage,
});
console.log("wrote:", JSON.stringify((await s.getConversation(conv.id))?.usage));

/* Stale replay from the same session: seq <= the stored mark can't regress. */
await s.recordTurnUsage({
  conversationId: conv.id, sessionId: "s-live", seq: 9,
  usage: { input: 100, output: 10, reasoning: 0, cache: 0 },
});
console.log("after-stale:", JSON.stringify((await s.getConversation(conv.id))?.usage?.input));

/* A rebound session's first turn replaces the row (seq restarts per session). */
await s.recordTurnUsage({
  conversationId: conv.id, sessionId: "s-fresh", seq: 4,
  usage: { input: 2000, output: 300, reasoning: 0, cache: 0 },
});
console.log("after-rebind:", JSON.stringify((await s.getConversation(conv.id))?.usage?.input));

/* Fresh store on the same file — the meter survives a relay restart. */
const s2 = open();
const row = await s2.getConversation(conv.id);
console.log("reopened:", JSON.stringify(row?.usage));
console.log("no-leak:", JSON.stringify({ sessionId: row?.usageSessionId, seq: row?.usageSeq }));
`;

describe("conversation usage persistence on the real store (#300)", () => {
  it("keeps the last turn's usage across restarts; a stale seq can't regress it", () => {
    const home = mkdtempSync(join(tmpdir(), "lilos-relay-300-"));
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
    expect(lines.wrote).toEqual({
      input: 12000,
      output: 3400,
      reasoning: 200,
      cache: 5000,
      context: 15400,
      contextWindow: 200000,
    });
    expect(lines["after-stale"]).toBe(12000);
    expect(lines["after-rebind"]).toBe(2000);
    expect(lines.reopened).toEqual({
      input: 2000,
      output: 300,
      reasoning: 0,
      cache: 0,
    });
    /* The freshness fence is store-internal — it must not leak onto the
       domain object clients deserialize. */
    expect(lines["no-leak"]).toEqual({});
  });
});
