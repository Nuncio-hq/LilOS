import type { DesktopUpdateOutcome } from "@lilos/contracts/app";

/**
 * Update-check scheduling (issue #674): the plain #35 feed poll was one
 * `setInterval`, so a check that failed on a network drop waited a full
 * 4 h for the next try. This scheduler adds two accelerations:
 *
 * - AC-1: a `failed` check retries on a backoff ladder (`retryDelaysMs`,
 *   1/5/15 min by default); past the ladder the cadence falls back to the
 *   normal interval. Any non-failed outcome resets the ladder.
 * - AC-2: `poke()` runs a check early when the Mac wakes or the network
 *   comes back — rate-limited so a flapping link can't hammer the feed.
 *
 * Clock and timers are injected so tests drive the whole pattern with a
 * fake clock — no real timers or sleeps (AC-3). `LILOS_UPDATE_RETRY_MS`
 * overrides the ladder as a comma-separated ms list for live runs.
 */
export const DEFAULT_UPDATE_RETRY_DELAYS_MS = [60_000, 300_000, 900_000];

/** `LILOS_UPDATE_RETRY_MS`: comma-separated ms delays; invalid entries drop,
 *  a fully-invalid/unset value keeps the default ladder. */
export function retryDelaysFromEnv(
  env: Record<string, string | undefined>,
): number[] {
  const raw = env.LILOS_UPDATE_RETRY_MS;
  if (!raw) return DEFAULT_UPDATE_RETRY_DELAYS_MS;
  const delays = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return delays.length ? delays : DEFAULT_UPDATE_RETRY_DELAYS_MS;
}

export interface UpdateSchedulerConfig {
  /** One feed check — `checkAndApply` in main.ts. */
  check: () => Promise<DesktopUpdateOutcome>;
  /** Normal cadence (the 4 h `LILOS_UPDATE_CHECK_MS`). */
  intervalMs: number;
  /** Retry delays after the 1st, 2nd, … consecutive failure; beyond the
   *  list the next check is booked at `intervalMs`. */
  retryDelaysMs: number[];
  /** First check this long after `start()` (boot settle). Default 5 s. */
  initialDelayMs?: number;
  /** `poke()` can't run a check more often than this. Default 10 min. */
  wakeMinIntervalMs?: number;
  now?: () => number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

export interface UpdateScheduler {
  /** Book the first check at `initialDelayMs`, then self-perpetuate. */
  start(): void;
  /** Wake/network-restored trigger: run a check now unless one ran inside
   *  `wakeMinIntervalMs` or one is in flight. The pending timer is replaced
   *  by the check's own outcome scheduling. */
  poke(): void;
  /** Cancel the pending check and ignore further triggers. */
  stop(): void;
}

export function updateScheduler(cfg: UpdateSchedulerConfig): UpdateScheduler {
  const now = cfg.now ?? (() => Date.now());
  const setT =
    cfg.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearT =
    cfg.clearTimeout ??
    ((t: unknown) => clearTimeout(t as Parameters<typeof clearTimeout>[0]));
  const initialDelayMs = cfg.initialDelayMs ?? 5_000;
  const wakeMinIntervalMs = cfg.wakeMinIntervalMs ?? 10 * 60_000;

  let timer: unknown;
  let failures = 0;
  let lastCheckAt = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  let stopped = true;

  function schedule(delayMs: number): void {
    if (timer !== undefined) clearT(timer);
    timer = setT(() => void runCheck(), delayMs);
  }

  async function runCheck(): Promise<void> {
    if (timer !== undefined) {
      clearT(timer);
      timer = undefined;
    }
    inFlight = true;
    lastCheckAt = now();
    let outcome: DesktopUpdateOutcome;
    try {
      outcome = await cfg.check();
    } catch {
      // A throwing check must not kill the chain — it counts as a failure
      // and rides the same retry ladder.
      outcome = "failed";
    } finally {
      inFlight = false;
    }
    if (stopped) return;
    if (outcome === "failed") {
      failures += 1;
      schedule(cfg.retryDelaysMs[failures - 1] ?? cfg.intervalMs);
    } else {
      // A check that reached the feed (or ran into a manual check already in
      // flight — "busy") isn't proof of failure either way; a real outcome
      // resets the ladder, "busy" just books the next plain slot.
      if (outcome !== "busy") failures = 0;
      schedule(cfg.intervalMs);
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(initialDelayMs);
    },
    poke() {
      if (stopped || inFlight) return;
      if (now() - lastCheckAt < wakeMinIntervalMs) return;
      void runCheck();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) {
        clearT(timer);
        timer = undefined;
      }
    },
  };
}
