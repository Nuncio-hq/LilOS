import { type ChildProcess, spawn } from "node:child_process";
import type { Logger } from "./log";

/**
 * Idle-sleep assertion — the #22 verdict (`caffeinate -i`-style): the harness
 * holds the assertion only while a turn is running so the Mac doesn't fall
 * asleep mid-turn, then releases it so the machine can idle again.
 */
export interface SleepGuard {
  /** Take the assertion (ref-counted). */
  acquire(): void;
  /** Release one acquisition; the OS assertion drops at zero. */
  release(): void;
  /** Whether an assertion is held right now. */
  readonly held: boolean;
}

export interface CaffeinateGuardOptions {
  /** spawn seam for tests; production uses node:child_process.spawn. */
  spawn?: typeof spawn;
}

/**
 * `caffeinate -i` prevents idle sleep for the life of the helper process;
 * `-w <harness pid>` ties it to this process so a harness crash can never
 * leave the Mac sleepless with zero turns running (AC-3).
 */
export function createCaffeinateGuard(
  log: Logger,
  options: CaffeinateGuardOptions = {},
): SleepGuard {
  const spawnImpl = options.spawn ?? spawn;
  const spawnFailed = new WeakSet<ChildProcess>();
  let count = 0;
  let proc: ChildProcess | undefined;
  const launch = () => {
    const p = spawnImpl("caffeinate", ["-i", "-w", String(process.pid)], {
      stdio: "ignore",
    });
    proc = p;
    p.on("exit", () => {
      if (proc === p) proc = undefined;
      // Still busy: re-assert, unless this child never started ('error' can
      // be followed by 'exit' — a respawn there would loop on non-darwin).
      if (count > 0 && !proc && !spawnFailed.has(p)) launch();
    });
    p.on("error", (error) => {
      spawnFailed.add(p);
      log.warn("caffeinate failed to start", { error: String(error) });
      if (proc === p) proc = undefined;
    });
    p.unref();
    log.debug("sleep assertion acquired");
  };
  const drop = () => {
    const p = proc;
    proc = undefined;
    try {
      p?.kill();
    } catch {
      // already gone
    }
  };
  return {
    acquire() {
      count += 1;
      if (!proc) launch();
    },
    release() {
      count = Math.max(0, count - 1);
      if (count === 0) {
        drop();
        log.debug("sleep assertion released");
      }
    },
    get held() {
      return count > 0;
    },
  };
}

/** Platforms without caffeinate (and tests) get the no-op guard. */
function createNullSleepGuard(): SleepGuard {
  let count = 0;
  return {
    acquire() {
      count += 1;
    },
    release() {
      count = Math.max(0, count - 1);
    },
    get held() {
      return count > 0;
    },
  };
}

/** Counting guard for tests — records every acquire/release. */
export function createFakeSleepGuard(): SleepGuard & { count: () => number } {
  let count = 0;
  return {
    acquire() {
      count += 1;
    },
    release() {
      count = Math.max(0, count - 1);
    },
    get held() {
      return count > 0;
    },
    count: () => count,
  };
}

export function createSleepGuard(
  platform: NodeJS.Platform,
  log: Logger,
): SleepGuard {
  return platform === "darwin"
    ? createCaffeinateGuard(log)
    : createNullSleepGuard();
}
