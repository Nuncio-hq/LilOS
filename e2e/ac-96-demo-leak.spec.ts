import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  engineTag,
  expectNoLeak,
  killStack,
  killTagged,
  taggedPids,
} from "./engine-leak";

/**
 * Issue #96 — a surfaces-demo stack must die with the test that spawned it.
 * `demo-parent.ts` plays the Playwright worker (it spawns the demo holding
 * its stdin pipe open, drives one real `browser_open` so the headless
 * Chromium exists, then idles). Each AC-1 test kills a side of the stack the
 * way a run can die — SIGKILLed worker, `demo?.kill()` SIGTERM, or SIGKILLed
 * demo — and `expectNoLeak` asserts no tagged process survives to launchd.
 * AC-3 pins the demo log to a spec temp dir so e2e never writes `~/.lilos`.
 */

const REPO = fileURLToPath(new URL("..", import.meta.url));
const BUN = existsSync(join(homedir(), ".bun/bin/bun"))
  ? join(homedir(), ".bun/bin/bun")
  : "bun";
const REAL_LILOS = join(homedir(), ".lilos");
const REAL_DEMO_LOG = join(REAL_LILOS, "harness-demo.log");

interface Proc {
  child: ChildProcess;
  out: string;
}

function spawnLogged(
  cmd: string[],
  env: Record<string, string>,
  cwd = REPO,
): Proc {
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const proc: Proc = { child, out: "" };
  child.stdout?.on("data", (d) => (proc.out += d));
  child.stderr?.on("data", (d) => (proc.out += d));
  return proc;
}

async function waitFor(proc: Proc, needle: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.out.includes(needle)) return;
    if (proc.child.exitCode !== null) {
      throw new Error(`process exited ${proc.child.exitCode}: ${proc.out}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for "${needle}": ${proc.out.slice(-800)}`);
}

/**
 * Spawn `e2e/demo-parent.ts` → it owns a tagged surfaces-demo with a live
 * Chromium. Resolves once PARENT_READY reports the demo pid and Chromium is
 * tagged in the process table (demo + parent + browser ≥ 3 pids).
 */
async function startDemoStack(tag: string) {
  const parent = spawn(BUN, ["e2e/demo-parent.ts", "--tag", tag], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let demoPid = 0;
  let buf = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`demo-parent never ready: ${buf}`)),
      60_000,
    );
    parent.stdout?.on("data", (d) => {
      buf += String(d);
      const m = /PARENT_READY (\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        demoPid = Number.parseInt(m[1], 10);
        resolve();
      }
    });
    parent.on("error", reject);
    parent.on("exit", (code) =>
      reject(new Error(`demo-parent exited ${code}: ${buf}`)),
    );
  });
  try {
    await expect
      .poll(() => taggedPids(tag).length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(3);
  } catch (e) {
    // A stack that never came up must still not outlive the spec.
    killStack(parent.pid);
    killTagged(tag);
    throw e;
  }
  return { parent, demoPid };
}

/** Cleanup that must not hide the assertion: sweep only after it ran. */
async function teardown(tag: string, pid?: number) {
  killStack(pid);
  try {
    await expectNoLeak(tag);
  } finally {
    killTagged(tag); // a failed assertion must still not orphan processes
  }
}

test.describe("AC-96 surfaces-demo dies with its spec", () => {
  test("AC-1a SIGKILL of the Playwright worker kills demo + Chromium", async () => {
    const tag = engineTag("ac96-kill");
    const { parent } = await startDemoStack(tag);
    // No handler runs on SIGKILL — the demo must notice its stdin EOF.
    parent.kill("SIGKILL");
    await teardown(tag, parent.pid);
  });

  test("AC-1b SIGTERM on the demo (the old demo?.kill() path) kills the stack", async () => {
    const tag = engineTag("ac96-term");
    const { parent, demoPid } = await startDemoStack(tag);
    // This is exactly what afterAll's demo?.kill() sent — the demo used to
    // swallow it because its PTY child ignored the signal.
    process.kill(demoPid, "SIGTERM");
    await teardown(tag, parent.pid);
  });

  test("AC-1c SIGKILL of the demo itself reaps Chromium", async () => {
    const tag = engineTag("ac96-demo9");
    const { parent, demoPid } = await startDemoStack(tag);
    process.kill(demoPid, "SIGKILL");
    await teardown(tag, parent.pid);
  });

  test("AC-2 the teardown assertion fails on a surviving tagged process", async () => {
    const tag = engineTag("ac96-none");
    await expectNoLeak(tag); // clean when nothing runs
    // A stray process carrying the tag in argv must trip the watchdog.
    const stray = spawn("bash", ["-c", `exec -a 'x --tag ${tag}' sleep 30`]);
    let caught = false;
    try {
      await expectNoLeak(tag);
    } catch {
      caught = true;
    } finally {
      stray.kill("SIGKILL");
    }
    expect(caught, "expectNoLeak must fail on a tagged survivor").toBe(true);
  });

  test("AC-3 the demo log lands in the spec temp dir, never real ~/.lilos", async () => {
    const tag = engineTag("ac96-log");
    const dir = mkdtempSync(join(tmpdir(), "lilos-ac96-"));
    const logFile = join(dir, "harness-demo.log");
    const realLogBefore = existsSync(REAL_DEMO_LOG)
      ? readFileSync(REAL_DEMO_LOG, "utf8")
      : null;
    const realDirExisted = existsSync(REAL_LILOS);
    const harnesses: ChildProcess[] = [];
    try {
      // A real relay so the harness gets far enough to actually write lines.
      const relayHome = join(dir, "relay-home");
      mkdirSync(relayHome, { recursive: true });
      const relay = spawnLogged([BUN, join(REPO, "apps/relay/src/index.ts")], {
        LILOS_RELAY_HOME: relayHome,
        LILOS_RELAY_PORT: "0",
      });
      harnesses.push(relay.child);
      await waitFor(relay, "listening on http://");
      const port = /http:\/\/127\.0\.0\.1:(\d+)/.exec(relay.out)?.[1];
      if (!port) throw new Error(`no relay port in output: ${relay.out}`);
      const token = readFileSync(join(relayHome, "relay-token"), "utf8").trim();

      const harness = spawnLogged(
        [BUN, join(REPO, "apps/harness/scripts/demo-status.ts")],
        {
          LILOS_RELAY_URL: `ws://127.0.0.1:${port}/ws`,
          LILOS_RELAY_TOKEN: token,
          LILOS_ENGINE: "fake",
          LILOS_DEMO_SESSIONS: "0",
          LILOS_DEMO_LOG: logFile,
          LILOS_ENGINE_TAG: tag,
        },
      );
      harnesses.push(harness.child);
      await expect
        .poll(
          () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : ""),
          { timeout: 20_000 },
        )
        .toContain("registered with relay");
    } finally {
      for (const c of harnesses) c.kill("SIGKILL");
      killTagged(tag);
      rmSync(dir, { recursive: true, force: true });
    }
    // The real home stays untouched: neither the file nor its directory.
    expect(existsSync(REAL_LILOS)).toBe(realDirExisted);
    if (realLogBefore !== null) {
      expect(readFileSync(REAL_DEMO_LOG, "utf8")).toBe(realLogBefore);
    } else {
      expect(existsSync(REAL_DEMO_LOG)).toBe(false);
    }
  });
});
