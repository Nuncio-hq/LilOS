import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateFeed } from "@lilos/contracts/app";
import { describe, expect, test } from "vitest";
import { renderApplyScript } from "../src/update/apply";
import { type SignatureInfo, signatureBlock } from "../src/update/codesign";
import { pickUpdate, resolveFeedUrl } from "../src/update/feed";
import {
  addSkippedBuild,
  type PendingUpdate,
  readSkippedBuilds,
  settlePendingUpdate,
  updatePaths,
  writeJson,
} from "../src/update/state";

const darwin = process.platform === "darwin";
const DEAD_PID = 999_999; // beyond macOS pid_max — never alive in tests

/** A minimal fake `.app` bundle: a directory tree with an executable. */
function fakeApp(dir: string, name: string, body: string): string {
  const app = join(dir, `${name}.app`);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), "<plist />");
  const bin = join(app, "Contents", "MacOS", name);
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  return app;
}

function runApply(dir: string, script: string): void {
  const sh = join(dir, "apply.sh");
  writeFileSync(sh, script);
  chmodSync(sh, 0o755);
  execFileSync("bash", [sh], { timeout: 30_000, encoding: "utf8" });
}

describe("update feed", () => {
  test("AC-3 picks a newer build and skips skipped/equal builds", () => {
    const rel = {
      version: "1.0.4",
      build: 4,
      url: "u",
      sha256: "a".repeat(64),
    };
    expect(pickUpdate(rel, 3, [])).toBe(rel);
    expect(pickUpdate(rel, 4, [])).toBeUndefined();
    expect(pickUpdate(rel, 5, [])).toBeUndefined();
    expect(pickUpdate(rel, 3, [4])).toBeUndefined();
  });

  test("AC-3 feed URL: env override, off disables, else the default feed", () => {
    expect(resolveFeedUrl({})).toContain("update-feed.json");
    expect(resolveFeedUrl({ LILOS_UPDATE_URL: "http://x/feed.json" })).toBe(
      "http://x/feed.json",
    );
    expect(resolveFeedUrl({ LILOS_UPDATE_URL: "off" })).toBeUndefined();
  });

  test("AC-3 UpdateFeed schema rejects a feed with no checksum", () => {
    expect(() =>
      UpdateFeed.parse({
        latest: { version: "1.0.4", build: 4, url: "u" },
      }),
    ).toThrow();
  });

  test("AC-3 a signed app never accepts an unsigned or foreign update", () => {
    const dev: SignatureInfo = { verified: true, adhoc: true };
    const apple: SignatureInfo = {
      verified: true,
      adhoc: false,
      teamId: "R8GJL3N9VX",
    };
    const otherTeam: SignatureInfo = {
      verified: true,
      adhoc: false,
      teamId: "ZZZZZZZZZZ",
    };
    const broken: SignatureInfo = { verified: false, adhoc: false };
    expect(signatureBlock(dev, dev)).toBeUndefined();
    expect(signatureBlock(dev, apple)).toBeUndefined();
    expect(signatureBlock(apple, apple)).toBeUndefined();
    expect(signatureBlock(apple, dev)).toContain("unsigned");
    expect(signatureBlock(apple, otherTeam)).toContain("team");
    expect(signatureBlock(dev, broken)).toContain("verify");
  });
});

