/** D-#854 on the REAL (drizzle/sqlite) store: an install at v38 holding a
   project with filed threads, a goal and a ticket upgrades to v39 —
   nothing is lost, the links survive, and `project_id` on goals/tickets
   goes nullable so `projects.remove` can detach instead of delete. A
   pre-projects install (v27) upgrading now keeps its threads as chats:
   opening a folder never creates a project anymore. Runs under bun:sqlite
   via a subprocess (vitest itself is Node). */
import { spawnSync } from "node:child_process";
import type { Conversation, Project } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { BUN, RELAY_DIR } from "./helpers";

/** A DB frozen at v38 — projects exist, goals/tickets' project_id is still
    NOT NULL — holding a project with two filed threads (one in a
    subfolder), a goal, a ticket, and a folder-less chat. */
const SEED_V38 = `
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "./src/db/migrate.ts";

const open38 = (path) => {
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  for (const m of MIGRATIONS.filter((m) => m.version <= 38)) {
    for (const s of m.statements) db.exec(s);
    db.exec("PRAGMA user_version = " + m.version);
  }
  db.exec("INSERT INTO employees (id, name, created_at) VALUES ('e1', 'Ada', 1)");
  db.exec("INSERT INTO channels (id, kind, employee_id, last_seq, created_at) VALUES ('c1', 'dm', 'e1', 5, 1)");
  db.exec("INSERT INTO projects (id, name, key, folder, about, created_at) VALUES ('p1', 'LilOS', 'LIL', '~/Code/LilOS', '', 1)");
  let seq = 0;
  const conv = (id, createdAt, cwd, projectId) => {
    seq += 1;
    db.exec("INSERT INTO messages (id, channel_id, author_id, author_kind, text, seq, created_at) VALUES ('m_" + id + "', 'c1', 'user', 'user', 'hi', " + seq + ", " + createdAt + ")");
    db.query("INSERT INTO conversations (id, channel_id, root_message_id, title, cwd, project_id, created_at) VALUES (?, 'c1', ?, ?, ?, ?, ?)")
      .run(id, "m_" + id, id, cwd, projectId, createdAt);
    db.exec("UPDATE messages SET conversation_id = '" + id + "' WHERE id = 'm_" + id + "'");
  };
  conv("t1", 100, "~/Code/LilOS", "p1");
  conv("t2", 200, "~/Code/LilOS/sub", "p1");
  conv("chat", 300, null, null);
  db.exec("INSERT INTO goals (id, title, project_id, created_at) VALUES ('g1', 'Ship', 'p1', 1)");
  db.exec("INSERT INTO tickets (id, project_id, number, title, status, status_at, created_at) VALUES ('LIL-1', 'p1', 1, 'Do', 'planned', 1, 1)");
  db.exec("UPDATE conversations SET ticket_id = 'LIL-1' WHERE id = 't1'");
  return db;
};
`;

