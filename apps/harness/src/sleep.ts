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

/** `caffeinate -i` prevents idle sleep for the life of the helper process. */
export function createCaffeinateGuard(log: Logger): SleepGuard {
  let count = 0;
  let proc: ChildProcess | undefined;
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
      if (count === 1 && !proc) {
        proc = spawn("caffeinate", ["-i"], { stdio: "ignore" });
        proc.on("exit", () => {
          proc = undefined;
        });
        proc.on("error", (error) => {
          log.warn("caffeinate failed to start", { error: String(error) });
          proc = undefined;
        });
        proc.unref();
        log.debug("sleep assertion acquired");
      }
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
export function createNullSleepGuard(): SleepGuard {
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
