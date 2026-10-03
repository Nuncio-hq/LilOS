/* #346 AC-4: the web ring reads real session life. The wire carries a
   persistent `open | closed` bit (the harness writes it when the reaper
   suspends a session); `sessionLife` — the prototype's single rule —
   layers the live `running` hint on top. `toFeed` must pass the bit
   through so the thread renders real state. */
import type { AppMessage, Conversation } from "@lilos/contracts/app";
import { sessionLife } from "@lilos/ui";
import type { Reply, Thread } from "@lilos/ui/types";
import { describe, expect, it } from "vitest";
import { toFeed } from "../src/lib/mapping";

const conv = (over: Partial<Conversation>): Conversation => ({
  id: "c1",
  channelId: "ch-dm",
  rootMessageId: "m1",
  engineRef: "sess-1",
  state: "idle",
  title: "DM",
  titleSource: "auto",
  archived: false,
  deliveredSeq: 1,
  createdAt: 0,
  ...over,
});

const root = msg();
function msg(): AppMessage {
  return {
    id: "m1",
    channelId: "ch-dm",
    conversationId: "c1",
    authorId: "oscar",
    authorKind: "user",
    text: "do the thing",
    seq: 1,
    createdAt: 0,
    rewound: false,
    dropped: false,
    removed: false,
  };
}

const reply = (over: Partial<Reply>): Reply => ({
  from: "builder",
  time: "now",
  text: "done",
  ...over,
});

const thread = (life: Thread["life"], replies: Reply[]): Thread => ({
  session: "sess-1",
  ...(life ? { life } : {}),
  replies,
});

describe("#346 AC-4 the ring reads real session life", () => {
  it("toFeed carries the conversation's life bit onto the thread", () => {
    const feed = toFeed(root, conv({ life: "closed" }), []);
    if (feed.kind !== "msg") throw new Error("expected a msg row");
    expect(feed.thread?.life).toBe("closed");
    // never written → unset, not a stale closed.
    const openFeed = toFeed(root, conv({}), []);
    if (openFeed.kind !== "msg") throw new Error("expected a msg row");
    expect(openFeed.thread?.life).toBeUndefined();
  });

  it("sessionLife layers running over the wire bit — one rule, both states", () => {
    const live = reply({ live: true });
    const waiting = reply({ live: true, phase: "waiting" });
    const done = reply({ live: false });
    // live work on a suspended thread still renders running
    expect(sessionLife(thread("closed", [live]))).toBe("running");
    // live but waiting on the user → open, like the prototype rule
    expect(sessionLife(thread("closed", [waiting]))).toBe("open");
    // quiet + the wire bit → the ring is closed
    expect(sessionLife(thread("closed", [done]))).toBe("closed");
    // quiet + open bit (or none) → open
    expect(sessionLife(thread("open", [done]))).toBe("open");
    expect(sessionLife(thread(undefined, [done]))).toBe("open");
  });
});
