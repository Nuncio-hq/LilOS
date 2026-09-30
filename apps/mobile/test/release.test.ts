import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
    // appleTeamId is a submit-only key; eas-cli rejects it under build.
    expect(eas.build.production.ios.appleTeamId).toBeUndefined();
    expect(eas.submit.production.ios.appleTeamId).toBe("R8GJL3N9WX");
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

/**
 * Issue #268: the first real run on a bare VM broke on a missing `pod`, no
 * Apple ID signed into Xcode, `LILOS_XCARGS` never reaching `-exportArchive`,
 * and unmet fresh-VM basics. The script is exercised through --dry-run (which
 * prints the plan instead of building) and through stub binaries on PATH for
 * the real legs — never a real upload.
 */
const SCRIPT = join(ROOT, "scripts/release/testflight.sh");
const BUN_BIN = process.env.BUN ?? process.execPath;

const runRelease = (args: string[], env: Record<string, string> = {}) => {
  // A node-run vitest worker leaks NODE/npm_node_execpath=<node> into the
  // child env; `bun x` then honors the `#!/usr/bin/env node` shebang on expo
  // instead of substituting bun — unresolvable on the stub PATH. Drop them so
  // a node-run vitest doesn't poison the stubbed toolchain.
  const { NODE: _n, npm_node_execpath: _e, ...rest } = process.env;
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...rest, ...env },
  });
};

// The two xcodebuild invocations --dry-run prints under "=== plan".
const planLines = (out: string) =>
  out.split("\n").filter((l) => l.trimStart().startsWith("xcodebuild "));

const stubBin = (scripts: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "lilos-stub-"));
  for (const [name, body] of Object.entries(scripts)) {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  }
  return dir;
};

// A `bun` stub that forwards to the real binary, so tests can run the script
// with a minimal PATH (no brew/pod in sight) without losing bun itself.
const BUN_STUB = { bun: `exec "${BUN_BIN}" "$@"` };
const MIN_PATH = (stub: string) => `${stub}:/usr/bin:/bin`;

const ASC_ENV = {
  ASC_KEY_ID: "TESTKEY123",
  ASC_ISSUER_ID: "ISSUER-UUID",
  ASC_KEY_P8: "-----BEGIN PRIVATE KEY-----\\nFAKE\\n-----END PRIVATE KEY-----",
};
const NO_ASC = { ASC_KEY_ID: "", ASC_ISSUER_ID: "", ASC_KEY_P8: "" };

// A healthy active Xcode: -showsdks advertises an iphoneos SDK (the platform
// component is downloaded), and xcrun reports <version> for it.
const XCODEBUILD_OK = `if [ "$1" = "-showsdks" ]; then echo "iOS 26.5 -sdk iphoneos26.5"; fi\nexit 0`;
const toolchain = (version: string) => ({
  xcodebuild: XCODEBUILD_OK,
  xcrun: `if [ "$1" = "--sdk" ]; then echo "${version}"; fi\nexit 0`,
});

