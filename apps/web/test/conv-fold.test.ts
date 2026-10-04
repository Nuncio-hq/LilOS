/* Issue #427 — the DM page's per-conversation fold cache. The fold
   (waitingMessages + conversationReplies + mergeTurns + toFeed) used to run
   for EVERY conversation on every render; FoldCache keys each conv's fold
   on the inputs it reads so a word streaming into one session recomputes
   only that conversation. */
import type { SessionModel } from "@lilos/client-runtime";
import type { AppMessage, Conversation, Employee } from "@lilos/contracts/app";
import { describe, expect, test } from "vitest";
import { FoldCache, type FoldInputs } from "../src/lib/conv-fold";

const msg = (over: Partial<AppMessage>): AppMessage => ({
  id: "m1",
  channelId: "ch1",
  conversationId: "c1",
  authorId: "me",
  authorKind: "user",
  text: "",
  seq: 1,
  createdAt: 0,
  rewound: false,
  dropped: false,
  removed: false,
  claimed: false,
  ...over,
});

const conv = (id: string): Conversation => ({
  id,
  channelId: "ch1",
  rootMessageId: `root-${id}`,
  engineRef: `s-${id}`,
  state: "active",
  title: "",
  titleSource: "auto",
  access: "ask",
  archived: false,
  deliveredSeq: 0,
  createdAt: 0,
});

const EMP: Employee = {
  id: "e1",
  name: "Ada",
  role: "engineer",
  status: "online",
  profile: "ada",
  model: "m",
  now: "",
  instructions: "",
  respondTo: "anyone",
  createdAt: 0,
};

const model = (over: Partial<SessionModel> = {}): SessionModel => ({
  sessionId: "s1",
  state: "idle",
  turns: [],
  openRequests: [],
  jobs: [],
  subagentJobs: [],
  ...over,
});

/* Relay rows keep their identity between reads — the fold's key compares
   by reference, so fixtures do the same. */
const roots = new Map<string, AppMessage>();
const rootFor = (c: Conversation) => {
  let r = roots.get(c.id);
  if (!r) {
    r = msg({ id: c.rootMessageId, conversationId: c.id });
    roots.set(c.id, r);
  }
  return r;
};

const EMPS = [EMP];
const NO_CWD: FoldInputs["cwdInfo"] = {};

const inputs = (
  c: Conversation,
  over: Partial<FoldInputs> = {},
): FoldInputs => ({
  conv: c,
  model: undefined,
  msgs: [],
  asks: [],
  rewoundEvent: undefined,
  summary: undefined,
  root: rootFor(c),
  employees: EMPS,
  cwdInfo: NO_CWD,
  employeeId: "e1",
  ...over,
});

describe("AC-427 FoldCache", () => {
  test("same inputs return the same fold", () => {
    const cache = new FoldCache();
    const c = conv("c1");
    const i = inputs(c);
    const a = cache.for(i);
    expect(cache.for(i)).toBe(a);
    expect(cache.for(inputs(c))).toBe(a);
  });

  test("a changed conversation refolds while an untouched one hits", () => {
    const cache = new FoldCache();
    const c1 = conv("c1");
    const c2 = conv("c2");
    const i1 = inputs(c1);
    const a1 = cache.for(i1);
    cache.for(inputs(c2));

    /* conv2's slice gains a message — conv1's fold must be the same object
       (no recompute), conv2's a new one. */
    const b1 = cache.for(i1);
    const b2 = cache.for(inputs(c2, { msgs: [msg({ id: "m-x" })] }));
    expect(b1).toBe(a1);
    expect(b2.replies).not.toBe(a1.replies);
  });

  test("a new slice array with the same rows still hits (elementwise)", () => {
    const cache = new FoldCache();
    const c = conv("c1");
    const rows = [msg({ id: "m-a" })];
    const a = cache.for(inputs(c, { msgs: rows }));
    expect(cache.for(inputs(c, { msgs: [...rows] }))).toBe(a);
    /* …but a replaced row (the relay's immutable update) must refold. */
    const changed = cache.for(
      inputs(c, { msgs: [{ ...rows[0], text: "edited" }] }),
    );
    expect(changed).not.toBe(a);
  });

  test("its own session model change refolds only that conversation", () => {
    const cache = new FoldCache();
    const c1 = conv("c1");
    const c2 = conv("c2");
    const i2 = inputs(c2);
    const a1 = cache.for(inputs(c1));
    const a2 = cache.for(i2);
    /* conv1's model rebuilds on a delta — conv1 refolds, conv2 stays put. */
    const b1 = cache.for(inputs(c1, { model: model({ state: "running" }) }));
    const b2 = cache.for(i2);
    expect(b1).not.toBe(a1);
    expect(b2).toBe(a2);
  });

  test("rewind + summary inputs gate the fold", () => {
    const cache = new FoldCache();
    const c = conv("c1");
    const a = cache.for(inputs(c));
    /* The atom keeps the event object until a newer rewind lands. */
    const event = { fromSeq: 5, removedIds: ["m9"] };
    const b = cache.for(inputs(c, { rewoundEvent: event }));
    expect(b).not.toBe(a);
    expect(cache.for(inputs(c, { rewoundEvent: event }))).toBe(b);
  });

  test("thread extras cache separately on the same entry", () => {
    const cache = new FoldCache();
    const c = conv("c1");
    const i = inputs(c);
    const t = { rootId: "root-c1", planCap: true };
    const a = cache.thread(i, t);
    const b = cache.thread(i, t);
    expect(b.thread).toBe(a.thread);
    expect(b.feed).toBe(a.feed);
    /* A thread-only input change keeps the shared feed fold. */
    const d = cache.thread(i, { rootId: "other", planCap: true });
    expect(d.feed).toBe(a.feed);
    expect(d.thread).not.toBe(a.thread);
  });

  test("sweep drops conversations the pass no longer lists", () => {
    const cache = new FoldCache();
    const c1 = conv("c1");
    const c2 = conv("c2");
    cache.reset();
    const a1 = cache.for(inputs(c1));
    const a2 = cache.for(inputs(c2));
    cache.sweep();
    /* Both listed → both entries survive the sweep. */
    cache.reset();
    expect(cache.for(inputs(c1))).toBe(a1);
    expect(cache.for(inputs(c2))).toBe(a2);
    cache.sweep();
    /* A pass that never lists c2 drops its entry — the next read rebuilds
       rather than serving the stale fold. */
    cache.reset();
    cache.for(inputs(c1));
    cache.sweep();
    cache.reset();
    expect(cache.for(inputs(c1))).toBe(a1);
    expect(cache.for(inputs(c2))).not.toBe(a2);
  });

  test("the feed row keeps summary padding + scoped turn keys", () => {
    const cache = new FoldCache();
    const c = conv("c1");
    const root = msg({ id: c.rootMessageId, conversationId: c.id });
    const summary = {
      conversation: c,
      root,
      last: root,
      messageCount: 4,
    };
    const f = cache.for(inputs(c, { summary, msgs: [root] }));
    /* want = messageCount - 1 = 3 replies, padded with placeholders. */
    expect(f.replies).toHaveLength(3);
    expect(f.msg?.id).toBe("root-c1");
    expect(
      f.replies.every((r) => !r.turnId || r.turnId.startsWith("c1:")),
    ).toBe(true);
  });
});
