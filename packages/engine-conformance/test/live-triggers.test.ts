import { describe, expect, test } from "vitest";
import {
  APPROVAL_PROMPT,
  COMPRESS_FILLER_BYTES,
  COMPRESS_FILLER_TURNS,
  CORE_SCENARIOS,
  compressFillerPrompt,
  SCENARIO_LIVE_PROMPTS,
} from "../src/scenarios.js";

// #63 — the approval/resume live triggers, #76 the compression fold. These
// tests pin the scenario wiring a real engine needs; behaviour itself is
// covered by the per-scenario suite runs (fake in CI, stub + real model via
// live run).

describe("#63 live-engine triggers", () => {
  test("AC-1 approval prompt names a verbatim command the dangerous-command detector gates", () => {
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
    // Both scenarios exist in the core suite that the live runner runs.
    const ids = CORE_SCENARIOS.map((s) => s.id);
    expect(ids).toContain(
      "approval: request.opened -> request.respond -> tool completes",
    );
    expect(ids).toContain(
      "resume mid-turn: events.since replays and returns open requests",
    );
  });
});

describe("#76 compression fold on a real model", () => {
  test("AC-1 filler prompts carry enough pasted mass to out-weigh any summary", () => {
    // The fold commits only when the compressed transcript is smaller than
    // the original — the engine refuses otherwise (`removed=0`, the bug).
    // Worst case for the compressed side: the head keeps one message
    // verbatim, the lean tail keeps up to ~37.5K tokens, and the summary can
    // grow to ~90KB (verbatim user quotes + anchor index + summary body +
    // footer). Total pasted mass must clear that comfortably or the fold is
    // refused again.
    expect(COMPRESS_FILLER_TURNS).toBeGreaterThanOrEqual(4);
    expect(COMPRESS_FILLER_TURNS * COMPRESS_FILLER_BYTES).toBeGreaterThan(
      256 * 1024,
    );
    const seen = new Set<string>();
    for (let i = 0; i < COMPRESS_FILLER_TURNS; i++) {
      const p = compressFillerPrompt(i);
      expect(p.length).toBeGreaterThan(COMPRESS_FILLER_BYTES);
      expect(p).toContain("Context builder"); // openai_stub.py keys on this
      expect(p).toContain("LILOS_OK"); // the ack a real model is asked for
      expect(p).not.toContain("LILOS_LONG");
      expect(p).not.toContain("LILOS_SLOW");
      seen.add(p);
    }
    // Identical rows would collapse under the summarizer; each turn's paste
    // must differ.
    expect(seen.size).toBe(COMPRESS_FILLER_TURNS);
  });

  test("AC-1 filler rows stay real user turns and dodge the anchor index", () => {
    // Rows starting with a synthetic prefix (`_SYNTHETIC_USER_ROW_PREFIXES`)
    // are excluded from the tail's last-real-user anchor AND from the summary's
    // verbatim quote section — a synthetic filler would fold wrong.
    for (const prefix of [
      "[System:",
      "[CONTEXT",
      "[PRIOR CONTEXT",
      "[IMPORTANT: Background",
      "[Your active task list",
      "[Planning state preserved",
      "[ASYNC DELEGATION",
      "[OUT-OF-BAND",
      "Cronjob Response:",
    ]) {
      for (let i = 0; i < COMPRESS_FILLER_TURNS; i++)
        expect(compressFillerPrompt(i).startsWith(prefix)).toBe(false);
    }
    // The engine's mechanical anchor harvest re-quotes every hit verbatim
    // into the summary — the paste must produce none of them so the summary
    // can't grow on mechanical needles. Patterns mirror the engine's list.
    const anchorPatterns = [
      /#\d{3,6}\b/,
      /\b[0-9a-f]{9,40}\b/,
      /\b(?:fix|feat|docs|refactor|chore|salvage|ent)\/[\w./-]{3,60}/,
      /\b[\w./-]+\/[\w.-]+\.(?:py|ts|tsx|js|rs|md|yaml|yml|json|toml|sh)\b/,
      /\b(?:[A-Z][a-zA-Z]*Error|Exception|ENOSPC|EACCES|SIGKILL|Traceback)\b/,
      /@[A-Za-z0-9-]{3,30}\b/,
      /https?:\/\//,
    ];
    for (let i = 0; i < COMPRESS_FILLER_TURNS; i++) {
      const p = compressFillerPrompt(i);
      for (const re of anchorPatterns) expect(p).not.toMatch(re);
    }
  });

  test("AC-2 filler prompts are deterministic and generated offline", () => {
    // CI never calls a real LLM: the paste is computed locally, so the same
    // turn must render byte-identical on every run and on the stub leg.
    for (let i = 0; i < COMPRESS_FILLER_TURNS; i++)
      expect(compressFillerPrompt(i)).toBe(compressFillerPrompt(i));
  });
});
