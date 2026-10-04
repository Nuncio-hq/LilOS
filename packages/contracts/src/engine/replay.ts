/**
 * Replay compaction + log bounding (#431).
 *
 * A session's event log is the replay source for `events.since` — and a
 * per-session allocation that grew with every streamed word. Two rules
 * keep both its size and the replay payload bounded:
 *
 * - `coalesceTurnDeltas` — a FINISHED turn's `turn.delta` run collapses
 *   into one `turn.recap` carrying both streams' full text, spliced in at
 *   the last superseded delta's seq. Recaps are log-only: live clients
 *   already folded the deltas, replays fold the recap instead. Anchoring
 *   the recap at an existing seq (never minting a new one) keeps every
 *   client coverage state correct: a client that already saw the anchor
 *   seq dedupes the recap against the delta it holds there; a client
 *   whose watermark sits inside the dropped run still receives it.
 * - `capEventLog` — the log is a bounded prefix drop: oldest events fall
 *   out past `EVENT_LOG_CAP`, except anything at or after `protectedSeq`
 *   (the live turn's `turn.started` seq — a running turn's frames are
 *   never compacted or dropped). The caller keeps a `droppedSeq`
 *   watermark so `events.since` can answer `truncated` when the requested
 *   range lost data.
 */

import type { EngineEvent } from "./events.js";

/** Default per-session event-log bound — ~4× a 200-turn compacted log. */
export const EVENT_LOG_CAP = 16_384;

/**
 * Rewrite `log` in place: every `turn.delta` for `turnId` (plus any recap
 * already standing for it) is replaced by one `turn.recap` holding the
 * streams' full text, inserted at the position of the last superseded
 * delta and carrying that delta's seq — the array stays seq-sorted and
 * latestSeq is untouched. Idempotent: a turn.completed re-running over an
 * already-coalesced log rewrites the recap with the newest streams. Call
 * only once the turn is closed — deltas of a live turn must stay
 * verbatim.
 */
export function coalesceTurnDeltas(log: EngineEvent[], turnId: string): void {
  let text = "";
  let reasoning = "";
  let lastDelta = -1;
  let hasRecap = false;
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (!("turnId" in e.payload) || e.payload.turnId !== turnId) continue;
    if (e.type === "turn.delta") {
      if (e.payload.stream === "text") text += e.payload.delta;
      else reasoning += e.payload.delta;
      lastDelta = i;
    } else if (e.type === "turn.recap") {
      hasRecap = true;
    }
  }
  if (lastDelta < 0 && !hasRecap) return;
  if (lastDelta < 0) {
    /* A second turn.completed after coalescing, with no new deltas —
       the standing recap is already authoritative. */
    return;
  }
  const anchor = log[lastDelta];
  const recap: EngineEvent = {
    seq: anchor.seq,
    sessionId: anchor.sessionId,
    type: "turn.recap",
    payload: { turnId, text, reasoning },
  };
  let write = 0;
  let inserted = false;
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    /* The recap takes the anchor's seq slot: ahead of every retained
       event past it, behind everything before. */
    if (!inserted && e.seq > anchor.seq) {
      log[write++] = recap;
      inserted = true;
    }
    if ("turnId" in e.payload && e.payload.turnId === turnId) {
      if (e.type === "turn.delta" || e.type === "turn.recap") continue;
    }
    log[write++] = e;
  }
  if (!inserted) log[write++] = recap; // anchor was the tail
  log.length = write;
}

/**
 * Bound `log` to `cap` events by dropping the oldest — but never an event
 * with `seq >= protectedSeq` (the live turn's start: its frames replay a
 * running turn). Returns the largest dropped seq (0 when nothing fell);
 * the session accumulates it into `droppedSeq` so `events.since` reports
 * `truncated` when `droppedSeq > after`. A drop can split an ancient
 * turn's prefix — the retained tail is what a replay sees, lossy either
 * way and flagged by `truncated` when it cuts a requested range.
 */
export function capEventLog(
  log: EngineEvent[],
  cap: number,
  protectedSeq?: number,
): number {
  if (log.length <= cap) return 0;
  const excess = log.length - cap;
  let i = 0;
  for (; i < excess && i < log.length; i++) {
    const e = log[i];
    if (protectedSeq !== undefined && e.seq >= protectedSeq) break;
  }
  if (i === 0) return 0;
  const droppedSeq = log[i - 1].seq;
  log.splice(0, i);
  return droppedSeq;
}