describe("#268 a bare VM ships with zero manual steps", () => {
  it("builds -authenticationKey* flags from the ASC secrets on BOTH xcodebuilds", () => {
    const r = runRelease(["--dry-run"], {
      LILOS_BUILD_NUMBER: "42",
      ...ASC_ENV,
    });
    expect(r.status).toBe(0);
    const lines = planLines(r.stdout);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("archive");
    expect(lines[1]).toContain("-exportArchive");
    for (const l of lines) {
      expect(l).toContain("-authenticationKeyPath");
      expect(l).toContain("-authenticationKeyID TESTKEY123");
      expect(l).toContain("-authenticationKeyIssuerID ISSUER-UUID");
      expect(l).toContain("-allowProvisioningUpdates");
    }
  });

  it("forwards LILOS_XCARGS to BOTH the archive and -exportArchive legs", () => {
    const r = runRelease(["--dry-run"], {
      LILOS_BUILD_NUMBER: "42",
      ...NO_ASC,
      LILOS_XCARGS: "MARKER_FLAG=xyz CODE_SIGN_STYLE=Manual",
    });
    expect(r.status).toBe(0);
    const lines = planLines(r.stdout);
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toContain("MARKER_FLAG=xyz");
  });

  it("without ASC secrets the plan still works, minus the auth flags", () => {
    const r = runRelease(["--dry-run"], {
      LILOS_BUILD_NUMBER: "42",
      ...NO_ASC,
    });
    expect(r.status).toBe(0);
    for (const l of planLines(r.stdout)) {
      expect(l).not.toContain("-authenticationKeyPath");
      expect(l).toContain("-allowProvisioningUpdates");
    }
  });

  it("FAILs with the remedy when bun is missing", () => {
    const r = runRelease([], {
      HOME: mkdtempSync(join(tmpdir(), "lilos-nohome-")),
      PATH: "/usr/bin:/bin",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("bun not on PATH");
    expect(r.stderr).toContain("npm i -g bun");
  });

  it("dry-run still prints the plan when bun is missing", () => {
    const r = runRelease(["--dry-run"], {
      HOME: mkdtempSync(join(tmpdir(), "lilos-nohome-")),
      PATH: "/usr/bin:/bin",
      LILOS_BUILD_NUMBER: "42",
      ...NO_ASC,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("bun not on PATH");
    expect(planLines(r.stdout)).toHaveLength(2);
  });

  it("FAILs naming 'brew install cocoapods' when pod and brew are missing", () => {
    const stub = stubBin({ ...BUN_STUB, xcodebuild: XCODEBUILD_OK });
    try {
      const r = runRelease([], {
        PATH: MIN_PATH(stub),
        ...NO_ASC,
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("brew install cocoapods");
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });

  it("WARNs on a missing pod in --dry-run without installing", () => {
    const stub = stubBin({ ...BUN_STUB, xcodebuild: XCODEBUILD_OK });
    try {
      const r = runRelease(["--dry-run"], {
        PATH: MIN_PATH(stub),
        LILOS_BUILD_NUMBER: "42",
        ...NO_ASC,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("WARN: pod");
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });

  // The full happy path on a stubbed bare VM: brew installs pod, both
  // xcodebuilds run with the ASC auth flags + LILOS_XCARGS, the .ipa lands.
  // Darwin-only: the app.json stamp uses BSD `sed -i ''`.
  it.runIf(process.platform === "darwin")(
    "auto-installs pod and reaches done on a stubbed bare VM",
    () => {
      const stub = stubBin({
        ...BUN_STUB,
        // fake brew: `brew install cocoapods` drops a `pod` stub on PATH
        brew: 'if [ "$1" = "install" ] && [ "$2" = "cocoapods" ]; then\n  printf "#!/bin/sh\\nexit 0\\n" > "$(dirname "$0")/pod"\n  chmod +x "$(dirname "$0")/pod"\nfi\nexit 0',
        bunx: "exit 0",
        xcrun: "exit 0",
        // Preflight probes (-showsdks/-downloadPlatform) are not build legs —
        // don't log them; -showsdks must advertise a present iphoneos SDK.
        xcodebuild: `[ "$1" = "-showsdks" ] && { echo "iOS 26.5 -sdk iphoneos26.5"; exit 0; }
[ "$1" = "-downloadPlatform" ] && exit 0
echo "xcodebuild $*" >> "$LILOS_STUB_LOG"
prev=""; out=""
for a in "$@"; do [ "$prev" = "-exportPath" ] && out="$a"; prev="$a"; done
case " $* " in *" -exportArchive "*) mkdir -p "$out"; touch "$out/LilOS.ipa";; esac
exit 0`,
      });
      const log = join(stub, "xcodebuild.log");
      const appJsonBefore = read("apps/mobile/app.json");
      try {
        const r = runRelease([], {
          PATH: MIN_PATH(stub),
          LILOS_BUILD_NUMBER: JSON.parse(appJsonBefore).expo.ios.buildNumber,
          LILOS_SKIP_UPLOAD: "1",
          LILOS_XCARGS: "MARKER_FLAG=xyz",
          LILOS_STUB_LOG: log,
          ...ASC_ENV,
        });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("auto-installing: brew install cocoapods");
        expect(r.stdout).toContain("=== done");
        const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
        expect(calls).toHaveLength(2);
        for (const c of calls) {
          expect(c).toContain("-authenticationKeyID TESTKEY123");
          expect(c).toContain("MARKER_FLAG=xyz");
        }
      } finally {
        writeFileSync(join(ROOT, "apps/mobile/app.json"), appJsonBefore);
        rmSync(stub, { recursive: true, force: true });
        rmSync(join(ROOT, "apps/mobile/dist"), {
          recursive: true,
          force: true,
        });
      }
    },
  );
});

/**
 * Issue #276: an archive built against the iOS 27 SDK is killed at launch
 * until UIScene lifecycle adoption lands (#275), so preflight must refuse to
 * build on it — FAIL in a real run, WARN under --dry-run (the miss()
 * convention). Tests stub `xcrun --sdk iphoneos --show-sdk-version`.
 */

describe("#276 preflight refuses an iOS-27-SDK build", () => {
  it("FAILs naming the UIScene issue when the active iOS SDK is 27", () => {
    const stub = stubBin({
      ...BUN_STUB,
      ...toolchain("27.0"),
    });
    try {
      const r = runRelease([], { PATH: MIN_PATH(stub), ...NO_ASC });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("UIScene");
      expect(r.stderr).toContain("#275");
      expect(r.stderr).toContain("Xcode 26");
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });

  it("WARNs (not FAILs) on iOS SDK 27 in --dry-run and still prints the plan", () => {
    const stub = stubBin({
      ...BUN_STUB,
      ...toolchain("27.1"),
    });
    try {
      const r = runRelease(["--dry-run"], {
        PATH: MIN_PATH(stub),
        LILOS_BUILD_NUMBER: "42",
        ...NO_ASC,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("WARN: iOS SDK 27.1");
      expect(r.stdout).toContain("UIScene");
      expect(planLines(r.stdout)).toHaveLength(2);
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });

  it("passes preflight when the active iOS SDK is 26", () => {
    const stub = stubBin({
      ...BUN_STUB,
      ...toolchain("26.6"),
    });
    try {
      const r = runRelease(["--dry-run"], {
        PATH: MIN_PATH(stub),
        LILOS_BUILD_NUMBER: "42",
        ...NO_ASC,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("iphoneos SDK: 26.6");
      expect(planLines(r.stdout)).toHaveLength(2);
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });

  it("downloads a missing iOS platform component in a real run", () => {
    // -showsdks advertises iphoneos only after -downloadPlatform ran (marker).
    const stub = stubBin({
      ...BUN_STUB,
      xcodebuild: `if [ "$1" = "-showsdks" ]; then
  [ -f "$(dirname "$0")/ios-platform" ] && echo "iOS 26.5 -sdk iphoneos26.5"
elif [ "$1" = "-downloadPlatform" ]; then
  touch "$(dirname "$0")/ios-platform"
fi
exit 0`,
      xcrun: 'if [ "$1" = "--sdk" ]; then echo "26.6"; fi\nexit 0',
      pod: "exit 0",
    });
    try {
      const r = runRelease([], { PATH: MIN_PATH(stub), ...NO_ASC });
      expect(r.stdout).toContain("xcodebuild -downloadPlatform iOS");
      expect(existsSync(join(stub, "ios-platform"))).toBe(true);
      expect(r.stdout).toContain("iphoneos SDK: 26.6");
      // Dies later on the missing ASC secrets — past both iOS checks.
      expect(r.stderr).toContain("ASC_KEY_ID is required");
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });

  it("WARNs with the download command in --dry-run without downloading", () => {
    const stub = stubBin({
      ...BUN_STUB,
      xcodebuild: `if [ "$1" = "-downloadPlatform" ]; then touch "$(dirname "$0")/downloaded"; fi\nexit 0`,
      xcrun: 'if [ "$1" = "--sdk" ]; then echo "26.6"; fi\nexit 0',
    });
    try {
      const r = runRelease(["--dry-run"], {
        PATH: MIN_PATH(stub),
        LILOS_BUILD_NUMBER: "42",
        ...NO_ASC,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("WARN:");
      expect(r.stdout).toContain("xcodebuild -downloadPlatform iOS");
      expect(existsSync(join(stub, "downloaded"))).toBe(false);
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });
});
