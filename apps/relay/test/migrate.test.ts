import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BUN, RELAY_DIR } from "./helpers";

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
      const msgIdx = db.query("PRAGMA index_list(messages)").all().map((x) => x.name);
      const empCols = db.query("PRAGMA table_info(employees)").all().map((c) => c.name);
      const askCols = db.query("PRAGMA table_info(asks)").all().map((c) => c.name);
      console.log(JSON.stringify({
        versionBefore,
        version: db.query("PRAGMA user_version").get().user_version,
        colsAt6, colsAt7, msgCols, tables, tablesAt6, msgIdx, empCols, askCols,
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
    // intent on conversations; v14 adds #161's push tables; v15 adds
    // #300's persisted turn usage on conversations; v16 adds #315's
    // dropped/removed flags on messages; v17 adds #377's claimed flag; v18
    // adds #106's access level on conversations; v19 adds #419's
    // turn_failure card on conversations; v20 adds #346's life column;
    // v21 adds #571's (conversation_id, seq) index and retires the
    // conversation_id-only one it's a strict prefix of; v22 adds #583's
    // turn_stopped word; v23 adds #583's bg_jobs count; v24 adds #563's
    // turn_stopped word; v23 adds #583's bg_jobs count; v24 adds #563's
    // read watermark + finish stamp (and their store-internal fence);
    // v25 adds the asks' hire-draft column; v26 adds #561's muted flag
    // on employees; v27 adds #136's scheduled_tasks table + the
    // conversation's scheduled marker; v28 adds D-#771's projects table +
    // the conversation's project_id; v29 adds D-#773's why / if_yes / if_no;
    // v30 adds D-#772's stuck mark; v31 adds D-#775's reports_to and
    // conversations.stuck_at (issue #775); v32 adds D-#776's goals, tickets
    // and conversations.ticket_id; v33 adds D-#777's company_updates;
    // v34 adds the CEO wake flag and the standing-thread flag; v35 adds
    // D-#844's task columns + the task wake flag; v36 adds D-#761's
    // employees.runtime; v37 adds D-#862's parking columns; v38 adds its
    // review's last_park_action_at.
    expect(out.version).toBe(39);
    expect(out.askCols).toContain("hire");
    expect(out.askCols).toContain("why");
    expect(out.askCols).toContain("if_yes");
    expect(out.askCols).toContain("if_no");
    expect(out.msgCols).toContain("dropped");
    expect(out.msgCols).toContain("removed");
    expect(out.msgCols).toContain("claimed");
    expect(out.msgCols).toContain("ceo_wake");
    for (const col of ["provider", "effort", "fast"])
      expect(out.colsAt7).toContain(col);
    for (const col of ["provider", "effort", "fast", "rewound", "checkpoint"])
      expect(out.msgCols).toContain(col);
    expect(out.colsAt7).toContain("title_source");
    expect(out.colsAt7).toContain("workspace");
    expect(out.colsAt7).toContain("usage");
    expect(out.colsAt7).toContain("access");
    expect(out.colsAt7).toContain("turn_failure");
    expect(out.colsAt7).toContain("life");
    expect(out.colsAt7).toContain("turn_stopped");
    expect(out.colsAt7).toContain("bg_jobs");
    expect(out.colsAt7).toContain("stuck");
    expect(out.colsAt7).toContain("stuck_at");
    expect(out.colsAt7).toContain("read_seq");
    expect(out.colsAt7).toContain("finished_seq");
    expect(out.colsAt7).toContain("project_id");
    expect(out.tables).toContain("settings");
    expect(out.tables).toContain("profile");
    expect(out.tables).toContain("messages_fts");
    expect(out.tables).toContain("projects");
    expect(out.tables).toContain("goals");
    expect(out.tables).toContain("tickets");
    expect(out.tables).toContain("company_updates");
    expect(out.colsAt7).toContain("ticket_id");
    expect(out.colsAt7).toContain("ceo_thread");
    expect(out.tables).toContain("pairing_grants");
    expect(out.tables).toContain("paired_devices");
    expect(out.tables).toContain("device_push");
    expect(out.tables).toContain("engine_event_marks");
    expect(out.empCols).toContain("muted");
    expect(out.empCols).toContain("reports_to");
    expect(out.empCols).toContain("runtime");
    for (const col of [
      "pinned_at",
      "settled_at",
      "settled_reason",
      "settled_pr",
      "snoozed_until",
      "auto_settle",
      "last_park_action_at",
    ])
      expect(out.colsAt7).toContain(col);
    expect(out.msgIdx).toContain("messages_conversation_seq");
    expect(out.msgIdx).not.toContain("messages_conversation");
    // …and keeps everything v6 shipped.
    expect(out.colsAt7).toContain("cwd");
    expect(out.tables).toContain("recent_folders");
  });

  it("D-#862 v37 parks the rows `archived` already held — settled manual", () => {
    /* Seed a v36-shaped DB with one archived + one live thread, then let
       applyMigrations run v37. The archived row's settled_at falls back
       to its newest message (its last activity), else created_at. */
    const script = `
      import { Database } from "bun:sqlite";
      import { MIGRATIONS, applyMigrations } from "./src/db/migrate.ts";
      const db = new Database(":memory:");
      for (const m of MIGRATIONS.filter((m) => m.version <= 36)) {
        for (const s of m.statements) db.exec(s);
        db.exec("PRAGMA user_version = " + m.version);
      }
      db.exec("INSERT INTO employees (id, name, created_at) VALUES ('e1', 'Ada', 1)");
      db.exec("INSERT INTO channels (id, kind, employee_id, last_seq, created_at) VALUES ('c1', 'dm', 'e1', 9, 1)");
      let seq = 0;
      const seed = (id, createdAt, archived, lastMsg) => {
        seq += 1;
        db.exec("INSERT INTO messages (id, channel_id, conversation_id, author_id, author_kind, text, seq, created_at) VALUES ('m_" + id + "', 'c1', '" + id + "', 'user', 'user', 'hi', " + seq + ", " + lastMsg + ")");
        db.query("INSERT INTO conversations (id, channel_id, root_message_id, title, archived, created_at) VALUES (?, 'c1', 'm_" + id + "', ?, ?, ?)")
          .run(id, id, archived, createdAt);
      };
      seed("old_archived", 1000, 1, 4000);
      seed("live", 2000, 0, 3000);
      applyMigrations(db);
      const rows = db.query("SELECT id, archived, settled_at, settled_reason, auto_settle FROM conversations ORDER BY id").all();
      /* The shipped store's park translation over the migrated DB: the
         legacy archived write folds into settle; settle drops pin +
         snooze; un-settle clears reason/PR and the mirror. */
      const { drizzle } = await import("drizzle-orm/bun-sqlite");
      const { createDrizzleStore } = await import("./src/db/drizzle-store.ts");
      const schema = await import("./src/db/schema.ts");
      const store = createDrizzleStore(drizzle(db, { schema }));
      await store.updateConversation("live", {
        pinnedAt: 5, snoozedUntil: 9,
      });
      const pinnedSnoozed = await store.getConversation("live");
      await store.updateConversation("live", { archived: true });
      const settledViaAlias = await store.getConversation("live");
      await store.updateConversation("live", { settledAt: null });
      const unsettled = await store.getConversation("live");
      const migrated = await store.getConversation("old_archived");
      console.log(JSON.stringify({
        version: db.query("PRAGMA user_version").get().user_version,
        rows, pinnedSnoozed, settledViaAlias, unsettled, migrated,
      }));
    `;
    const res = spawnSync(BUN, ["-e", script], {
      cwd: RELAY_DIR,
      encoding: "utf8",
    });
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout.trim().split("\n").at(-1) ?? "null");
    expect(out.version).toBe(39);
    const archived = out.rows.find(
      (r: { id: string }) => r.id === "old_archived",
    );
    expect(archived).toMatchObject({
      archived: 1,
      settled_at: 4000,
      settled_reason: "manual",
      auto_settle: 1,
    });
    const live = out.rows.find((r: { id: string }) => r.id === "live");
    expect(live).toMatchObject({ archived: 0, settled_at: null });
    /* Drizzle store: the pin + snooze landed; the legacy `archived: true`
       write settled the row (and dropped them); `settledAt: null` woke
       it again with the mirror back to live. */
    expect(out.pinnedSnoozed).toMatchObject({
      pinnedAt: 5,
      snoozedUntil: 9,
    });
    /* The raw-SQL row emits the flag verbatim — true = the default. */
    expect(out.pinnedSnoozed.autoSettle).toBe(true);
    expect(out.settledViaAlias).toMatchObject({
      archived: true,
      settledReason: "manual",
    });
    expect(out.settledViaAlias.settledAt).toBeTypeOf("number");
    expect(out.settledViaAlias.pinnedAt).toBeUndefined();
    expect(out.settledViaAlias.snoozedUntil).toBeUndefined();
    expect(out.unsettled).toMatchObject({ archived: false });
    expect(out.unsettled.settledAt).toBeUndefined();
    expect(out.unsettled.settledReason).toBeUndefined();
    /* The migrated row reads back as parked through the domain type. */
    expect(out.migrated).toMatchObject({
      archived: true,
      settledAt: 4000,
      settledReason: "manual",
    });
  });
});
