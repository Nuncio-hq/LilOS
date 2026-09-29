import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `bun run app:local` — issue #141: one command from a fresh `git pull` to a
 * running LilOS on real Hermes, for Macs that cannot install the DMG.
 *
 *   1. build dist/LilOS.app ad-hoc with `--engine=hermes` (stamps
 *      LILOS_ENGINE_DEFAULT=hermes — no plist edits, no fake default),
 *   2. quit a running LilOS,
 *   3. swap it into `~/Applications/LilOS.app` (build to a temp dir, then
 *      rename — the old bundle is moved aside first, never `/Applications`
 *      and never a DMG),
 *   4. relaunch, so the new relay/harness binaries are the ones running.
 *
 * The build number is a per-run timestamp, so `app.getVersion()` always
 * differs from the stored service pins and lilos-svc's stale-pin rule
 * re-registers the launch agents at the new bundle (AC-2: no stale harness).
 * `~/.lilos` (relay DB, employees, DMs) and Application Support are left
 * untouched — the new app opens on the existing company.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..", "..");
const BUILT_APP = join(ROOT, "dist", "LilOS.app");
const APPS_DIR = join(homedir(), "Applications");
const TARGET = join(APPS_DIR, "LilOS.app");

if (process.platform !== "darwin") {
  console.error(
    "app:local is macOS-only — the dev bundle needs launchd + codesign.",
  );
  process.exit(1);
}

const run = (cmd: string, args: string[]) => {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: REPO });
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const git = (args: string[]) =>
  (spawnSync("git", args, { cwd: REPO, encoding: "utf8" }).stdout ?? "").trim();

const sha = git(["rev-parse", "--short", "HEAD"]);
// Per-run build number: every install carries a new version, so the
// stale-pin rule (D-#34) always re-registers the agents — never a stale
// harness from a previous bundle. Also far above any release build number,
// so the update feed can never "upgrade" a local install.
const VERSION = String(Math.floor(Date.now() / 1000));

console.log(
  `==> build ad-hoc LilOS.app v1.0.${VERSION} (${sha}) --engine=hermes`,
);
run("bun", [
  join(ROOT, "scripts", "build.ts"),
  VERSION,
  "-",
  "--engine=hermes",
]);

console.log("==> quit a running LilOS (graceful, then wait)");
if (spawnSync("pgrep", ["-x", "LilOS"]).status === 0) {
  spawnSync("osascript", ["-e", 'tell application "LilOS" to quit']);
  for (
    let i = 0;
    i < 100 && spawnSync("pgrep", ["-x", "LilOS"]).status === 0;
    i++
  ) {
    await sleep(100);
  }
  if (spawnSync("pgrep", ["-x", "LilOS"]).status === 0) {
    spawnSync("killall", ["LilOS"]);
  }
}

console.log(`==> install to ${TARGET}`);
mkdirSync(APPS_DIR, { recursive: true });
const staged = join(APPS_DIR, `.LilOS.new-${VERSION}.app`);
const previous = join(APPS_DIR, `.LilOS.old-${VERSION}.app`);
rmSync(staged, { recursive: true, force: true });
rmSync(previous, { recursive: true, force: true });
// ditto preserves framework symlinks verbatim (build.ts explains why).
run("ditto", [BUILT_APP, staged]);
if (existsSync(TARGET)) {
  // Rename keeps the old bundle whole until the new one is in place; the
  // agents' Program path stays valid across the swap.
  run("mv", [TARGET, previous]);
}
run("mv", [staged, TARGET]);
rmSync(previous, { recursive: true, force: true });

console.log("==> relaunch");
run("open", [TARGET]);

// The app registers relay + harness on launch; wait for the relay's health
// endpoint so the command ends on a running app, not a hope.
const deadline = Date.now() + 60_000;
for (;;) {
  const ok =
    spawnSync("curl", ["-fsS", "-m", "2", "http://127.0.0.1:4577/healthz"])
      .status === 0;
  if (ok) break;
  if (Date.now() > deadline) {
    console.warn(
      "!! relay did not answer /healthz in 60s — check `bun apps/desktop/scripts/probe-status.ts` and /tmp/com.nuncio.lilos.*.log",
    );
    break;
  }
  await sleep(1_000);
}

console.log(
  `done: LilOS 1.0.${VERSION} (${sha}) installed to ${TARGET} — real Hermes engine. ` +
    "Probe with `bun apps/desktop/scripts/probe-status.ts`; a DM leg: `bun apps/desktop/scripts/drive-turn.ts open` + `messages`.",
);
