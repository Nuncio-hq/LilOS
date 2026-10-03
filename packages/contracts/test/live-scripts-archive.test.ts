import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #443 AC-2: one-off live checks for closed issues are archived under
 * tag `archive/live-scripts-2026-10` — none remain on main — and no tracked
 * file references a live-script path that is not there. Angle-bracket
 * placeholders (`scripts/live/<file>`) and `*` globs are not references.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SELF = "packages/contracts/test/live-scripts-archive.test.ts";
const has = (p: string) => existsSync(join(ROOT, p));

const trackedFiles = () =>
  execSync("git ls-files", { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

/** Every live script whose issue is closed (all 50 issues were verified
 * CLOSED on GitHub for #443) — they live only on the archive tag now. */
const ARCHIVED = [
  ...`105.sh 105.ts 107.sh 107.ts 108.sh 108.ts 113.sh 113.ts 114.sh 114.ts
      115.sh 123.sh 132.sh 132.ts 133-acp-always.mts 133-acp-always.sh
      134-rewind.sh 134-rewind.ts 137-auto-title.sh 137.ts 156.sh 156.ts
      157.sh 157.ts 158.sh 158.ts 159.sh 160-engine.ts 160.sh 160.ts
      161.sh 161.ts 180.sh 181.sh 182.sh 206.sh 232.sh 238.sh 238.ts
      246.sh 247.sh 247.ts 27.sh 288.sh 288.ts 30-model-picker.sh 300.sh
      300.ts 309.sh 309.ts 31.sh 31.ts 32.sh 327.sh 327.ts 33.sh 334.sh
      334.ts 337.mts 337.sh 339.mts 339.sh 34.sh 340.mts 340.sh 35.sh
      36.mts 36.sh 37-forge.sh 37-forge.ts 386.sh 386.ts 8.py 8.sh
      85-real-engine.sh 92-model-picker.sh 95.sh issue-26.sh issue-28.sh
      issue-29.sh`
    .split(/\s+/)
    .filter(Boolean)
    .map((f) => `scripts/live/${f}`),
  ...`live-159-prs.ts live-159-seed.ts live-180-plans.ts live-181-subagents.ts
      live-182-plans.ts live-30-model-picker.ts live-85-real-engine.ts
      live-92-model-picker.ts live-95-engine-reasons.ts`
    .split(/\s+/)
    .filter(Boolean)
    .map((f) => `apps/harness/scripts/${f}`),
];

describe("AC-2 no live script for a closed issue remains", () => {
  it("every archived script is absent from main", () => {
    for (const p of ARCHIVED) {
      expect(
        has(p),
        `${p} is still on main (restore: git show archive/live-scripts-2026-10:${p})`,
      ).toBe(false);
    }
  });

  it("the shared openai-stub helper and the dir README stay", () => {
    expect(has("scripts/live/openai-stub.ts")).toBe(true);
    expect(has("scripts/live/README.md")).toBe(true);
  });
});

describe("AC-2 no dangling live-script reference", () => {
  // `scripts/live/<file>` and `…/scripts/live-<file>` mentions must resolve.
  const ref = /scripts\/live[-/]([A-Za-z0-9][A-Za-z0-9._-]*)/g;

  it("every live-script path cited in a tracked file exists", () => {
    const tracked = new Set(trackedFiles());
    for (const file of tracked) {
      if (file === SELF) continue;
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const m of text.matchAll(ref)) {
        // `scripts/live/x` is the top-level dir; `scripts/live-x` appears in
        // any package (e.g. packages/engine-hermes/scripts/live-hermes.ts).
        const hit = m[0].startsWith("scripts/live/")
          ? tracked.has(m[0])
          : [...tracked].some((f) => f.endsWith(`/${m[0]}`));
        expect(
          hit,
          `${file} cites ${m[0]}, which is not on main — live checks for ` +
            `closed issues live on tag archive/live-scripts-2026-10`,
        ).toBe(true);
      }
    }
  });
});
