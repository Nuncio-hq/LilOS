import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUN = process.env.LILOS_BUN_BIN ?? "bun";

/**
 * #92 / #113 merge safety: main's v6 (#113 cwd + recent_folders) is shipped —
 * users already on it must still get #92's columns and the settings table.
 * The check itself runs under bun:sqlite (no driver in vitest's Node).
 */
describe("relay migrations", () => {
  it("upgrades a DB already at v6 (main's schema) to the latest version", () => {
    const script = `
      import { Database } from "bun:sqlite";
      import { MIGRATIONS, applyMigrations } from "./src/db/migrate.ts";
      const db = new Database(":memory:");
      // Replay shipped main history only: migrations 1..6, then pin v6.
      for (const m of MIGRATIONS.filter((m) => m.version <= 6)) {
        for (const s of m.statements) db.exec(s);
        db.exec("PRAGMA user_version = " + m.version);
      }
      const colsAt6 = db.query("PRAGMA table_info(conversations)").all().map((c) => c.name);
      const tablesAt6 = db.query("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
      const versionBefore = db.query("PRAGMA user_version").get().user_version;
      applyMigrations(db);
      const colsAt7 = db.query("PRAGMA table_info(conversations)").all().map((c) => c.name);
      const msgCols = db.query("PRAGMA table_info(messages)").all().map((c) => c.name);
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
      console.log(JSON.stringify({
        versionBefore,
        version: db.query("PRAGMA user_version").get().user_version,
        colsAt6, colsAt7, msgCols, tables, tablesAt6,
      }));
    `;
    const res = spawnSync(BUN, ["-e", script], {
      cwd: RELAY_DIR,
      encoding: "utf8",
    });
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout.trim().split("\n").at(-1) ?? "null");

    // v6 shipped #113's shape — the new fields can't exist yet.
    expect(out.versionBefore).toBe(6);
    expect(out.colsAt6).toContain("cwd");
    expect(out.colsAt6).not.toContain("provider");
    expect(out.tablesAt6).toContain("recent_folders");
    expect(out.tablesAt6).not.toContain("settings");

    // v7 adds #92's pick columns + the LilOS-owned settings KV; v8 adds
    // #118's profile row; v9 adds #138's FTS index (sqlite_master lists the
    // virtual table's shadow tables too — only assert the FTS table itself);
    // v10 adds #137's title provenance; v11 adds #153's phone pairing
    // tables; v12 adds #134's rewind marks; v13 adds #156's workspace
    // intent on conversations; v14 adds #161's push tables.
    expect(out.version).toBe(14);
    for (const col of ["provider", "effort", "fast"])
      expect(out.colsAt7).toContain(col);
    for (const col of ["provider", "effort", "fast", "rewound", "checkpoint"])
      expect(out.msgCols).toContain(col);
    expect(out.colsAt7).toContain("title_source");
    expect(out.colsAt7).toContain("workspace");
    expect(out.tables).toContain("settings");
    expect(out.tables).toContain("profile");
    expect(out.tables).toContain("messages_fts");
    expect(out.tables).toContain("pairing_grants");
    expect(out.tables).toContain("paired_devices");
    expect(out.tables).toContain("device_push");
    expect(out.tables).toContain("engine_event_marks");
    // …and keeps everything v6 shipped.
    expect(out.colsAt7).toContain("cwd");
    expect(out.tables).toContain("recent_folders");
  });
});
