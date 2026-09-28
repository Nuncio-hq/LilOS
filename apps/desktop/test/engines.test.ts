import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUNDLE_EXECUTABLES,
  type EngineBundlePlan,
  engineBundlePlan,
} from "../scripts/engines";

/**
 * Issue #85 — what the DMG ships. `sign-local.sh`/`release.yml` pass a
 * signing identity for release builds and `-` for ad-hoc dev builds; the
 * engine plan is derived from that one input.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const SIGNED = "Developer ID Application: Example Dev";

describe("AC-1 (#85) a signed bundle ships the real engine only", () => {
  const plan = engineBundlePlan(SIGNED);

  it("compiles lilos-engine-nous and no fake", () => {
    expect(plan.binaries.map((b) => b.outfile)).toEqual([
      "lilos-engine-nous",
    ]);
  });

  it("stamps hermes as the harness engine default", () => {
    expect(plan.defaultEngine).toBe("hermes");
  });

  it("--engine=hermes produces the same release plan (#141)", () => {
    expect(engineBundlePlan(SIGNED, "hermes")).toEqual(plan);
  });
});

describe("AC-4 (#85/#141) a dev bundle keeps the fake engine explicit", () => {
  const plan = engineBundlePlan("-");

  it("ships both engine binaries", () => {
    expect(plan.binaries.map((b) => b.outfile).sort()).toEqual([
      "lilos-engine-fake",
      "lilos-engine-nous",
    ]);
  });

  it("stamps fake as the harness engine default so the build is labeled", () => {
    expect(plan.defaultEngine).toBe("fake");
  });

  it("--engine=fake produces the same dev plan (#141 AC-3)", () => {
    expect(engineBundlePlan("-", "fake")).toEqual(plan);
  });
});

describe("AC-1 (#141) an ad-hoc bundle can opt into real Hermes", () => {
  const plan = engineBundlePlan("-", "hermes");

  it("still ships both engine binaries (dev bundle, not a release)", () => {
    expect(plan.binaries.map((b) => b.outfile).sort()).toEqual([
      "lilos-engine-fake",
      "lilos-engine-nous",
    ]);
  });

  it("stamps hermes as the harness engine default", () => {
    expect(plan.defaultEngine).toBe("hermes");
  });
});

describe("AC-4 (#141) --engine=fake on a signed build is an error", () => {
  it("rejects with a plain message, not a bundle", () => {
    expect(() => engineBundlePlan(SIGNED, "fake")).toThrow(
      /--engine=fake .*ad-hoc|ad-hoc .*--engine=fake|signed .*fake|fake .*signed/i,
    );
  });
});

describe("MDM kill-by-name guard (#141)", () => {
  /* Managed Macs (e.g. Oscar's work Mac, CrowdStrike/Jamf) SIGKILL any
     executable whose file name contains "hermes" — case-insensitive, in any
     directory, signed or ad-hoc. No executable the build ships may carry
     that substring in its basename, or the engine dies before ready. */
  const shipped = (plan: EngineBundlePlan) => [
    "LilOS", // the Electron binary, renamed at assemble time
    ...BUNDLE_EXECUTABLES,
    ...plan.binaries.map((b) => b.outfile),
  ];

  it.each([
    ["signed", engineBundlePlan(SIGNED)],
    ["dev", engineBundlePlan("-")],
    ["dev --engine=hermes", engineBundlePlan("-", "hermes")],
  ])("the %s bundle ships no executable named *hermes*", (_label, plan) => {
    for (const name of shipped(plan)) {
      expect(name).not.toMatch(/hermes/i);
    }
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
