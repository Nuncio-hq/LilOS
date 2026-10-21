import { describe, expect, it } from "vitest";
import {
  STUCK_QUIET_MS,
  STUCK_REPEAT,
  type StuckCall,
  stuckReason,
} from "../src/harness/stuck";

/* D-#772: the two thresholds, and that a different step or a fresh start
   drops the mark. The harness calls this on each tool and on the quiet
   timer; the numbers live only in stuck.ts. */

const at = (n: number) => n;
const search = (t: number, query = "journaling creators"): StuckCall => ({
  tool: "web_search",
  input: { query },
  at: at(t),
});

describe("stuckReason", () => {
  it("five identical calls are a retry, not stuck", () => {
    const calls = Array.from({ length: STUCK_REPEAT - 1 }, (_, i) => search(i));
    expect(stuckReason({ calls, now: 10, startedAt: 0 })).toBeUndefined();
  });

  it("six identical calls name the tool and the count", () => {
    const calls = Array.from({ length: STUCK_REPEAT }, (_, i) => search(i));
    expect(stuckReason({ calls, now: 10, startedAt: 0 })).toBe(
      "Same web search 6 times",
    );
  });

  it("argument key order does not make two calls different", () => {
    const calls: StuckCall[] = Array.from({ length: STUCK_REPEAT }, (_, i) => ({
      tool: "web_search",
      input: i % 2 === 0 ? { query: "q", n: 1 } : { n: 1, query: "q" },
      at: i,
    }));
    expect(stuckReason({ calls, now: 10, startedAt: 0 })).toBe(
      "Same web search 6 times",
    );
  });

  it("a different step resets the streak", () => {
    const calls = [
      ...Array.from({ length: STUCK_REPEAT }, (_, i) => search(i)),
      { tool: "read_file", input: { path: "creators.csv" }, at: 100 },
    ];
    expect(stuckReason({ calls, now: 100, startedAt: 0 })).toBeUndefined();
  });

  it("a different argument resets the streak", () => {
    const calls = [
      ...Array.from({ length: STUCK_REPEAT }, (_, i) => search(i)),
      search(100, "other query"),
    ];
    expect(stuckReason({ calls, now: 100, startedAt: 0 })).toBeUndefined();
  });

  it("a fresh watch (new message, or Stop) is not stuck", () => {
    expect(stuckReason({ calls: [], now: 0, startedAt: 0 })).toBeUndefined();
  });

  it("no new step for twenty minutes is stuck; nineteen is not", () => {
    const startedAt = 0;
    expect(
      stuckReason({
        calls: [],
        now: STUCK_QUIET_MS - 1,
        startedAt,
      }),
    ).toBeUndefined();
    expect(stuckReason({ calls: [], now: STUCK_QUIET_MS, startedAt })).toBe(
      "No new step for 20 minutes",
    );
    expect(
      stuckReason({
        calls: [search(0)],
        now: STUCK_QUIET_MS + 60_000,
        startedAt,
      }),
    ).toBe("No new step for 21 minutes");
  });

  it("a step inside the window clears a quiet stall", () => {
    expect(
      stuckReason({
        calls: [search(STUCK_QUIET_MS)],
        now: STUCK_QUIET_MS + 1_000,
        startedAt: 0,
      }),
    ).toBeUndefined();
  });
});
