/** #137 AC-2 on the REAL (drizzle/sqlite) store: a host `auto` title write
    over a user-named row folds to an empty patch — the relay must answer
    the current row, not throw `set({})`. The wire tests run the memory
    store, where the same drop is a silent no-op, so this bug only shows
    here. Runs under bun:sqlite via a subprocess (vitest itself is Node). */
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
const { conversation: conv } = await s.openConversation({
  channelId: channel.id, title: "", text: "first message for the thread",
  authorId: "u",
});
console.log("open:", JSON.stringify({ title: conv.title, titleSource: conv.titleSource }));

await s.updateConversation(conv.id, { title: "Typed first", titleSource: "user" });
// The engine's late title patch folds to nothing on a user row — must
// answer the current row, not throw "No values to set".
const late = await s.updateConversation(conv.id, {
  title: "Engine Late Title", titleSource: "auto",
});
console.log("late:", JSON.stringify(late && { title: late.title, titleSource: late.titleSource }));
const row = await s.getConversation(conv.id);
console.log("row:", JSON.stringify(row && { title: row.title, titleSource: row.titleSource }));

// Sanity: an auto write still applies while the row is auto.
const { conversation: conv2 } = await s.openConversation({
  channelId: channel.id, title: "", text: "second thread", authorId: "u",
});
const upgraded = await s.updateConversation(conv2.id, {
  title: "Explain The Repo", titleSource: "auto",
});
console.log("auto:", JSON.stringify(upgraded && { title: upgraded.title, titleSource: upgraded.titleSource }));
`;

describe("title provenance on the real store (#137)", () => {
  it("AC-2 a dropped host title write answers the row, never throws", () => {
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
    expect(lines.open).toEqual({
      title: "first message for the thread",
      titleSource: "auto",
    });
    expect(lines.late).toEqual({ title: "Typed first", titleSource: "user" });
    expect(lines.row).toEqual({ title: "Typed first", titleSource: "user" });
    expect(lines.auto).toEqual({
      title: "Explain The Repo",
      titleSource: "auto",
    });
  });
});
