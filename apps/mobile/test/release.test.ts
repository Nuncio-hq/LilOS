import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatVersionLabel } from "../src/version-label";

/**
 * Issue #250: one command ships a TestFlight build with an auto-derived build
 * number, and the phone shows which build it runs. Script + config + docs are
 * repo state a later change could undo — repo tests like the hygiene ones.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const has = (p: string) => existsSync(join(ROOT, p));

describe("AC-1 bun run mobile:release ships a build with an auto build number", () => {
  it("the root package exposes mobile:release -> scripts/release/testflight.sh", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["mobile:release"]).toBeTruthy();
    expect(pkg.scripts["mobile:release"]).toContain(
      "scripts/release/testflight.sh",
    );
  });

  it("the release script exists, is executable and builds -> exports -> uploads", () => {
    const script = "scripts/release/testflight.sh";
    expect(has(script)).toBe(true);
    expect(statSync(join(ROOT, script)).mode & 0o111).toBeGreaterThan(0);
    const text = read(script);
    expect(text).toContain("xcodebuild");
    expect(text).toContain("archive");
    expect(text).toContain("-exportArchive");
    expect(text).toContain("altool");
    expect(text).toContain("--upload-app");
  });

  it("the build number comes from App Store Connect latest + 1 (no hand edits)", () => {
    expect(has("scripts/release/asc-build-number.ts")).toBe(true);
    const out = (latest: string) =>
      spawnSync(
        process.env.BUN ?? "bun",
        [join(ROOT, "scripts/release/asc-build-number.ts"), "--next", latest],
        { encoding: "utf8" },
      ).stdout.trim();
    expect(out("5")).toBe("6");
    expect(out("41")).toBe("42");
    // Non-integer latest (e.g. "1.0.9") bumps the trailing number, never collides.
    expect(out("1.0.9")).toBe("1.0.10");
  });

  it("eas.json keeps the store production profile (team + ASC app id)", () => {
    const eas = JSON.parse(read("apps/mobile/eas.json"));
    expect(eas.build.production.ios.appleTeamId).toBe("R8GJL3N9WX");
    expect(eas.submit.production.ios.ascAppId).toBe("6816892244");
  });
});

describe("AC-2 optional tag workflow runs the same release on mobile-v*", () => {
  it("a mobile-release workflow ships on tags with EXPO_TOKEN documented", () => {
    expect(has(".github/workflows/mobile-release.yml")).toBe(true);
    const wf = read(".github/workflows/mobile-release.yml");
    expect(wf).toContain("mobile-v*");
    expect(wf).toContain("EXPO_TOKEN");
  });
});

describe("AC-3 Settings shows LilOS <version> (build N) from the real bundle", () => {
  it("formatVersionLabel renders version (build N), tolerating a missing build", () => {
    expect(formatVersionLabel("0.1.0", "6")).toBe("0.1.0 (build 6)");
    expect(formatVersionLabel("1.2.3", "42")).toBe("1.2.3 (build 42)");
    expect(formatVersionLabel("0.1.0")).toBe("0.1.0");
    expect(formatVersionLabel("0.1.0", "")).toBe("0.1.0");
  });

  it("the app passes its real bundle label into SettingsScreen", () => {
    const app = read("apps/mobile/src/App.tsx");
    expect(app).toContain("versionLabel");
    expect(app).toContain("SettingsScreen");
    const screen = read("packages/ui-native/src/app/settings-screen.tsx");
    expect(screen).toContain("About");
    expect(screen).toContain("versionLabel");
  });
});

describe("AC-4 the mobile README documents shipping a TestFlight build", () => {
  it("apps/mobile/README.md has the Ship a TestFlight build section", () => {
    expect(has("apps/mobile/README.md")).toBe(true);
    const text = read("apps/mobile/README.md");
    expect(text).toContain("Ship a TestFlight build");
    expect(text).toContain("bun run mobile:release");
    expect(/TestFlight/i.test(text)).toBe(true);
  });
});
