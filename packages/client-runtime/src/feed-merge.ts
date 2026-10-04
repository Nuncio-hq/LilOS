import type { EngineEvent } from "@lilos/contracts/engine";

/**
 * Merge a session feed's stored events with an `events.since` /
 * `session.events` replay. Live frames can land mid-replay in either
 * direction (inside the window or past it), and a session rebind restarts
 * `seq` at 1 — so dedupe on `sessionId|seq`, then order by `seq`. The
 * reducer only reads same-session runs, where seq order is the truth.
 *
 * Collision rule: at the same `sessionId|seq` a replayed `turn.recap`
 * beats a held live `turn.delta`. The recap stands at a compacted turn's
 * anchor seq carrying the whole stream; the held delta there is only a
 * fragment. A mid-mount/gap-resync client that let the delta win lost the
 * compacted prefix for good (#431 review). Otherwise the live copy wins —
 * it is the identical event.
 *
 * Linear in the merged size — the `Array.some` per replayed event it
 * replaced was quadratic and froze the app ~4.6 s on a 100k-event feed
 * (#428).
 */
export function mergeFeedEvents(
  current: readonly EngineEvent[],
  replayed: readonly EngineEvent[],
): EngineEvent[] {
  const at = new Map<string, number>();
  const merged: EngineEvent[] = [];
  for (const e of [...current, ...replayed]) {
    const key = `${e.sessionId}#${e.seq}`;
    const i = at.get(key);
    if (i === undefined) {
      at.set(key, merged.length);
      merged.push(e);
      continue;
    }
    if (e.type === "turn.recap" && merged[i].type !== "turn.recap") {
      merged[i] = e;
    }
  }
  merged.sort((a, b) => a.seq - b.seq);
  return merged;
}
