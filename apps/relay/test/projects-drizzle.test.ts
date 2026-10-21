/** D-#771 on the REAL (drizzle/sqlite) store: an install already at v27 with
    conversations in two folders, a worktree thread and a folder-less chat
    upgrades through v28 (projects) and v29 (ask lines) and is filed by the
    boot backfill — nothing lost, one project per distinct folder, idempotent
    on the next boot. Runs under bun:sqlite via a subprocess (vitest itself
    is Node). */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { RelayClient } from "@lilos/client-runtime";
import type { Conversation, Project } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { BUN, mkhome, RELAY_DIR, startRelay, wsFactory } from "./helpers";

/** A DB frozen at v27 — the schema before projects existed — holding the
    threads an upgrading install has: two spellings of one folder, a second
    folder, a worktree thread of the first, and a folder-less chat. */
const SEED_V27 = `
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "./src/db/migrate.ts";

const open27 = (path) => {
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  for (const m of MIGRATIONS.filter((m) => m.version <= 27)) {
    for (const s of m.statements) db.exec(s);
    db.exec("PRAGMA user_version = " + m.version);
  }
  db.exec("INSERT INTO employees (id, name, created_at) VALUES ('e1', 'Ada', 1)");
  db.exec("INSERT INTO channels (id, kind, employee_id, last_seq, created_at) VALUES ('c1', 'dm', 'e1', 5, 1)");
  let seq = 0;
  const old = (id, createdAt, cwd, workspace) => {
    seq += 1;
    db.exec("INSERT INTO messages (id, channel_id, author_id, author_kind, text, seq, created_at) VALUES ('m_" + id + "', 'c1', 'user', 'user', 'hi', " + seq + ", " + createdAt + ")");
    db.query("INSERT INTO conversations (id, channel_id, root_message_id, title, cwd, workspace, created_at) VALUES (?, 'c1', ?, ?, ?, ?, ?)")
      .run(id, "m_" + id, id, cwd, workspace, createdAt);
    db.exec("UPDATE messages SET conversation_id = '" + id + "' WHERE id = 'm_" + id + "'");
  };
  old("lil1", 100, "~/Code/LilOS", null);
  old("lil2", 300, HOME + "/Code/LilOS/", null);
  old("qr", 200, "~/Code/qrit", null);
  old("wt", 400, "~/Code/LilOS/.lilos/wt/fix", JSON.stringify({ mode: "existing", repoPath: "~/Code/LilOS", branch: "fix" }));
  old("chat", 500, null, null);
  return db;
};
`;

const SCRIPT = (home: string) => `
${SEED_V27}
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createDrizzleStore } from "./src/db/drizzle-store.ts";
import { applyMigrations } from "./src/db/migrate.ts";
import { backfillProjects } from "./src/projects.ts";
import * as schema from "./src/db/schema.ts";

const HOME = ${JSON.stringify(home)};
const db = open27(":memory:");
const colsAt27 = db.query("PRAGMA table_info(conversations)").all().map((c) => c.name);

applyMigrations(db); // v28 projects, v29 ask lines, v30 stuck, v31 reports_to + stuck_at
const store = createDrizzleStore(drizzle(db, { schema }));
const versionAfter = db.query("PRAGMA user_version").get().user_version;
const colsAfter = db.query("PRAGMA table_info(conversations)").all().map((c) => c.name);
const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
const indexes = db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((t) => t.name);

const first = await backfillProjects(store, HOME);
const projects = await store.listProjects();
const filed = {};
for (const id of ["lil1", "lil2", "qr", "wt", "chat"]) {
  filed[id] = (await store.getConversation(id))?.projectId ?? null;
}
const second = await backfillProjects(store, HOME);
const projectsAfter = await store.listProjects();

// The real store's get-or-create: same folder → same row; a colliding name
// gets the next key; the summaries' raw-SQL path carries projectId.
const again = await store.ensureProject({ folder: "~/Code/LilOS" });
const clash = await store.ensureProject({ folder: "~/other/lilos" });
const summaries = await store.listConversationSummaries({ includeArchived: true });
const summaryFiled = Object.fromEntries(summaries.map((s) => [s.conversation.id, s.conversation.projectId ?? null]));

console.log(JSON.stringify({
  versionAfter, colsAt27, colsAfter, tables, indexes,
  first, second, projects, filed, projectsSame: JSON.stringify(projects) === JSON.stringify(projectsAfter),
  again: { created: again.created, id: again.project.id },
  clash: { created: clash.created, key: clash.project.key, name: clash.project.name },
  summaryFiled,
}));
`;

