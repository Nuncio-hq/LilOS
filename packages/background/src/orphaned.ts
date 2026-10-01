import { execFileSync } from "node:child_process";
import type { CancelTimer, Clock } from "./clock.js";

/**
 * Orphan watchdog (#347): a dev/test process that outlives its spawner is a
 * leak — the ~3.5-day-old `serve.ts --tick 25` and `surfaces-demo` stacks
 * Oscar swept off his Mac. Every long-lived test/dev entry point (stack
 * umbrella, relay, harness, engine-fake, demo drivers) runs one of these so
 * a killed runner — Ctrl-C, timeout, SIGKILL — can never orphan it.
 *
 * The check needs no env wiring and no stdin pipe: it watches parentage.
 * When a process's parent dies the kernel reparents it (launchd on macOS,
 * pid 1 or a subreaper on Linux), so `process.ppid` changes. One hop up the
 * same test detects a `bun run` shim in between: when the *owner* dies the
 * shim gets reparented, so the shim's own ppid changes too. Either movement
 * means the tree that spawned us is gone — fire `onOrphaned`.
 *
 * Installed launchd daemons are safe: their parent is pid 1 from the start
 * and stays pid 1, so the watch never trips.
 */

/** `ps`-backed parent lookup; null when the pid is dead or `ps` cannot say. */
export const psParentOf = (pid: number): number | null => {
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

export interface OrphanWatchOptions {
  clock: Clock;
  intervalMs: number;
  /** Live read of our parent pid — defaults to `process.ppid` (fresh each tick). */
  ppid?: () => number;
  /** Parent-of-pid lookup — defaults to `psParentOf`; injected in tests. */
  parentOf?: (pid: number) => number | null;
  /** Called once with the reason ("reparented" / "parent reparented"). */
  onOrphaned: (reason: string) => void;
}

export interface OrphanWatch {
  stop(): void;
}

export function watchOrphaned(opts: OrphanWatchOptions): OrphanWatch {
  const ppid = opts.ppid ?? (() => process.ppid);
  const parentOf = opts.parentOf ?? psParentOf;
  const ppid0 = ppid();
  /* No baseline when `ps` can't see our parent's parent — the ppid check
     still covers the no-shim case (direct child of the spawner). */
  const gpid0 = ppid0 <= 1 ? null : parentOf(ppid0);
  let stopped = false;
  let timer = schedule();

  function schedule(): CancelTimer {
    return opts.clock.after(opts.intervalMs, tick);
  }

  function tick() {
    if (stopped) return;
    if (ppid() !== ppid0) {
      fire(`reparented (was ${ppid0})`);
      return;
    }
    /* Our parent is still alive but was itself reparented — the real owner
       (test worker, shell, `bun run dev` caller) died. A `null` answer means
       the parent pid vanished — it died and our reparent hasn't landed yet;
       that is the same orphan event one tick early. */
    if (gpid0 !== null && parentOf(ppid0) !== gpid0) {
      fire(`parent reparented (grandparent was ${gpid0})`);
      return;
    }
    timer = schedule();
  }

  function fire(reason: string) {
    stopped = true;
    opts.onOrphaned(reason);
  }

  return {
    stop() {
      stopped = true;
      timer.cancel();
    },
  };
}
