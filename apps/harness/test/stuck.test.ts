import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessCtx, SessionBinding } from "../src/harness/ctx";
import {
  markTurnInterrupted,
  surfaceBackendDown,
} from "../src/harness/engine-attach";
import {
  beginStuckTurn,
  clearStuck,
  finishStuckReplay,
  noteStuckProgress,
  noteStuckTool,
  pauseStuckWatch,
  STUCK_QUIET_MS,
  STUCK_REPEAT,
  type StuckCall,
  stopStuckWatches,
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

  it("the quiet clock is the later of the last call and the turn start", () => {
    expect(
      stuckReason({
        calls: [search(0)],
        now: STUCK_QUIET_MS + 60_000,
        startedAt: STUCK_QUIET_MS,
      }),
    ).toBeUndefined();
  });

  it("a 25-minute streaming command is not stuck", () => {
    const now = 25 * 60_000;
    expect(
      stuckReason({
        calls: [{ tool: "bash", input: { command: "build" }, at: 0 }],
        now,
        startedAt: 0,
        progressAt: now - 1_000,
      }),
    ).toBeUndefined();
  });

  it("a subagent working is not stuck", () => {
    const now = 25 * 60_000;
    expect(
      stuckReason({
        calls: [{ tool: "delegate", input: { to: "researcher" }, at: 0 }],
        now,
        startedAt: 0,
        progressAt: now - 1_000,
      }),
    ).toBeUndefined();
  });

  it("a 25-minute wait on an approval is not stuck", () => {
    expect(
      stuckReason({
        calls: [{ tool: "bash", input: { command: "deploy" }, at: 0 }],
        now: 25 * 60_000,
        startedAt: 0,
        waiting: true,
      }),
    ).toBeUndefined();
  });
});

function world(stuck?: { reason: string }) {
  const writes: ({ reason: string } | null)[] = [];
  const row: { id: string; stuck?: { reason: string } } = {
    id: "c1",
    ...(stuck ? { stuck } : {}),
  };
  const binding = {
    conversationId: "c1",
    channelId: "ch",
    runningTurnId: "t1",
    stopRequested: false,
    nowWaits: new Map<string, string>(),
    textByTurn: new Map<string, string>(),
  } as SessionBinding;
  const ctx = {
    conversationFromAtom: () => row,
    findConversation: async () => row,
    updateConversation: async (
      _id: string,
      patch: { stuck?: { reason: string } | null },
    ) => {
      if (!("stuck" in patch)) return;
      writes.push(patch.stuck ?? null);
      if (patch.stuck) row.stuck = patch.stuck;
      else delete row.stuck;
    },
    noteNow: () => {},
    postSystem: async () => {},
    scheduleSteerReconcile: () => {},
    opts: {
      log: { warn: () => {} },
      sleep: { release: () => {} },
    },
  } as unknown as HarnessCtx;
  return { binding, ctx, writes, row };
}

const bash = (at: number): StuckCall => ({
  tool: "bash",
  input: { command: "build" },
  at,
});

describe("stuck watch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a 25-minute streaming command does not mark the thread", () => {
    vi.useFakeTimers();
    const { binding, ctx, writes } = world();
    beginStuckTurn(ctx, binding);
    noteStuckTool(ctx, binding, bash(Date.now()), false);
    vi.advanceTimersByTime(10 * 60_000);
    noteStuckProgress(ctx, binding);
    vi.advanceTimersByTime(15 * 60_000);
    noteStuckProgress(ctx, binding);
    expect(writes.filter(Boolean)).toEqual([]);
    stopStuckWatches([binding]);
  });

  it("a subagent that keeps working does not mark the thread", () => {
    vi.useFakeTimers();
    const { binding, ctx, writes } = world();
    beginStuckTurn(ctx, binding);
    noteStuckTool(
      ctx,
      binding,
      { tool: "delegate", input: { to: "researcher" }, at: Date.now() },
      false,
    );
    vi.advanceTimersByTime(12 * 60_000);
    noteStuckProgress(ctx, binding);
    vi.advanceTimersByTime(13 * 60_000);
    noteStuckProgress(ctx, binding);
    expect(writes.filter(Boolean)).toEqual([]);
    stopStuckWatches([binding]);
  });

  it("a 25-minute wait on an approval does not mark the thread", () => {
    vi.useFakeTimers();
    const { binding, ctx, writes } = world();
    beginStuckTurn(ctx, binding);
    noteStuckTool(ctx, binding, bash(Date.now()), false);
    binding.nowWaits.set("req", "waiting on your approval");
    pauseStuckWatch(ctx, binding);
    vi.advanceTimersByTime(25 * 60_000);
    expect(writes.filter(Boolean)).toEqual([]);
    expect(binding.stuckTimer).toBeUndefined();
  });

  it("a replay does not mark a finished turn, and clears a stale row", async () => {
    const { binding, ctx, writes, row } = world({
      reason: "Same web search 6 times",
    });
    binding.stuckDefer = true;
    beginStuckTurn(ctx, binding);
    for (let i = 0; i < STUCK_REPEAT; i++)
      noteStuckTool(ctx, binding, search(i), false);
    expect(writes).toEqual([]);
    binding.runningTurnId = undefined;
    finishStuckReplay(ctx, binding);
    await Promise.resolve();
    await Promise.resolve();
    expect(writes.some((w) => w && "reason" in w)).toBe(false);
    expect(row.stuck).toBeUndefined();
  });

  it("a replay judges a turn that is still running, once", () => {
    const { binding, ctx, writes } = world();
    binding.stuckDefer = true;
    beginStuckTurn(ctx, binding);
    for (let i = 0; i < STUCK_REPEAT; i++)
      noteStuckTool(ctx, binding, search(i), false);
    expect(writes).toEqual([]);
    finishStuckReplay(ctx, binding);
    expect(writes).toEqual([{ reason: "Same web search 6 times" }]);
    stopStuckWatches([binding]);
  });

  it("clearing after a restart reads the persisted mark", async () => {
    const { binding, ctx, row } = world({
      reason: "Same web search 6 times",
    });
    expect(binding.stuckReason).toBeUndefined();
    await clearStuck(ctx, binding);
    expect(row.stuck).toBeUndefined();
  });

  it("Harness.stop clears stuck timers", () => {
    vi.useFakeTimers();
    const { binding, ctx, writes } = world();
    beginStuckTurn(ctx, binding);
    expect(binding.stuckTimer).toBeDefined();
    stopStuckWatches([binding]);
    expect(binding.stuckTimer).toBeUndefined();
    vi.advanceTimersByTime(STUCK_QUIET_MS + 1_000);
    expect(writes).toEqual([]);
  });

  it("an interrupted turn clears the mark", async () => {
    const { binding, ctx, row } = world({
      reason: "No new step for 20 minutes",
    });
    await markTurnInterrupted.call(ctx, binding, "t1");
    expect(row.stuck).toBeUndefined();
    expect(binding.stuckTimer).toBeUndefined();
  });

  it("a backend-down turn clears the mark", async () => {
    const { binding, ctx, row } = world({
      reason: "No new step for 20 minutes",
    });
    binding.stuckReason = "No new step for 20 minutes";
    beginStuckTurn(ctx, binding);
    await surfaceBackendDown.call(ctx, binding, "src");
    expect(row.stuck).toBeUndefined();
    expect(binding.stuckTimer).toBeUndefined();
  });
});
