import { spawnSync } from "node:child_process";
import type { CompanyUpdate } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { BUN, RELAY_DIR } from "./helpers";
import { createMemoryStore } from "./memory-store";

/**
 * D-#777: threads on a ticket and company updates break a same-millisecond
 * tie newest-first. Memory uses insertion order. The real store uses rowid.
 */

describe("newest-first ties on the memory store", () => {
  it("lists the later update first when the clocks match", async () => {
    const store = createMemoryStore();
    const first = await store.postUpdate({
      kind: "note",
      text: "first",
      authorKind: "system",
    });
    const second = await store.postUpdate({
      kind: "note",
      text: "second",
      authorKind: "system",
    });
    (first as CompanyUpdate).createdAt = 5;
    (second as CompanyUpdate).createdAt = 5;
    const listed = await store.listUpdates();
    expect(listed.map((u) => u.id)).toEqual([second.id, first.id]);
  });

  it("lists the later thread first when the clocks match", async () => {
    const store = createMemoryStore();
    const ada = await store.createEmployee({
      name: "Ada",
      role: "eng",
      status: "online",
      profile: "default",
      model: "",
      now: "",
      instructions: "",
      respondTo: "me",
    });
    const blair = await store.createEmployee({
      name: "Blair",
      role: "eng",
      status: "online",
      profile: "default",
      model: "",
      now: "",
      instructions: "",
      respondTo: "me",
    });
    const { project } = await store.ensureProject({
      folder: "/tmp/lil",
      name: "Lil",
    });
    const ticket = await store.createTicket({
      projectId: project.id,
      projectKey: project.key,
      title: "Build",
    });
    const { channel: adaCh } = await store.openDmChannel(ada.id);
    const { channel: blairCh } = await store.openDmChannel(blair.id);
    const first = await store.assignTicket({
      id: ticket.id,
      ownerId: ada.id,
      channelId: adaCh.id,
    });
    const second = await store.assignTicket({
      id: ticket.id,
      ownerId: blair.id,
      channelId: blairCh.id,
    });
    if (!first || !second) throw new Error("assign failed");
    first.conversation.createdAt = 5;
    second.conversation.createdAt = 5;
    const threads = await store.threadsOnTicket(ticket.id);
    expect(threads.map((t) => t.id)).toEqual([
      second.conversation.id,
      first.conversation.id,
    ]);
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
db.exec(\`
  INSERT INTO company_updates (id, kind, text, author_kind, created_at)
  VALUES ('old', 'note', 'old', 'system', 5),
         ('new', 'note', 'new', 'system', 5);
\`);
const updates = await s.listUpdates();
const ada = await s.createEmployee({
  name: "Ada", role: "eng", status: "online", profile: "default",
  model: "", now: "", instructions: "", respondTo: "me",
});
const blair = await s.createEmployee({
  name: "Blair", role: "eng", status: "online", profile: "default",
  model: "", now: "", instructions: "", respondTo: "me",
});
const { project } = await s.ensureProject({ folder: "/tmp/lil", name: "Lil" });
const ticket = await s.createTicket({ projectId: project.id, projectKey: project.key, title: "Build" });
const { channel: adaCh } = await s.openDmChannel(ada.id);
const { channel: blairCh } = await s.openDmChannel(blair.id);
const first = await s.assignTicket({ id: ticket.id, ownerId: ada.id, channelId: adaCh.id });
const second = await s.assignTicket({ id: ticket.id, ownerId: blair.id, channelId: blairCh.id });
db.exec("UPDATE conversations SET created_at = 5 WHERE ticket_id = '" + ticket.id + "'");
const threads = await s.threadsOnTicket(ticket.id);
console.log(JSON.stringify({
  updates: updates.map((u) => u.id),
  threads: threads.map((t) => t.id),
  first: first && first.conversation.id,
  second: second && second.conversation.id,
}));
`;

describe("newest-first ties on the real store", () => {
  it("breaks a shared clock by rowid, newest first", () => {
    const run = spawnSync(BUN, ["-e", SCRIPT], {
      cwd: RELAY_DIR,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null") as {
      updates: string[];
      threads: string[];
      first: string;
      second: string;
    };
    expect(out.updates).toEqual(["new", "old"]);
    expect(out.threads).toEqual([out.second, out.first]);
  });
});
