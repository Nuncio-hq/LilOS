/** D-#854 on the REAL (drizzle/sqlite) store: an install at v38 holding a
   project with filed threads, a goal and a ticket upgrades to v39 —
   nothing is lost, the links survive, and `project_id` on goals/tickets
   goes nullable so `projects.remove` can detach instead of delete. A
   pre-projects install (v27) upgrading now keeps its threads as chats:
   opening a folder never creates a project anymore. Runs under bun:sqlite
   via a subprocess (vitest itself is Node). */
import { spawnSync } from "node:child_process";
import type { Project } from "@lilos/contracts/app";
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

    expect(out.versionAfter).toBe(42);
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

/* The remove → re-add round trip on the real store: detached rows carry
   `KEY-n` ids a recreated project would collide with unless numbering
   looks past live rows, and the re-add re-attaches the rows the removal
   detached (D-#854 round 2). */
const READD_SCRIPT = `
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createDrizzleStore } from "./src/db/drizzle-store.ts";
import { applyMigrations } from "./src/db/migrate.ts";
import * as schema from "./src/db/schema.ts";

const db = new Database(":memory:");
db.exec("PRAGMA foreign_keys = ON");
applyMigrations(db);
const store = createDrizzleStore(drizzle(db, { schema }));

db.exec("INSERT INTO employees (id, name, created_at) VALUES ('e1', 'Ada', 1)");
db.exec("INSERT INTO channels (id, kind, employee_id, last_seq, created_at) VALUES ('c1', 'dm', 'e1', 5, 1)");

const first = await store.ensureProject({ folder: "~/Code/LilOS", name: "LilOS" });
const t1 = await store.createTicket({ projectId: first.project.id, projectKey: first.project.key, title: "One" });
const goal = await store.createGoal({ projectId: first.project.id, title: "Ship" });
const task = await store.createTask({
  title: "Job",
  parentConversationId: "p1",
  employeeId: "e1",
  channelId: "c1",
  prompt: "Do it",
  projectId: first.project.id,
  projectKey: first.project.key,
  access: "ask",
});
await store.removeProject(first.project.id);

// The re-add: same folder, same key — a fresh project id. The handler's
// tombstone ids ride reattach (the goal has no LIL- id to sweep).
const second = await store.ensureProject({
  folder: "~/Code/LilOS", name: "LilOS", key: "LIL",
  reattach: { goalIds: [goal.id], ticketIds: [t1.id, task.ticket.id] },
});
// The detached goal + tickets re-attach to the new row.
const ticketsBack = await store.listTickets(second.project.id);
const goalsBack = await store.listGoals();
// Numbering looks past the detached LIL-1/LIL-2 — no UNIQUE collision.
const t3 = await store.createTicket({ projectId: second.project.id, projectKey: second.project.key, title: "Three" });
const task2 = await store.createTask({
  title: "Job2",
  parentConversationId: "p1",
  employeeId: "e1",
  channelId: "c1",
  prompt: "Do it again",
  projectId: second.project.id,
  projectKey: second.project.key,
  access: "ask",
});
// And a task with no project is legal — a chat's hand-off stays detached.
const chat = await store.createTask({
  title: "Chat job",
  parentConversationId: "p1",
  employeeId: "e1",
  channelId: "c1",
  prompt: "Loose",
  access: "ask",
});

console.log(JSON.stringify({
  key: second.project.key,
  sameId: second.project.id === first.project.id,
  ticketsBack: ticketsBack.map((t) => t.id).sort(),
  goalBack: goalsBack.find((g) => g.id === goal.id)?.projectId ?? null,
  t3: t3.id,
  task2: task2.ticket.id,
  chat: { id: chat.ticket.id, projectId: chat.ticket.projectId ?? null, convProjectId: chat.conversation.projectId ?? null },
}));
`;

