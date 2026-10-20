/* #769: one status per thread, the word every v3 surface shows. The rule is
   a precedence list; getting it wrong shows Oscar the wrong thing (a thread
   waiting on him reading "Working", a failed one reading "Idle"), so each
   step of the order is pinned here, plus the unwatched-session path. */
import {
  type Conversation,
  Conversation as ConversationSchema,
} from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { threadStatus } from "../src/thread-status";
import type { SessionModel } from "../src/turn-model";

const conv = (patch: Partial<Conversation> = {}): Conversation =>
  ConversationSchema.parse({
    id: "conv1",
    channelId: "c1",
    rootMessageId: "m1",
    engineRef: "s1",
    state: "idle",
    title: "",
    archived: false,
    createdAt: 1,
    ...patch,
  });

const signal = (running: boolean, asks = 0) => ({
  running,
  openRequests: { size: asks },
});

const model = (patch: Partial<SessionModel>): SessionModel =>
  ({ openRequests: [], live: undefined, ...patch }) as unknown as SessionModel;

describe("threadStatus", () => {
  it("an open request beats a running turn: needs you", () => {
    expect(
      threadStatus(conv({ state: "active" }), undefined, signal(true, 1)),
    ).toBe("needs");
  });

  it("a live turn parked on a request reads needs, not working", () => {
    const m = model({
      live: { phase: "waiting" } as SessionModel["live"],
      openRequests: [{}] as SessionModel["openRequests"],
    });
    expect(threadStatus(conv(), m, undefined)).toBe("needs");
  });

  it("a running turn is working, even when the last one failed", () => {
    const c = conv({ turnFailure: { kind: "generic", text: "boom" } });
    expect(threadStatus(c, undefined, signal(true))).toBe("working");
  });

  it("a failed last turn beats finished-not-seen", () => {
    const c = conv({
      turnFailure: { kind: "generic", text: "boom" },
      finishedSeq: 5,
      readSeq: 2,
    });
    expect(threadStatus(c, undefined, signal(false))).toBe("failed");
  });

  it("a finish past the read mark is unseen; at the mark it is idle", () => {
    expect(
      threadStatus(
        conv({ finishedSeq: 5, readSeq: 2 }),
        undefined,
        signal(false),
      ),
    ).toBe("unseen");
    expect(
      threadStatus(
        conv({ finishedSeq: 5, readSeq: 5 }),
        undefined,
        signal(false),
      ),
    ).toBe("idle");
  });

  it("an unwatched session with no signal yet falls back to the row's state", () => {
    expect(threadStatus(conv({ state: "active" }), undefined, undefined)).toBe(
      "working",
    );
  });

  it("a thread with no engine session is never working", () => {
    expect(
      threadStatus(
        conv({ engineRef: null, state: "active" }),
        undefined,
        undefined,
      ),
    ).toBe("idle");
  });
});