describe("apply script", () => {
  test("AC-3 apply script swaps staged bundle in and launches it", () => {
    const dir = mkdtempSync(join(tmpdir(), "lilos-up-"));
    const paths = updatePaths(dir);
    const script = renderApplyScript({
      installPath: "/Applications/LilOS.app",
      stagedApp: join(dir, "staging", "LilOS.app"),
      rollbackApp: paths.rollbackApp,
      bootOkFile: paths.bootOkFile,
      statusFile: paths.statusFile,
      pendingFile: paths.pendingFile,
      oldPid: DEAD_PID,
      logFile: paths.logFile,
    });
    expect(script).toContain('mv "$APP" "$ROLLBACK"');
    expect(script).toContain('mv "$STAGED" "$APP"');
    expect(script).toContain('"$APP/Contents/MacOS/LilOS"');
    expect(script).toContain("BOOT_OK");
  });

  test("AC-3 apply script really swaps and relaunches a healthy update", {
    skip: !darwin,
    timeout: 20_000,
  }, () => {
    const dir = mkdtempSync(join(tmpdir(), "lilos-up-"));
    const paths = updatePaths(dir);
    mkdirSync(paths.root, { recursive: true });
    const old = fakeApp(dir, "LilOS", "#!/bin/bash\nexit 0\n");
    const staged = fakeApp(
      mkdtempSync(join(tmpdir(), "lilos-stage-")),
      "LilOS",
      `#!/bin/bash\ntouch "${paths.bootOkFile}"\nexit 0\n`,
    );
    runApply(
      dir,
      renderApplyScript({
        installPath: old,
        stagedApp: staged,
        rollbackApp: paths.rollbackApp,
        bootOkFile: paths.bootOkFile,
        statusFile: paths.statusFile,
        pendingFile: paths.pendingFile,
        oldPid: DEAD_PID,
        logFile: paths.logFile,
      }),
    );
    // staged app now at install path; old app parked; boot-ok written.
    // (the relaunched process is async — the assert only reads files the
    // applier itself writes, so no wait needed)
    expect(existsSync(paths.bootOkFile)).toBe(true);
    expect(
      readFileSync(join(old, "Contents", "MacOS", "LilOS"), "utf8"),
    ).toContain("boot-ok");
    expect(
      existsSync(join(paths.rollbackApp, "Contents", "MacOS", "LilOS")),
    ).toBe(true);
    const status = JSON.parse(readFileSync(paths.statusFile, "utf8"));
    expect(status.phase).toBe("updated");
  });

  test("AC-4 rollback: a new app that never writes boot-ok is reverted", {
    skip: !darwin,
    timeout: 20_000,
  }, () => {
    const dir = mkdtempSync(join(tmpdir(), "lilos-rb-"));
    const paths = updatePaths(dir);
    mkdirSync(paths.root, { recursive: true });
    const oldBody = `#!/bin/bash\ntouch "${join(dir, "old-ran")}"\nexit 0\n`;
    const old = fakeApp(dir, "LilOS", oldBody);
    const staged = fakeApp(
      mkdtempSync(join(tmpdir(), "lilos-stage-")),
      "LilOS",
      "#!/bin/bash\nexit 1\n",
    );
    runApply(
      dir,
      renderApplyScript({
        installPath: old,
        stagedApp: staged,
        rollbackApp: paths.rollbackApp,
        bootOkFile: paths.bootOkFile,
        statusFile: paths.statusFile,
        pendingFile: paths.pendingFile,
        oldPid: DEAD_PID,
        logFile: paths.logFile,
        bootWaitSeconds: 3,
      }),
    );
    // Old app restored at the install path and relaunched; bad build junked.
    expect(readFileSync(join(old, "Contents", "MacOS", "LilOS"), "utf8")).toBe(
      oldBody,
    );
    // the relaunch is async — poll briefly
    for (let i = 0; i < 50 && !existsSync(join(dir, "old-ran")); i++) {
      execFileSync("sleep", ["0.1"]);
    }
    expect(existsSync(join(dir, "old-ran"))).toBe(true);
    const status = JSON.parse(readFileSync(paths.statusFile, "utf8"));
    expect(status.phase).toBe("rolled-back");
  });
});

describe("boot settle", () => {
  const pending = (dir: string, over: Partial<PendingUpdate> = {}) =>
    writeJson(updatePaths(dir).pendingFile, {
      build: 4,
      version: "1.0.4",
      installPath: "/Applications/LilOS.app",
      stagedApp: "/x/LilOS.app",
      ...over,
    });

  test("AC-3 new app writes boot-ok only after the version handshake passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lilos-settle-"));
    mkdirSync(updatePaths(dir).root, { recursive: true });
    pending(dir);
    const r = await settlePendingUpdate(dir, "1.0.4", async () => true);
    expect(r).toBe("settled");
    expect(existsSync(updatePaths(dir).bootOkFile)).toBe(true);
    expect(existsSync(updatePaths(dir).pendingFile)).toBe(false);
  });

  test("AC-4 failed handshake leaves no boot-ok and reports failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lilos-settle-"));
    mkdirSync(updatePaths(dir).root, { recursive: true });
    pending(dir);
    const r = await settlePendingUpdate(dir, "1.0.4", async () => false);
    expect(r).toBe("failed");
    expect(existsSync(updatePaths(dir).bootOkFile)).toBe(false);
  });

  test("AC-4 rolled-back old app marks the bad build skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lilos-settle-"));
    mkdirSync(updatePaths(dir).root, { recursive: true });
    pending(dir);
    const r = await settlePendingUpdate(dir, "1.0.3", async () => {
      throw new Error("must not run");
    });
    expect(r).toBe("rolled-back");
    expect(readSkippedBuilds(dir)).toContain(4);
  });

  test("AC-4 nothing pending is a plain boot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lilos-settle-"));
    const r = await settlePendingUpdate(dir, "1.0.4", async () => {
      throw new Error("must not run");
    });
    expect(r).toBe("none");
  });

  test("AC-4 skipped builds persist without duplicates", () => {
    const dir = mkdtempSync(join(tmpdir(), "lilos-settle-"));
    addSkippedBuild(dir, 7);
    addSkippedBuild(dir, 7);
    expect(readSkippedBuilds(dir)).toEqual([7]);
  });
});
