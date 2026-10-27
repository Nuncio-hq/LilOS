/* v3 Threads: archived threads leave the live list for `archivedThreads`
   (and come back with the flag), ⌘K's message hits read as the palette
   needs them (a LilOS note says "system", never "you"). */
import type {
  AppChannel,
  Conversation,
  ConversationSummary,
  MessageSearchHit,
} from "@lilos/contracts/app";
import { describe, expect, test } from "vitest";

import { messageHitOf } from "../src/v3/search";
import {
  type ThreadSources,
  v3ArchivedThreads,
  v3Threads,
} from "../src/v3/threads";

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
    createdAt: 0,
    ...over,
  }) as Conversation;

const sources = (conversations: Conversation[]): ThreadSources => ({
  now: 10 * 60_000,
  conversations,
  summaries: [],
  channels: [channel],
  employees: [],
  models: {},
  signals: {},
  asks: [],
});

describe("archived threads", () => {
  const src = sources([
    conv({ id: "live", title: "Live one" }),
    conv({ id: "gone", title: "Put away", archived: true }),
  ]);

  test("leave the live list and fill the archived one", () => {
    expect(v3Threads(src).map((t) => t.id)).toEqual(["live"]);
    expect(v3ArchivedThreads(src).map((t) => t.id)).toEqual(["gone"]);
  });

  test("keep their title, so Threads → All → Archived can name them", () => {
    expect(v3ArchivedThreads(src)[0].title).toBe("Put away");
  });

  test("a thread unarchived is back in the live list only", () => {
    const back = sources([conv({ id: "gone", archived: false })]);
    expect(v3Threads(back).map((t) => t.id)).toEqual(["gone"]);
    expect(v3ArchivedThreads(back)).toEqual([]);
  });

  test("a finished-not-seen thread carries minutes since it finished", () => {
    const now = 12 * 60_000;
    const done = conv({
      id: "done",
      createdAt: 0,
      finishedSeq: 2,
      readSeq: 0,
    });
    const src = sources([done]);
    src.now = now;
    const summary: ConversationSummary = {
      conversation: done,
      root: {
        id: "m1",
        conversationId: "done",
        authorId: "u",
        authorKind: "user",
        text: "go",
        seq: 1,
        createdAt: 0,
      },
      last: {
        id: "m2",
        conversationId: "done",
        authorId: "emp1",
        authorKind: "employee",
        text: "done",
        seq: 2,
        createdAt: 2 * 60_000,
      },
      messageCount: 2,
    };
    src.summaries = [summary];
    const row = v3Threads(src)[0];
    expect(row.unseen).toBe(true);
    expect(row.doneAgo).toBe(10);
  });
});

const hit = (over: Partial<MessageSearchHit>): MessageSearchHit => ({
  messageId: "m9",
  conversationId: "c1",
  channelId: "ch1",
  authorId: "emp1",
  authorKind: "employee",
  snippet: "the <mark>deploy</mark> log",
  createdAt: 0,
  ...over,
});

describe("message hits", () => {
  const now = 10 * 60_000;

  test("name the message, its thread and its author", () => {
    expect(messageHitOf(hit({}), now)).toMatchObject({
      messageId: "m9",
      threadId: "c1",
      by: "emp1",
      snippet: "the <mark>deploy</mark> log",
    });
  });

  test("a LilOS note is system, even when it carries the user's author id", () => {
    expect(
      messageHitOf(hit({ authorId: "user", authorKind: "system" }), now)?.by,
    ).toBe("system");
  });

  test("your own message is you", () => {
    expect(
      messageHitOf(hit({ authorId: "user", authorKind: "user" }), now)?.by,
    ).toBe("you");
  });

  test("a hit that belongs to no thread cannot be opened, so it is dropped", () => {
    expect(messageHitOf(hit({ conversationId: null }), now)).toBeUndefined();
  });
});
