/* Issue #429: `forge.pr` shells out to `gh pr view` — a ~1s subprocess per
   call, and its answer only changes on real PR events (push, merge, review,
   checks). Polling it at the git-read cadence was ~40 `gh` calls/min per
   open Workbench: GitHub rate-limit errors and a Mac spawning processes
   non-stop.

   The PR read runs on signals instead: the probe (re)attaches (mount and
   every `running` flip — turn start and turn end both land here), the PR
   tab or the OS window gains focus, or the keep-alive tick fires while a
   turn runs (≤1/min — AC-1's cap covers the self-driven cadence; each
   user-driven signal still gets one coalesced read, per AC-2).
   `createPrPoll` funnels every signal through one coalescer — a burst
   lands one call, a slow `gh` never stacks a second on itself, and
   `dispose` silences everything (no sleeps, no retries). */

export type PrPoll = {
  /** "Fresh PR state is wanted now" — a turn boundary, the PR tab gaining
      focus, or the OS window gaining focus. Fires immediately unless one
      ran inside `minGapMs`; bursts collapse to a single trailing call. */
  signal: () => void;
  /** Turn state: `true` arms the slow keep-alive tick, `false` disarms it. */
  setRunning: (on: boolean) => void;
  /** Drop every pending call; the poll answers nothing after this. */
  dispose: () => void;
};

export function createPrPoll(
  refresh: () => undefined | Promise<unknown>,
  {
    /** Keep-alive cadence while a turn runs (AC-1: at most 1/min). */
    intervalMs = 60_000,
    /** Min gap between two fires — signal bursts inside it collapse to one
        trailing call at the edge instead of a call each. */
    minGapMs = 2_000,
  }: { intervalMs?: number; minGapMs?: number } = {},
): PrPoll {
  let dead = false;
  let lastFire = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  let again = false;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;

  const fire = () => {
    if (dead) return;
    if (inFlight) {
      again = true;
      return;
    }
    lastFire = Date.now();
    let r: undefined | Promise<unknown>;
    /* A throwing/rejecting refresh is the caller's problem to surface —
       the scheduler just skips the call and keeps answering signals. */
    try {
      r = refresh();
    } catch {
      return;
    }
    if (r && typeof (r as Promise<unknown>).then === "function") {
      inFlight = true;
      void Promise.resolve(r)
        .catch(() => {})
        .finally(() => {
          inFlight = false;
          if (again) {
            again = false;
            poke();
          }
        });
    }
  };

  /* One funnel for every signal: fire now unless one ran inside the gap —
     then a single trailing fire lands at the gap's edge. */
  const poke = () => {
    if (dead) return;
    const wait = minGapMs - (Date.now() - lastFire);
    if (wait <= 0) {
      if (trailing) {
        clearTimeout(trailing);
        trailing = undefined;
      }
      fire();
      return;
    }
    trailing ??= setTimeout(() => {
      trailing = undefined;
      fire();
    }, wait);
  };

  return {
    signal: poke,
    setRunning(on) {
      if (dead) return;
      if (on && !tick) tick = setInterval(poke, intervalMs);
      else if (!on && tick) {
        clearInterval(tick);
        tick = undefined;
      }
    },
    dispose() {
      dead = true;
      if (tick) clearInterval(tick);
      if (trailing) clearTimeout(trailing);
      tick = trailing = undefined;
    },
  };
}