const SCRIPT = `
${SEED_V38}
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createDrizzleStore } from "./src/db/drizzle-store.ts";
import { applyMigrations } from "./src/db/migrate.ts";
import * as schema from "./src/db/schema.ts";

const db = open38(":memory:");
const cols = (t) => db.query("PRAGMA table_info(" + t + ")").all();
const ticketPidBefore = cols("tickets").find((c) => c.name === "project_id").notnull;

applyMigrations(db); // v39: goals/tickets project_id → nullable (D-#854)
const store = createDrizzleStore(drizzle(db, { schema }));
const versionAfter = db.query("PRAGMA user_version").get().user_version;
const ticketPidAfter = cols("tickets").find((c) => c.name === "project_id").notnull;
const goalPidAfter = cols("goals").find((c) => c.name === "project_id").notnull;

// Everything survived: the project, the filings, the goal, the ticket.
const projects = await store.listProjects();
const convs = {};
for (const id of ["t1", "t2", "chat"]) {
  const c = await store.getConversation(id);
  convs[id] = { projectId: c?.projectId ?? null, cwd: c?.cwd ?? null, ticketId: c?.ticketId ?? null };
}
const goal = (await store.listGoals())[0];
const ticket = (await store.listTickets())[0];

// removeProject detaches; nothing else is deleted.
const removed = await store.removeProject("p1");
const after = {
  projects: await store.listProjects(),
  convs: {},
};
for (const id of ["t1", "t2", "chat"]) {
  const c = await store.getConversation(id);
  after.convs[id] = { gone: !c, projectId: c?.projectId ?? null, cwd: c?.cwd ?? null };
}
const goalAfter = (await store.listGoals())[0];
const ticketAfter = (await store.listTickets())[0];
const missing = await store.removeProject("nope");

console.log(JSON.stringify({
  versionAfter, ticketPidBefore, ticketPidAfter, goalPidAfter,
  projects, convs, goal, ticket,
  removed: removed ? {
    project: removed.project.id,
    conversations: removed.conversations.map((c) => c.id).sort(),
    goals: removed.goals.map((g) => g.id),
    tickets: removed.tickets.map((t) => t.id),
  } : null,
  after, goalAfter, ticketAfter, missing,
}));
`;

interface Out {
  versionAfter: number;
  ticketPidBefore: number;
  ticketPidAfter: number;
  goalPidAfter: number;
  projects: Project[];
  convs: Record<
    string,
    { projectId: string | null; cwd: string | null; ticketId: string | null }
  >;
  goal: { id: string; projectId?: string };
  ticket: { id: string; projectId?: string };
  removed: {
    project: string;
    conversations: string[];
    goals: string[];
    tickets: string[];
  } | null;
  after: {
    projects: Project[];
    convs: Record<
      string,
      { gone: boolean; projectId: string | null; cwd: string | null }
    >;
  };
  goalAfter: { id: string; projectId?: string };
  ticketAfter: { id: string; projectId?: string };
  missing: null;
}

describe("projects migration + remove on the real store (D-#854)", () => {
  it("v39 keeps every row, makes goal/ticket project_id nullable, and remove detaches", () => {
    const run = spawnSync(BUN, ["-e", SCRIPT], {
      cwd: RELAY_DIR,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(
      run.stdout.trim().split("\n").at(-1) ?? "null",
    ) as Out;

    expect(out.versionAfter).toBe(39);
    // NOT NULL → nullable, on the rebuilt table.
    expect(out.ticketPidBefore).toBe(1);
    expect(out.ticketPidAfter).toBe(0);
    expect(out.goalPidAfter).toBe(0);

    // No data loss: the project, both filings, the goal, the ticket, and
    // the ticket→thread link all survived the table rebuild.
    expect(out.projects.map((p) => [p.id, p.key, p.folder])).toEqual([
      ["p1", "LIL", "~/Code/LilOS"],
    ]);
    expect(out.convs.t1).toEqual({
      projectId: "p1",
      cwd: "~/Code/LilOS",
      ticketId: "LIL-1",
    });
    expect(out.convs.t2.projectId).toBe("p1");
    expect(out.convs.chat.projectId).toBeNull();
    expect(out.goal.projectId).toBe("p1");
    expect(out.ticket.projectId).toBe("p1");

    // remove detaches under foreign_keys ON: the project row goes; threads
    // keep their folders, goal and ticket keep their ids.
    expect(out.removed).toEqual({
      project: "p1",
      conversations: ["t1", "t2"],
      goals: ["g1"],
      tickets: ["LIL-1"],
    });
    expect(out.after.projects).toEqual([]);
    expect(out.after.convs.t1).toEqual({
      gone: false,
      projectId: null,
      cwd: "~/Code/LilOS",
    });
    expect(out.after.convs.chat.gone).toBe(false);
    expect(out.goalAfter.projectId).toBeUndefined();
    expect(out.ticketAfter.projectId).toBeUndefined();
    expect(out.missing).toBeNull();
  });
});
