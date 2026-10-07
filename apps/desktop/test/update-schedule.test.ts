import type { DesktopUpdateOutcome } from "@lilos/contracts/app";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_UPDATE_RETRY_DELAYS_MS,
  retryDelaysFromEnv,
  updateScheduler,
} from "../src/update/schedule";

/**
 * #674: the updater must retry a failed feed check on a short backoff
 * (1/5/15 min then back to the 4 h cadence), and re-check promptly when the
 * Mac wakes or the network returns — all on an injected clock, no real
 * timers (AC-3).
 */

const MIN = 60_000;
const HOUR = 3_600_000;

/** One pending timer at a time; advance() cascades through every deadline
 *  inside the window so a whole retry pattern is observable in one call. */
function fakeClock(start = 1_000_000) {
  let now = start;
  let timer: { at: number; cb: () => void } | undefined;
  const clock = {
    now: () => now,
    setTimeout: (cb: () => void, ms: number) => {
      timer = { at: now + ms, cb };
      return timer;
    },
    clearTimeout: (t: unknown) => {
      if (timer === t) timer = undefined;
    },
    /** ms until the pending timer fires; undefined when nothing is booked. */
    pendingIn: () => (timer === undefined ? undefined : timer.at - now),
    async advance(ms: number) {
      const target = now + ms;
      while (timer && timer.at <= target) {
        const t = timer;
        timer = undefined;
        now = t.at;
        t.cb();
        // runCheck awaits the check promise — let the microtasks drain.
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      now = target;
    },
  };
  return clock;
}

function rig(outcomes: DesktopUpdateOutcome[], retry = RETRY) {
  const clock = fakeClock();
  const times: number[] = [];
  let i = 0;
  const scheduler = updateScheduler({
    // replays `outcomes`, then repeats the last one; stamps each call
    check: async () => {
      times.push(clock.now());
      return outcomes[Math.min(i++, outcomes.length - 1)];
    },
    intervalMs: 4 * HOUR,
    retryDelaysMs: retry,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, times, scheduler };
}

const RETRY = [...DEFAULT_UPDATE_RETRY_DELAYS_MS];
const deltas = (times: number[], from: number) =>
  times.map((t, i) => t - (i === 0 ? from : times[i - 1]));

describe("update schedule (#674)", () => {
  test("AC-1 a failed fetch retries at 1/5/15 min then falls back to the 4 h cadence", async () => {
    const { clock, times, scheduler } = rig(["failed"]);
    scheduler.start();
    await clock.advance(9 * HOUR);
    expect(deltas(times, 1_000_000)).toEqual([
      5_000, // the boot check
      MIN,
      5 * MIN,
      15 * MIN,
      4 * HOUR,
      4 * HOUR, // backoff exhausted — steady cadence resumes
    ]);
  });

  test("AC-1 a successful fetch resets the backoff", async () => {
    const { clock, times, scheduler } = rig([
      "failed",
      "failed",
      "none",
      "failed",
    ]);
    scheduler.start();
    await clock.advance(9 * HOUR);
    expect(deltas(times, 1_000_000)).toEqual([
      5_000,
      MIN,
      5 * MIN,
      4 * HOUR, // "none" reset the backoff
      MIN, // next failure starts the ladder over
      5 * MIN,
      15 * MIN,
      4 * HOUR,
    ]);
  });

  test("AC-3 LILOS_UPDATE_RETRY_MS overrides the retry ladder (comma list)", () => {
    expect(retryDelaysFromEnv({})).toEqual([MIN, 5 * MIN, 15 * MIN]);
    expect(retryDelaysFromEnv({ LILOS_UPDATE_RETRY_MS: "2000, 4000" })).toEqual(
      [2_000, 4_000],
    );
    // junk entries drop out; a fully invalid value keeps the default
    expect(retryDelaysFromEnv({ LILOS_UPDATE_RETRY_MS: "abc,,3000" })).toEqual([
      3_000,
    ]);
    expect(retryDelaysFromEnv({ LILOS_UPDATE_RETRY_MS: "abc" })).toEqual([
      MIN,
      5 * MIN,
      15 * MIN,
    ]);
  });

  test("AC-3 a custom retry ladder is honored, then the cadence resumes", async () => {
    const { clock, times, scheduler } = rig(["failed"], [1_000, 2_000]);
    scheduler.start();
    await clock.advance(5 * HOUR);
    expect(deltas(times, 1_000_000)).toEqual([5_000, 1_000, 2_000, 4 * HOUR]);
  });

  test("AC-2 wake/network triggers re-check at most once per 10 min", async () => {
    const { clock, times, scheduler } = rig(["none"]);
    scheduler.start();
    await clock.advance(5_000); // boot check ran
    expect(times).toHaveLength(1);

    await clock.advance(9 * MIN); // ~9 min later
    scheduler.poke();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(times).toHaveLength(1); // too soon — rate-limited

    await clock.advance(MIN + 1); // past the 10 min gate
    scheduler.poke();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(times).toHaveLength(2); // wake/online ran a check now
  });

  test("AC-2 a rate-limited poke leaves the pending check untouched", async () => {
    const { clock, scheduler } = rig(["none"]);
    scheduler.start();
    await clock.advance(5_000);
    const before = clock.pendingIn();
    scheduler.poke();
    expect(clock.pendingIn()).toBe(before);
  });

  test("AC-2 a poke never overlaps an in-flight check", async () => {
    const clock = fakeClock();
    let resolveCheck: (o: DesktopUpdateOutcome) => void = () => {};
    const check = () =>
      new Promise<DesktopUpdateOutcome>((r) => {
        resolveCheck = r;
      });
    let calls = 0;
    const scheduler = updateScheduler({
      check: () => {
        calls += 1;
        return check();
      },
      intervalMs: 4 * HOUR,
      retryDelaysMs: RETRY,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    scheduler.start();
    await clock.advance(5_000); // first check now hangs in flight
    await clock.advance(20 * MIN); // well past the poke gate
    scheduler.poke();
    expect(calls).toBe(1);
    resolveCheck("none");
  });

  test("stop() cancels the pending check", async () => {
    const { clock, times, scheduler } = rig(["none"]);
    scheduler.start();
    scheduler.stop();
    await clock.advance(HOUR);
    expect(times).toHaveLength(0);
    scheduler.poke(); // a stopped scheduler ignores triggers
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(times).toHaveLength(0);
  });
});