interface Out {
  versionAfter: number;
  colsAt27: string[];
  colsAfter: string[];
  tables: string[];
  indexes: string[];
  first: { filed: number; created: number };
  second: { filed: number; created: number };
  projects: Project[];
  filed: Record<string, string | null>;
  projectsSame: boolean;
  again: { created: boolean; id: string };
  clash: { created: boolean; key: string; name: string };
  summaryFiled: Record<string, string | null>;
}

const HOME = "/Users/ada";

describe("projects migration + backfill on the real store (D-#771)", () => {
  it("files every old foldered thread under its folder's project, once", () => {
    const run = spawnSync(BUN, ["-e", SCRIPT(HOME)], {
      cwd: RELAY_DIR,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(
      run.stdout.trim().split("\n").at(-1) ?? "null",
    ) as Out;

    // The migration adds the table, the column and their indexes.
    expect(out.colsAt27).not.toContain("project_id");
    expect(out.colsAt27).not.toContain("stuck");
    /* v28 filed projects; v29 (D-#773) adds ask lines; v30 (D-#772) adds
       stuck; v31 (D-#775) adds reports_to and stuck_at. */
    expect(out.versionAfter).toBe(31);
    expect(out.colsAfter).toContain("project_id");
    expect(out.colsAfter).toContain("stuck");
    expect(out.colsAfter).toContain("stuck_at");
    expect(out.tables).toContain("projects");
    for (const index of [
      "projects_key",
      "projects_folder",
      "conversations_project",
    ])
      expect(out.indexes).toContain(index);

    // Two projects (one per distinct folder), named and keyed from the folder
    // and dated by the folder's oldest thread; nothing else was created.
    expect(out.first).toEqual({ filed: 4, created: 2 });
    expect(
      out.projects.map((p) => [p.name, p.key, p.folder, p.about, p.createdAt]),
    ).toEqual([
      ["LilOS", "LIL", "~/Code/LilOS", "", 100],
      ["qrit", "QRI", "~/Code/qrit", "", 200],
    ]);
    const [lilos, qrit] = out.projects;
    expect(out.filed).toEqual({
      lil1: lilos.id,
      lil2: lilos.id, // the absolute, trailing-slash spelling of the same folder
      wt: lilos.id, // a worktree thread files under its repo folder
      qr: qrit.id,
      chat: null, // folder-less → a plain chat, nothing lost
    });

    // A second boot finds nothing to file.
    expect(out.second).toEqual({ filed: 0, created: 0 });
    expect(out.projectsSame).toBe(true);

    // The real store's get-or-create and the summaries' raw-SQL read.
    expect(out.again).toEqual({ created: false, id: lilos.id });
    expect(out.clash).toEqual({ created: true, key: "LIL2", name: "lilos" });
    expect(out.summaryFiled).toEqual(out.filed);
  });

  it("the real relay files an upgraded install at boot, and a second boot changes nothing", async () => {
    // The Mac's home is whatever `homedir()` says in the spawned relay:
    // point it at a tmpdir so `~/Code/...` cwds expand somewhere known.
    const macHome = mkhome();
    const relayHome = mkhome();
    const seeded = spawnSync(
      BUN,
      [
        "-e",
        `${SEED_V27}
const db = open27(${JSON.stringify(join(relayHome, "relay.sqlite"))});
db.close();`.replace(/\bHOME\b/g, JSON.stringify(macHome)),
      ],
      { cwd: RELAY_DIR, encoding: "utf8", timeout: 30_000 },
    );
    expect(seeded.status, seeded.stderr).toBe(0);

    const read = async () => {
      const relay = await startRelay({
        LILOS_RELAY_HOME: relayHome,
        HOME: macHome,
      });
      const client = new RelayClient({
        url: relay.url,
        token: relay.token,
        socketFactory: wsFactory().factory,
        autoReconnect: false,
        client: { name: "e2e-projects" },
      });
      await client.connect();
      const { projects } = await client.request<{ projects: Project[] }>(
        "projects.list",
        {},
      );
      const { conversations } = await client.request<{
        conversations: Conversation[];
      }>("conversations.list", { includeArchived: true });
      client.close();
      relay.proc.kill("SIGKILL");
      await new Promise<void>((resolve) => relay.proc.once("exit", resolve));
      return {
        projects,
        filed: Object.fromEntries(
          conversations.map((c) => [c.id, c.projectId ?? null]),
        ),
      };
    };

    const first = await read();
    expect(first.projects.map((p) => [p.name, p.key, p.folder])).toEqual([
      ["LilOS", "LIL", "~/Code/LilOS"],
      ["qrit", "QRI", "~/Code/qrit"],
    ]);
    const [lilos, qrit] = first.projects;
    expect(first.filed).toEqual({
      lil1: lilos.id,
      lil2: lilos.id,
      wt: lilos.id,
      qr: qrit.id,
      chat: null,
    });

    // Restart on the same DB: nothing re-filed, no project added.
    expect(await read()).toEqual(first);
  }, 60_000);
});
