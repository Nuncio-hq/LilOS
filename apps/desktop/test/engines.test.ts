import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { engineBundlePlan } from "../scripts/engines";

/**
 * Issue #85 — what the DMG ships. `sign-local.sh`/`release.yml` pass a
 * signing identity for release builds and `-` for ad-hoc dev builds; the
 * engine plan is derived from that one input.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("AC-1 (#85) a signed bundle ships the real engine only", () => {
  const plan = engineBundlePlan("Developer ID Application: Example Dev");

  it("compiles lilos-engine-hermes and no fake", () => {
    expect(plan.binaries.map((b) => b.outfile)).toEqual([
      "lilos-engine-hermes",
    ]);
  });

  it("stamps hermes as the harness engine default", () => {
    expect(plan.defaultEngine).toBe("hermes");
  });
});

describe("AC-4 (#85) a dev bundle keeps the fake engine explicit", () => {
  const plan = engineBundlePlan("-");

  it("ships both engine binaries", () => {
    expect(plan.binaries.map((b) => b.outfile).sort()).toEqual([
      "lilos-engine-fake",
      "lilos-engine-hermes",
    ]);
  });

  it("stamps fake as the harness engine default so the build is labeled", () => {
    expect(plan.defaultEngine).toBe("fake");
  });
});

describe("AC-5 (#85) the decision is on record", () => {
  const doc = readFileSync(join(REPO, "docs", "DECISIONS.md"), "utf8");

  it("DECISIONS.md records release=real engine, fake=test/dev", () => {
    expect(doc).toMatch(/\*\*D-#85[^\n]*real engine[^\n]*fake[^\n]*/i);
  });

  it("…with the rejected alternative (a fake default in release)", () => {
    expect(doc).toMatch(/D-#85[\s\S]*?Not:[^\n]*fake[^\n]*release/i);
  });
});
