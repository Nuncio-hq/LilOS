import { execFileSync } from "node:child_process";
import { expect } from "@playwright/test";

/**
 * Engine-fake leak watchdog (#84): stacks set LILOS_ENGINE_TAG so the harness
 * lands `--tag <tag>` in the engine's argv; teardown pgreps that marker and
 * asserts the engine died with its stack instead of leaking like the ~200
 * orphans seen on Oscar's Mac.
 */
export function engineTag(prefix: string): string {
  return `${prefix}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

function taggedEnginePids(tag: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", `tag ${tag}`], { encoding: "utf8" })
      .split("\n")
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n));
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

/** Teardown assertion: no engine survives its harness. */
export async function expectNoEngineLeak(tag: string): Promise<void> {
  await expect
    .poll(() => taggedEnginePids(tag), { timeout: 15_000 })
    .toEqual([]);
}
