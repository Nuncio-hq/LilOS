/* One lane per thread: the timers of whatever the thread is doing now (a
   scripted turn, or an agent carrying on after an approval). A message sent
   while a lane is open waits in it and starts when the lane closes, so two
   scripted turns never interleave on one thread. */

type Lane = {
  /** False once the company was reset: the lane's pending timers do nothing. */
  live: boolean;
  /** Messages sent while the lane was busy, oldest first. */
  waiting: string[];
  /** Work that must land once the lane is free (an approval given mid-turn). */
  deferred: (() => void)[];
};

/** What a closed lane leaves behind for the next thing to start. */
export type ClosedLane = Pick<Lane, "waiting" | "deferred">;

const lanes = new Map<string, Lane>();

export const isBusy = (threadId: string): boolean => lanes.has(threadId);

/** Opens the thread's lane; returns the scheduler for its timers. A reset
    silences them through `live` instead of tracking timer handles. */
export function openLane(
  threadId: string,
): (fn: () => void, ms: number) => void {
  const lane: Lane = { live: true, waiting: [], deferred: [] };
  lanes.set(threadId, lane);
  return (fn, ms) => {
    setTimeout(() => {
      if (lane.live) fn();
    }, ms);
  };
}

export function waitInLane(threadId: string, text: string): void {
  lanes.get(threadId)?.waiting.push(text);
}

export function deferInLane(threadId: string, fn: () => void): void {
  lanes.get(threadId)?.deferred.push(fn);
}

/** Closes the lane and hands back what waited in it. */
export function closeLane(threadId: string): ClosedLane {
  const lane = lanes.get(threadId);
  lanes.delete(threadId);
  return { waiting: lane?.waiting ?? [], deferred: lane?.deferred ?? [] };
}

/** Silences every pending timer (company reset). */
export function clearLanes(): void {
  for (const lane of lanes.values()) lane.live = false;
  lanes.clear();
}
