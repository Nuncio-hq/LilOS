import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";

/**
 * Leak watchdog (#84 for engine-fake, #96 for surfaces-demo): stacks tag
 * their children — engine-fake via LILOS_ENGINE_TAG landing `--tag <tag>` in
 * argv, surfaces-demo via a `--tag <tag>` flag plus a matching
 * `--lilos-demo-tag=<tag>` injected into the headless Chromium's argv —
 * then teardown pgreps the marker and asserts nothing outlived its stack,
 * like the ~200 engine + 49 demo orphans seen on Oscar's Mac.
 */

/** Registry the runner-wide globalTeardown sweeps (#347). */
const LEAK_WATCH_DIR = join(process.cwd(), "test-results", "leak-watch");

export function engineTag(prefix: string): string {
  const tag = `${prefix}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  // Record the owning worker so a runner teardown can kill only tags whose
  // owner is gone — never a sibling run's still-alive stack.
  try {
    mkdirSync(LEAK_WATCH_DIR, { recursive: true });
    writeFileSync(
      join(LEAK_WATCH_DIR, `${tag}.json`),
      JSON.stringify({ tag, owner: process.pid }),
    );
  } catch {
    // registration best-effort: the spec-level assertions still apply
  }
  return tag;
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Runner teardown sweep (#347): SIGKILL every tagged leftover whose owning
 * worker is dead, then drop this run's registry files. A tag whose owner is
 * still alive belongs to a sibling session's stack — hands off.
 */
export function sweepOrphanedLeakTags(): void {
  let files: string[];
  try {
    files = readdirSync(LEAK_WATCH_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const f of files) {
    let owner = 0;
    try {
      owner = (
        JSON.parse(readFileSync(join(LEAK_WATCH_DIR, f), "utf8")) as {
          owner: number;
        }
      ).owner;
    } catch {
      continue; // corrupt entry — leave it; a stale registry file is harmless
    }
    if (pidAlive(owner)) continue;
    const tag = f.slice(0, -5);
    killTagged(tag);
    rmSync(join(LEAK_WATCH_DIR, f), { force: true });
  }
}

/** PIDs whose argv contains the tag as `--tag <tag>` or `=<tag>`. */
export function taggedPids(tag: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", `tag[ =]${tag}`], { encoding: "utf8" })
      .split("\n")
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n !== process.pid);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

/**
 * SIGKILL every process still carrying the tag. A failure sweep only — call
 * it after an assertion failed so the suite never leaves orphans; calling it
 * before `expectNoLeak` would hide the leak it is meant to catch.
 */
export function killTagged(tag: string): void {
  for (const pid of taggedPids(tag)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Kill a spawned stack the way a crashing spec would: SIGKILL the child's
 * whole process group (reachable because the spec spawned `detached: true`,
 * so the child leads a group containing its Chromium) plus the child itself.
 * Never sweeps by tag — leftover tagged processes must fail `expectNoLeak`.
 */
export function killStack(pid: number | undefined): void {
  if (!pid) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // group or process already gone
    }
  }
}

/**
 * Teardown assertion: nothing tagged outlives its stack. Purely observes —
 * cleanup belongs to `killStack`/`killTagged`, or a leak can never trip this.
 */
export async function expectNoLeak(tag: string): Promise<void> {
  await expect.poll(() => taggedPids(tag), { timeout: 15_000 }).toEqual([]);
}

/** Teardown assertion: no engine survives its harness. */
export async function expectNoEngineLeak(tag: string): Promise<void> {
  await expectNoLeak(tag);
}

/**
 * Orphan watchdog for e2e stand-in parents (demo-parent.ts, stack-parent.ts)
 * — the same check as @lilos/background's watchOrphaned, inlined so a
 * `bun e2e/<script>.ts` process stays dependency-free. Exit when we are
 * reparented (our parent died) or when our parent gets reparented (the
 * worker past a `bun run` shim died).
 */
export function watchOrphanExit(intervalMs = 1_000): void {
  const parentPpid = (pid: number): number | null => {
    try {
      const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
      const n = Number.parseInt(out, 10);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  };
  const ppid0 = process.ppid;
  const gpid0 = ppid0 <= 1 ? null : parentPpid(ppid0);
  setInterval(() => {
    if (process.ppid !== ppid0) process.exit(0);
    if (gpid0 !== null && parentPpid(ppid0) !== gpid0) process.exit(0);
  }, intervalMs).unref();
}
