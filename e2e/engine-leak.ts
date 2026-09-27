import { execFileSync } from "node:child_process";
import { expect } from "@playwright/test";

/**
 * Leak watchdog (#84 for engine-fake, #96 for surfaces-demo): stacks tag
 * their children — engine-fake via LILOS_ENGINE_TAG landing `--tag <tag>` in
 * argv, surfaces-demo via a `--tag <tag>` flag plus a matching
 * `--lilos-demo-tag=<tag>` injected into the headless Chromium's argv —
 * then teardown pgreps the marker and asserts nothing outlived its stack,
 * like the ~200 engine + 49 demo orphans seen on Oscar's Mac.
 */
export function engineTag(prefix: string): string {
  return `${prefix}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
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
