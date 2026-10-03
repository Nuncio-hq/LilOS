import type { EngineEvent } from "@lilos/contracts/engine";
import { describe, expect, it } from "vitest";
import { mergeFeedEvents } from "../src/feed-merge";

/* A feed merge folds `cur.events` (live frames that already landed) with an
   `events.since`/`session.events` replay. Both call sites — engine.ts and
   client.ts — share these semantics: dedupe on sessionId|seq, first wins,
   order by seq. */

const ev = (seq: number, over: Record<string, unknown> = {}): EngineEvent =>
  ({
    seq,
    sessionId: "sess-1",
    type: "turn.delta",
    payload: { turnId: "t1", stream: "text", delta: `d${seq}` },
    ...over,
  }) as EngineEvent;

const seqs = (events: EngineEvent[]) => events.map((e) => e.seq);

describe("mergeFeedEvents (#428)", () => {
  it("AC-2 orders a replay merged with live frames", () => {
    // Live tail arrived mid-turn; the replay covers the whole log.
    const merged = mergeFeedEvents(
      [ev(5), ev(7)],
      [ev(1), ev(3), ev(5), ev(9)],
    );
    expect(seqs(merged)).toEqual([1, 3, 5, 7, 9]);
  });

  it("AC-2 fills a gap the live stream skipped", () => {
    // seq 3 was lost in a broadcast window; the resync replay returns it.
    const merged = mergeFeedEvents([ev(1), ev(2), ev(4)], [ev(3), ev(4)]);
    expect(seqs(merged)).toEqual([1, 2, 3, 4]);
  });

  it("AC-2 dedupes on sessionId|seq — a rebound session's seq isn't dropped", () => {
    // A rebind restarts seq at 1 in a new session's space: same seq on a
    // different sessionId is a different event and must be kept.
    const merged = mergeFeedEvents(
      [ev(1), ev(2)],
      [ev(1, { sessionId: "sess-2" }), ev(2, { sessionId: "sess-2" })],
    );
    expect(merged.map((e) => `${e.sessionId}:${e.seq}`)).toEqual([
      "sess-1:1",
      "sess-2:1",
      "sess-1:2",
      "sess-2:2",
    ]);
  });

  it("AC-2 the live copy of a duplicated event wins over the replay", () => {
    const live = ev(5, {
      payload: { turnId: "t1", stream: "text", delta: "live" },
    });
    const replayed = ev(5, {
      payload: { turnId: "t1", stream: "text", delta: "replay" },
    });
    const merged = mergeFeedEvents([live], [replayed]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(live);
  });

  it("AC-1 a 5k-event replay merges into the live tail — dedupe + order", () => {
    // Reconnect shape: a 5k replay overlaps the 1k live tail.
    const liveTail = Array.from({ length: 1_000 }, (_, i) => ev(4_001 + i));
    const replay = Array.from({ length: 5_000 }, (_, i) => ev(1 + i));
    const merged = mergeFeedEvents(liveTail, replay);
    expect(merged).toHaveLength(5_000);
    expect(seqs(merged)).toEqual(
      Array.from({ length: 5_000 }, (_, i) => i + 1),
    );
  });

  it("AC-1 merges 100k events without going quadratic", () => {
    /* The old engine.ts merge was O(cur×replay) — ~4.9 s at 100k on a dev
       Mac, frozen UI on launch/reconnect. AC target is <20 ms; the bound
       below is a regression guard with 10x+ headroom for slow CI (the
       quadratic path sits ~5,000 ms, 20x past it). */
    const liveTail = Array.from({ length: 50_000 }, (_, i) => ev(50_001 + i));
    const replay = Array.from({ length: 100_000 }, (_, i) => ev(1 + i));
    const t0 = performance.now();
    const merged = mergeFeedEvents(liveTail, replay);
    const elapsed = performance.now() - t0;
    expect(merged).toHaveLength(100_000);
    expect(merged[0]?.seq).toBe(1);
    expect(merged[99_999]?.seq).toBe(100_000);
    expect(elapsed).toBeLessThan(250);
  });
});
