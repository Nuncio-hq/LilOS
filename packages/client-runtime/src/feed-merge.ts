import type { EngineEvent } from "@lilos/contracts/engine";

/**
 * Merge a session feed's stored events with an `events.since` /
 * `session.events` replay. Live frames can land mid-replay in either
 * direction (inside the window or past it), and a session rebind restarts
 * `seq` at 1 — so dedupe on `sessionId|seq` (first occurrence wins: the
 * live copy), then order by `seq`. The reducer only reads same-session
 * runs, where seq order is the truth.
 *
 * Linear in the merged size — the `Array.some` per replayed event it
 * replaced was quadratic and froze the app ~4.6 s on a 100k-event feed
 * (#428).
 */
export function mergeFeedEvents(
  current: readonly EngineEvent[],
  replayed: readonly EngineEvent[],
): EngineEvent[] {
  const seen = new Set<string>();
  const merged: EngineEvent[] = [];
  for (const e of [...current, ...replayed]) {
    const key = `${e.sessionId}#${e.seq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  merged.sort((a, b) => a.seq - b.seq);
  return merged;
}
