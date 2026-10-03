/* #429: the Workbench's `forge.pr` re-reads are scheduler-driven, never a
   blind poll — `gh pr view` is a ~1s subprocess and 40/min of them tripped
   GitHub's rate limit. These unit tests pin the scheduler contract the e2e
   (e2e/ac-429-gh-poll.spec.ts) measures end-to-end against the fake `gh`
   call log. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createPrPoll } from "../src/workbench/pr-poll";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const MIN = 60_000;

describe("AC-1 a running turn polls forge.pr at most once a minute", () => {
  test("the keep-alive ticks once per interval while running, never faster", () => {
    const refresh = vi.fn();
    const poll = createPrPoll(refresh);
    poll.setRunning(true);
    vi.advanceTimersByTime(3 * MIN + 500);
    expect(refresh).toHaveBeenCalledTimes(3);
    poll.dispose();
  });

  test("no running turn → no self-driven polling at all", () => {
    const refresh = vi.fn();
    const poll = createPrPoll(refresh);
    vi.advanceTimersByTime(5 * MIN);
    expect(refresh).not.toHaveBeenCalled();
    poll.dispose();
  });

  test("stopping the run disarms the keep-alive", () => {
    const refresh = vi.fn();
    const poll = createPrPoll(refresh);
    poll.setRunning(true);
    vi.advanceTimersByTime(MIN);
    expect(refresh).toHaveBeenCalledTimes(1);
    poll.setRunning(false);
    vi.advanceTimersByTime(5 * MIN);
    expect(refresh).toHaveBeenCalledTimes(1);
    poll.dispose();
  });
});

describe("AC-2 turn end / focus refresh the PR within seconds", () => {
  test("a turn-end signal refreshes immediately", () => {
    const refresh = vi.fn();
    const poll = createPrPoll(refresh);
    poll.signal();
    expect(refresh).toHaveBeenCalledTimes(1);
    poll.dispose();
  });

  test("a focus signal (PR tab or OS window) refreshes immediately", () => {
    const refresh = vi.fn();
    const poll = createPrPoll(refresh);
    poll.signal();
    expect(refresh).toHaveBeenCalledTimes(1);
    poll.dispose();
  });
});

describe("coalescing — bursts land one call, never a stack", () => {
  test("a burst of signals inside the gap collapses to immediate + one trailing", () => {
    const refresh = vi.fn();
    const poll = createPrPoll(refresh, { minGapMs: 2_000 });
    poll.signal();
    poll.signal();
    poll.signal();
    poll.signal();
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    // The burst is over — nothing else lands.
    vi.advanceTimersByTime(MIN);
    expect(refresh).toHaveBeenCalledTimes(2);
    poll.dispose();
  });

  test("a refresh still in flight never stacks; the follow-up lands after it settles", async () => {
    let resolve: (() => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const poll = createPrPoll(refresh, { minGapMs: 2_000 });
    poll.signal();
    expect(refresh).toHaveBeenCalledTimes(1);
    poll.signal(); // inside the gap — arms the trailing call
    resolve?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    poll.dispose();
  });

  test("a slow refresh that outlives the gap still lands exactly one follow-up", async () => {
    let resolve: (() => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const poll = createPrPoll(refresh, { minGapMs: 2_000 });
    poll.signal();
    expect(refresh).toHaveBeenCalledTimes(1);
    /* Signals arriving past the gap while the first call is still in
       flight are recorded — one settle-time follow-up, never a stack. */
    vi.advanceTimersByTime(3_000);
    poll.signal();
    poll.signal();
    resolve?.();
    await vi.advanceTimersByTimeAsync(0); // flush the settle → follow-up
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(MIN);
    expect(refresh).toHaveBeenCalledTimes(2);
    poll.dispose();
  });

  test("dispose silences the keep-alive and every pending signal", () => {
    const refresh = vi.fn();
    const poll = createPrPoll(refresh, { minGapMs: 2_000 });
    poll.setRunning(true);
    poll.signal();
    poll.signal(); // arms the trailing call
    poll.dispose();
    vi.advanceTimersByTime(5 * MIN);
    expect(refresh).toHaveBeenCalledTimes(1);
    // A disposed poll ignores further signals too.
    poll.signal();
    poll.setRunning(true);
    vi.advanceTimersByTime(2 * MIN);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
