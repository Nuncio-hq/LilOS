import type {
  AppChannel,
  Conversation,
  ConversationSummary,
} from "@lilos/contracts/app";
import { describe, expect, test } from "vitest";
import type { ThreadSources } from "../src/v3/threads";
import { weekByAgent, weekStart } from "../src/v3/week";

/* Wednesday 21 Oct 2026, 12:00 local. Monday that week is the 19th. */
const now = new Date(2026, 9, 21, 12).getTime();
const start = weekStart(now);

const channel: AppChannel = {
  id: "ch1",
  kind: "dm",
  employeeId: "emp1",
  lastSeq: 0,
  createdAt: 0,
};

const conv = (over: Partial<Conversation>): Conversation =>
  ({
    id: "c1",
    channelId: "ch1",
    rootMessageId: "m1",
    engineRef: null,
    state: "idle",
    title: "A thread",
    titleSource: "auto",
    access: "ask",
    archived: false,
    readSeq: 0,
    finishedSeq: 0,
    createdAt: start + 1_000,
    ...over,
  }) as Conversation;

const src = (
  conversations: Conversation[],
  summaries: ConversationSummary[] = [],
): ThreadSources => ({
  now,
  conversations,
  summaries,
  channels: [channel],
  employees: [],
  models: {},
  signals: {},
  asks: [],
});

describe("week counts", () => {
  test("Monday 00:00 local, including a Sunday", () => {
    const monday = new Date(start);
    expect(monday.getDay()).toBe(1);
    expect(monday.getHours()).toBe(0);
    expect(monday.getDate()).toBe(19);
    const sunday = weekStart(new Date(2026, 9, 18, 23).getTime());
    expect(new Date(sunday).getDate()).toBe(12);
  });

  test("finished this week counts; a failure does not also count as finished", () => {
    const counts = weekByAgent(
      src([
        conv({ id: "done", finishedSeq: 4 }),
        conv({
          id: "bad",
          finishedSeq: 2,
          turnFailure: { kind: "generic", text: "nope" },
        }),
      ]),
    );
    expect(counts.get("emp1")).toEqual({ finished: 1, failed: 1 });
  });

  test("before Monday does not count, unless the last message is this week", () => {
    const old = conv({ id: "old", createdAt: start - 5_000, finishedSeq: 3 });
    const quiet = weekByAgent(src([old]));
    expect(quiet.get("emp1")).toBeUndefined();
    const active = weekByAgent(
      src(
        [old],
        [
          {
            conversation: old,
            last: { createdAt: start + 10 },
          } as ConversationSummary,
        ],
      ),
    );
    expect(active.get("emp1")).toEqual({ finished: 1, failed: 0 });
  });

  test("archived, still working, and a stopped turn are not this week's tally", () => {
    const counts = weekByAgent({
      ...src([
        conv({ id: "gone", archived: true, finishedSeq: 2 }),
        conv({ id: "live", engineRef: "s1", state: "active" }),
        conv({ id: "stopped", finishedSeq: 0, turnStopped: true }),
      ]),
      signals: { s1: { running: true, openRequests: new Map() } },
    });
    expect(counts.get("emp1")).toBeUndefined();
  });
});
