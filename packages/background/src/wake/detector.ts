import { type CancelTimer, type Clock } from "../clock.js";

export interface WakeDetectorOptions {
  /** Schedules the heartbeat (the event-loop view of time). */
  clock: Clock;
  /**
   * Wall-clock milliseconds — what actually elapsed, independent of whether
   * the event loop ran. On a frozen process the timer fires late while the
   * wall clock kept moving; that divergence IS the sleep signal (SP2: a
   * process cannot tell SIGSTOP from `pmset sleepnow`, and does not need to).
   */
  wall: () => number;
  /** Heartbeat period. */
  intervalMs: number;
  /** Tick arriving this late counts as a wake (freeze gap). */
  driftMs: number;
  onWake: (gapMs: number) => void;
}

export interface WakeDetector {
  stop(): void;
}

/**
 * Sleep detector: a heartbeat timer that compares scheduled time against the
 * wall clock. Works in the headless harness daemon (no AppKit runloop) and
 * doubles as the SIGSTOP/SIGCONT sleep simulation signal on the VM.
 */
export function watchWake(opts: WakeDetectorOptions): WakeDetector {
  let stopped = false;
  let lastTickAt = opts.wall();
  let timer = schedule();

  function schedule(): CancelTimer {
    return opts.clock.after(opts.intervalMs, tick);
  }

  function tick() {
    if (stopped) return;
    const now = opts.wall();
    const gap = now - lastTickAt;
    if (gap - opts.intervalMs > opts.driftMs) {
      opts.onWake(gap);
    }
    lastTickAt = now;
    timer = schedule();
  }

  return {
    stop() {
      stopped = true;
      timer.cancel();
    },
  };
}
