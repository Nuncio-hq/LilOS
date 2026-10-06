import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/db/migrate";
import { BUN, RELAY_DIR } from "./helpers";

const LATEST_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

/**
 * #571 (AC-1/AC-2): the fixture builds a file-backed DB at v20 — the schema
 * installs in the field actually carry — seeds the audit's shape (1,658
 * sessions + a 100k-message channel with one sparse thread), snapshots the
 * backup v21 must leave behind, migrates, then times the two hot reads.
 * It runs under bun:sqlite and prints one JSON line per step; this block
 * replays each line as an assertion (the message-search.ts pattern —
 * vitest/Node has no sqlite driver).
 */
describe("conversations.summaries scale + v21 migration (bun fixture)", () => {
  const res = spawnSync(BUN, ["run", "test/summaries-fixture.ts"], {
    cwd: RELAY_DIR,
    encoding: "utf8",
    timeout: 120_000,
  });
  const steps = new Map<string, unknown>();
  if (res.status === 0) {
    for (const line of res.stdout.trim().split("\n")) {
      const row = JSON.parse(line) as { step: string; data: unknown };
      steps.set(row.step, row.data);
    }
  }

  it("fixture ran clean", () => {
    expect(res.status, res.stderr).toBe(0);
    expect(steps.get("version-before")).toEqual({ user_version: 20 });
    expect(steps.get("version-after")).toEqual({
      user_version: LATEST_VERSION,
    });
  });

  it("AC-2 the pending migration leaves a usable .v20.bak copy", () => {
    expect(res.status).toBe(0);
    const bak = steps.get("backup") as {
      path: string;
      version: number;
      conversations: number;
    } | null;
    expect(bak).not.toBeNull();
    expect(bak?.path).toMatch(/\.v20\.bak$/);
    expect(bak?.version).toBe(20);
    expect(bak?.conversations).toBe(1659);
  });

  it("v21 installs (conversation_id, seq) and retires the prefix index", () => {
    expect(res.status).toBe(0);
    const indexes = steps.get("indexes") as string[];
    expect(indexes).toContain("messages_conversation_seq");
    expect(indexes).not.toContain("messages_conversation");
  });

  it("AC-1 summaries answer in tens of ms at 1,658 conversations", () => {
    expect(res.status).toBe(0);
    const s = steps.get("summaries") as {
      ms: number;
      runs: number[];
      rows: number;
      rawKb: number;
      deflateKb: number;
      firstRootLen: number;
      firstLastLen: number;
      firstCount: number;
    };
    expect(s.rows).toBe(1659);
    /* The AC's <30 ms is measured on the dev machine and reported in the
       PR — CI boxes share CPU (a contended run measured ~120 ms), so the
       guard is a median-of-3 with a sanity ceiling that only a
       full-scan/N+1 regression could trip; the structural half — the
       index exists, the plan uses it, the row count is right — is what
       actually pins the behavior. */
    expect(s.ms).toBeLessThan(300);
    /* <500 kB is a wire figure — perMessageDeflate is what carries it;
       the raw frame stays multi-MB because roots keep full text for the
       desktop feed. */
    expect(s.deflateKb).toBeLessThan(500);
    expect(s.firstLastLen).toBeLessThanOrEqual(500);
    expect(s.firstRootLen).toBeGreaterThan(500);
    expect(s.firstCount).toBe(12);
  });

  it("AC-1 a sparse thread reads through the index at 100k channel rows", () => {
    expect(res.status).toBe(0);
    const l = steps.get("list-sparse") as { ms: number; rows: number };
    expect(l.rows).toBe(13);
    /* AC is <2 ms (~0.3 ms measured). Two layers of guard: the query plan
       must route the conv-scoped read through messages_conversation_seq
       (deterministic — it's what AC-1 actually installs), and the
       median-of-5 stays under a sanity ceiling for slow CI. */
    const plan = steps.get("sparse-plan") as string[];
    expect(plan.join(" | ")).toContain("messages_conversation_seq");
    expect(l.ms).toBeLessThan(50);
  });

  it("AC-2 no backup when nothing would be lost (memory/fresh/current)", () => {
    expect(res.status).toBe(0);
    expect(steps.get("backup-skips")).toEqual({
      memory: "none",
      fresh: "none",
      current: "none",
    });
  });
});
