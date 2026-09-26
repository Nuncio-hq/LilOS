/**
 * Injected time. Everything timing-sensitive in this package takes a Clock so
 * unit tests drive it deterministically and macOS legs can substitute a real
 * one. `now()` is a monotonic millisecond source (process uptime semantics),
 * never wall time — wall time jumps are how sleep is detected elsewhere.
 */
export interface CancelTimer {
  cancel(): void;
}

export interface Clock {
  /** Monotonic milliseconds. */
  now(): number;
  after(ms: number, fn: () => void): CancelTimer;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const t = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(t) };
  },
};

/** Deterministic clock for tests: timers fire when `advance` crosses them. */
export class ManualClock implements Clock {
  private t = 0;
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];

  now(): number {
    return this.t;
  }

  after(ms: number, fn: () => void): CancelTimer {
    const timer = { at: this.t + ms, fn, cancelled: false };
    this.timers.push(timer);
    return { cancel: () => (timer.cancelled = true) };
  }

  /**
   * Advance time. Timers due within `ms` fire in order at their due instant —
   * so a timer scheduled for t+5000 that fires after advancing 60s was "late"
   * by 55s (the process-frozen gap a real clock shows after SIGSTOP/sleep).
   */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.t = due.at;
      due.cancelled = true;
      due.fn();
    }
    this.t = target;
  }
}
