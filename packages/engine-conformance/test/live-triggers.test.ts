import { describe, expect, test } from "vitest";
import {
  APPROVAL_PROMPT,
  COMPRESS_FILLER_TURNS,
  CORE_SCENARIOS,
  compressFillerPrompt,
  SCENARIO_LIVE_PROMPTS,
} from "../src/scenarios.js";

// #63 — the approval/resume/compression live triggers. These tests pin the
// scenario wiring a real Hermes needs; behaviour itself is covered by the
// per-scenario suite runs (fake in CI, stub + real model via live:hermes).

describe("#63 live-engine triggers", () => {
  test("AC-1 approval prompt names a verbatim command hermes' dangerous-command detector gates", () => {
    // tools/approval_detection.py DANGEROUS_PATTERNS: `chmod 777` matches
    // "world/other-writable permissions"; under approvals.mode: manual the
    // terminal guard opens an approval request. A file edit never gates.
    expect(APPROVAL_PROMPT).toContain("chmod 777 README.md");
    expect(APPROVAL_PROMPT).toMatch(/terminal command/);
    // engine-fake must still take its mutating script (it asks approval on
    // patch/write_file steps) — the prompt needs an edit verb for that.
    expect(APPROVAL_PROMPT).toMatch(
      /\b(add|fix|change|update|write|implement|refactor|bump|remove|rename|create|make|edit|move|delete|scaffold)\b/i,
    );
    expect(
      SCENARIO_LIVE_PROMPTS[
        "approval: request.opened -> request.respond -> tool completes"
      ],
    ).toBe(APPROVAL_PROMPT);
  });

  test("AC-2 resume mid-turn reuses the approval trigger", () => {
    expect(
      SCENARIO_LIVE_PROMPTS[
        "resume mid-turn: events.since replays and returns open requests"
      ],
    ).toBe(APPROVAL_PROMPT);
    // Both scenarios exist in the core suite that live:hermes runs.
    const ids = CORE_SCENARIOS.map((s) => s.id);
    expect(ids).toContain(
      "approval: request.opened -> request.respond -> tool completes",
    );
    expect(ids).toContain(
      "resume mid-turn: events.since replays and returns open requests",
    );
  });

  test("AC-3 compression history is bounded — no long-output drives", () => {
    // A real model must finish history-building fast: few turns, each with a
    // small bounded reply (no LILOS_LONG/LILOS_SLOW drives), yet enough
    // messages for compress to have a foldable window under pinned protects.
    expect(COMPRESS_FILLER_TURNS).toBeGreaterThanOrEqual(4);
    expect(COMPRESS_FILLER_TURNS).toBeLessThanOrEqual(8);
    for (let i = 0; i < COMPRESS_FILLER_TURNS; i++) {
      const p = compressFillerPrompt(i);
      expect(p).not.toContain("LILOS_LONG");
      expect(p).not.toContain("LILOS_SLOW");
      expect(p.length).toBeLessThan(300);
    }
  });
});