describe("remove → re-add on the real store (D-#854)", () => {
  it("re-attaches detached rows and numbers past them — no id collision", () => {
    const run = spawnSync(BUN, ["-e", READD_SCRIPT], {
      cwd: RELAY_DIR,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null") as {
      key: string;
      sameId: boolean;
      ticketsBack: string[];
      goalBack: string | null;
      t3: string;
      task2: string;
      chat: {
        id: string;
        projectId: string | null;
        convProjectId: string | null;
      };
    };
    expect(out.key).toBe("LIL"); // the typed key lands as typed
    expect(out.sameId).toBe(false);
    expect(out.ticketsBack).toEqual(["LIL-1", "LIL-2"]); // ticket + task re-attached
    expect(out.goalBack).not.toBeNull(); // the goal came back too
    expect(out.t3).toBe("LIL-3"); // no collision with the detached rows
    expect(out.task2).toBe("LIL-4");
    expect(out.chat).toEqual({
      id: "task-1",
      projectId: null,
      convProjectId: null,
    });
  });
});

/* The round-3 data bugs on the real store, through the whole relay:
   (a) a same-key create on a DIFFERENT folder must not take a removed
       project's detached rows — reattach is the folder's tombstone only,
       the `KEY-n` prefix sweep is gone;
   (b) a variant spelling of a live project's folder answers THAT project —
       no LIL2 beside LIL. */
const LIFECYCLE_SCRIPT = `
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { APP_PROTOCOL_VERSION } from "@lilos/contracts/app";
import { createDrizzleStore } from "./src/db/drizzle-store.ts";
import { applyMigrations } from "./src/db/migrate.ts";
import * as schema from "./src/db/schema.ts";
import { createRelay } from "./src/session";

const db = new Database(":memory:");
db.exec("PRAGMA foreign_keys = ON");
applyMigrations(db);
const store = createDrizzleStore(drizzle(db, { schema }));
const relay = createRelay({ store, token: "tk", homeDir: "/Users/ada" });
const frames = [];
const conn = relay.connect({
  send: (f) => frames.push(JSON.parse(f)),
  close: () => {},
});
let n = 0;
const r = async (method, params = {}) => {
  const id = "q" + n++;
  await conn.receive(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  const f = frames.find((x) => x.id === id);
  return f.error ? { error: f.error.message } : f.result;
};
await r("session.hello", { protocolVersion: APP_PROTOCOL_VERSION, token: "tk" });

const lily = (await r("projects.create", { folder: "~/Code/Lily", key: "LIL" })).project;
const g = (await r("goals.create", { project: "LIL", title: "Lily goal" })).goal;
const t = (await r("tickets.create", { project: "LIL", title: "Lily ticket", goalId: g.id })).ticket;
await r("projects.remove", { id: lily.id });
const lilos = (await r("projects.create", { folder: "~/Code/LilOS", key: "LIL" })).project;
const findTicket = async () =>
  (await r("tickets.list", {})).tickets.find((x) => x.id === t.id)?.projectId ?? null;
const findGoal = async () =>
  (await r("goals.list", {})).goals.find((x) => x.id === g.id)?.projectId ?? null;
const ticketInLilos = await findTicket();
const goalInLilos = await findGoal();
const lilosNext = (await r("tickets.create", { project: "LIL", title: "LilOS ticket" })).ticket.id;
const lily2 = (await r("projects.create", { folder: "~/Code/Lily", key: "LY" })).project;
const ticketHome = await findTicket();
const goalHome = await findGoal();

// Same folder again under a variant spelling → the same project row.
const first = (await r("projects.create", { folder: "~/Code/Other", key: "OTH" })).project;
const slashed = (await r("projects.create", { folder: "~/Code/Other/" })).project;
const cased = (await r("projects.create", { folder: "~/code/other" })).project;
const count = (await r("projects.list", {})).projects.length;

console.log(JSON.stringify({
  ticketInLilos, goalInLilos, lilosNext, ticketHome, goalHome,
  lily2: lily2.id, lilos: lilos.id,
  firstId: first.id, slashedId: slashed.id, slashedKey: slashed.key,
  casedId: cased.id, darwin: process.platform === "darwin",
  count,
}));
`;

describe("the removed-project data bugs on the real store (D-#854 round 3)", () => {
  it("a same-key create never steals detached rows; a variant spelling never duplicates", () => {
    const run = spawnSync(BUN, ["-e", LIFECYCLE_SCRIPT], {
      cwd: RELAY_DIR,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null") as {
      ticketInLilos: string | null;
      goalInLilos: string | null;
      lilosNext: string;
      ticketHome: string | null;
      goalHome: string | null;
      lily2: string;
      lilos: string;
      firstId: string;
      slashedId: string;
      slashedKey: string;
      casedId: string;
      darwin: boolean;
      count: number;
    };
    // Lily's rows stayed detached through LilOS's same-key create…
    expect(out.ticketInLilos).toBeNull();
    expect(out.goalInLilos).toBeNull();
    // …while numbering still looked past the detached LIL-1.
    expect(out.lilosNext).toBe("LIL-2");
    // …and Lily's own folder's re-add got them back (tombstone by folder).
    expect(out.ticketHome).toBe(out.lily2);
    expect(out.goalHome).toBe(out.lily2);
    // The variant spelling answered the project it already had.
    expect(out.slashedId).toBe(out.firstId);
    expect(out.slashedKey).toBe("OTH");
    if (out.darwin) expect(out.casedId).toBe(out.firstId); // ~/code/other IS it
    /* LilOS + Lily + Other — no duplicate on macOS (a wrong-case dir on a
       case-sensitive fs really is another folder, so it counts there). */
    expect(out.count).toBe(out.darwin ? 3 : 4);
  });
});
