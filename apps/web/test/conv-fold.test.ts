/* Issue #427 — the DM page's per-conversation fold cache. The fold
   (waitingMessages + conversationReplies + mergeTurns + toFeed) used to run
   for EVERY conversation on every render; FoldCache keys each conv's fold
   on the inputs it reads so a word streaming into one session recomputes
   only that conversation. */
import type { SessionModel } from "@lilos/client-runtime";
import type {
  AppMessage,
  Conversation,
  Employee,
  MessageAttachment,
} from "@lilos/contracts/app";
import type { Msg } from "@lilos/ui/types";
import { afterEach, describe, expect, test } from "vitest";
import { attachmentUrls } from "../src/lib/attachments";
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
  bound: undefined,
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
  /* The url atom is module state — every attachment test resets it. */
  afterEach(() => attachmentUrls.set({}));
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

  test("bound 'pending' holds engine posts until the attached model refolds (#467)", () => {
    const cache = new FoldCache();
    const c = { ...conv("c1"), deliveredSeq: 10 };
    const usr = msg({ id: "m-usr", authorId: "me", text: "yo", seq: 1 });
    const emp = msg({
      id: "m-emp",
      authorKind: "employee",
      authorId: "e1",
      text: "hi",
      seq: 2,
    });
    /* The session model is already reduced (waitingMessages pairs against
       it) but the feed's attach watermark hasn't landed: mergeTurns must
       hold the employee row, and the cache must key on THAT — else the
       "pending" fold would keep serving after attach. */
    const m = model({ state: "running" });
    const pending = cache.for(
      inputs(c, { model: m, bound: "pending", msgs: [usr, emp] }),
    );
    expect(pending.replies.map((r) => r.id)).toEqual(["m-usr"]);
    /* Same inputs, feed now attached: the held row appears — a re-fold, not
       the stale pending entry. */
    const attached = cache.for(
      inputs(c, { model: m, bound: m, msgs: [usr, emp] }),
    );
    expect(attached).not.toBe(pending);
    expect(attached.replies.map((r) => r.id)).toEqual(["m-usr", "m-emp"]);
    /* And it stays folded: the attached fold caches on its own key. */
    expect(cache.for(inputs(c, { model: m, bound: m, msgs: [usr, emp] }))).toBe(
      attached,
    );
  });

  test("an attachment ref resolving refolds the row's chips (#112/#572)", () => {
    /* The fold bakes `toAttachedFiles` urls at compute time. Before #572
       every session's feed replay churned inputs enough to hide it; an
       unwatched session folds once, so the resolved urls must key the
       fold or the row keeps `url: undefined` forever. */
    const cache = new FoldCache();
    const c = conv("c1");
    const att: MessageAttachment = {
      id: "att-1",
      name: "stored.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const root = msg({
      id: c.rootMessageId,
      conversationId: c.id,
      attachments: [att],
    });
    const before = cache.for(
      inputs(c, { root, msgs: [root], urls: [undefined] }),
    );
    const feedMsg = (m: Msg | null | undefined) =>
      m?.kind === "msg" ? m : undefined;
    expect(feedMsg(before.msg)?.attachments?.[0]?.url).toBeUndefined();
    attachmentUrls.set({ "att-1": "data:image/png;base64,AAAA" });
    const after = cache.for(
      inputs(c, { root, msgs: [root], urls: ["data:image/png;base64,AAAA"] }),
    );
    expect(after).not.toBe(before);
    expect(feedMsg(after.msg)?.attachments?.[0]?.url).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  test("a reply folded before its ref resolves isn't frozen thumbnail-less", () => {
    /* msgReplyCache keys replies on the message row — a reply cached with
       `url: undefined` must recheck on the next fold or the thumbnail
       never lands (same #572 hole, one level down). */
    const cache = new FoldCache();
    const c = { ...conv("c1"), deliveredSeq: 10 };
    const att: MessageAttachment = {
      id: "att-2",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const m = msg({
      id: "m-img",
      conversationId: c.id,
      attachments: [att],
    });
    const before = cache.for(inputs(c, { msgs: [m], urls: [undefined] }));
    const beforeReply = before.replies.find((r) => r.id === "m-img");
    expect(beforeReply?.attachments?.[0]?.name).toBe("shot.png");
    expect(beforeReply?.attachments?.[0]?.url).toBeUndefined();
    attachmentUrls.set({ "att-2": "data:image/png;base64,BBBB" });
    const after = cache.for(
      inputs(c, { msgs: [m], urls: ["data:image/png;base64,BBBB"] }),
    );
    const reply = after.replies.find((r) => r.id === "m-img");
    expect(reply?.attachments?.[0]?.url).toBe("data:image/png;base64,BBBB");
    /* …and once resolved it caches like anything else. */
    expect(
      cache.for(inputs(c, { msgs: [m], urls: ["data:image/png;base64,BBBB"] })),
    ).toBe(after);
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

/* #430 — the fold's identity contract: the incremental reducer keeps an
   untouched TurnModel's object identity across a delta; the fold must
   carry that through to the `Reply` objects the memoized rows compare.
   A delta that only extends the tail therefore produces the SAME reply
   objects for every turn it didn't touch. */
describe("AC-430 fold identity — a delta reuses untouched turns' Replies", () => {
  const turn = (turnId: string, text: string): SessionModel["turns"][0] => ({
    turnId,
    phase: "done",
    reasoning: "",
    text,
    steps: [],
    steers: [],
    requests: [],
    plans: [],
    subagents: [],
  });

  /* Fold inputs that must be identity-stable share fixtures — the real
     page feeds atom-held slices (asks/msgs stay put until a write). */
  const ASKS: FoldInputs["asks"] = [];

  test("a tail delta reuses the untouched turn's reply objects (and no double scope)", () => {
    const cache = new FoldCache();
    const c = { ...conv("c1"), deliveredSeq: 10 };
    const q = msg({ id: "m-q", authorId: "me", text: "question?", seq: 1 });
    const ta = turn("ta", "answer A");
    const tb = turn("tb", "answer B");
    const m1 = model({ sessionId: "s-c1", turns: [ta, tb] });
    const f1 = cache.for(
      inputs(c, { msgs: [q], model: m1, bound: m1, asks: ASKS }),
    );
    expect(f1.replies).toHaveLength(3); // q + turn a + turn b

    /* The reducer's clone-on-write: tb lands as a NEW object, ta is the
       same one. The fold rebuilds — but only tb's replies are new. */
    const tb2 = { ...tb, text: "answer B, more" };
    const m2 = model({ sessionId: "s-c1", turns: [ta, tb2] });
    const f2 = cache.for(
      inputs(c, { msgs: [q], model: m2, bound: m2, asks: ASKS }),
    );
    expect(f2).not.toBe(f1);
    const byTurn = (rs: typeof f1.replies) =>
      new Map(rs.map((r) => [r.turnId, r]));
    expect(byTurn(f2.replies).get("c1:ta")).toBe(
      byTurn(f1.replies).get("c1:ta"),
    );
    expect(byTurn(f2.replies).get("c1:tb")).not.toBe(
      byTurn(f1.replies).get("c1:tb"),
    );
    /* The relay row's Reply kept its identity through the message cache. */
    expect(f2.replies[0]).toBe(f1.replies[0]);
    /* Scoped once — the cached reply's turnId never re-prefixes. */
    expect(byTurn(f2.replies).get("c1:ta")?.turnId).toBe("c1:ta");
  });

  test("two conversations on one session scope separately (no c1:c1 or cross talk)", () => {
    const cache = new FoldCache();
    const c1 = conv("c1");
    const c2 = conv("c2");
    const ta = turn("ta", "answer A");
    const m = model({ sessionId: "shared", turns: [ta] });
    /* Same TurnModel folded under both conversations — each fold rescopes
       in place, so the block cache must key on the conversation too. */
    const f1 = cache.for(
      inputs(c1, { msgs: [], model: m, bound: m, asks: ASKS }),
    );
    const f2 = cache.for(
      inputs(c2, { msgs: [], model: m, bound: m, asks: ASKS }),
    );
    expect(f1.replies[0].turnId).toBe("c1:ta");
    expect(f2.replies[0].turnId).toBe("c2:ta");
    /* And a refold for c1 keeps its own scoped reply — not c2's. */
    const f3 = cache.for(
      inputs(c1, { msgs: [], model: m, bound: m, asks: ASKS }),
    );
    expect(f3).toBe(f1);
    expect(f1.replies[0].turnId).toBe("c1:ta");
  });

  test("an asks change rebuilds turn replies (the variant key covers asks)", () => {
    const cache = new FoldCache();
    const c = conv("c1");
    const ta = turn("ta", "answer A");
    const m = model({ sessionId: "s-c1", turns: [ta] });
    const ask = { id: "a1" } as FoldInputs["asks"][0];
    const f1 = cache.for(
      inputs(c, { msgs: [], model: m, bound: m, asks: [ask] }),
    );
    const f2 = cache.for(
      inputs(c, { msgs: [], model: m, bound: m, asks: [ask, ask] }),
    );
    expect(f2).not.toBe(f1);
    expect(f2.replies[0]).not.toBe(f1.replies[0]);
  });

  test("the open thread's strip keeps identity through planCap folds", () => {
    const cache = new FoldCache();
    const c = conv("c1");
    const ta = turn("ta", "answer A");
    const m = model({ sessionId: "s-c1", turns: [ta] });
    const i = inputs(c, { msgs: [], model: m, bound: m, asks: ASKS });
    /* planCap off strips plan rows — the strip is cached like the rest. */
    const t1 = cache.thread(i, { rootId: "x", planCap: false });
    const t2 = cache.thread({ ...i }, { rootId: "x", planCap: false });
    expect(t2.thread).toBe(t1.thread);
    /* A refold on new inputs (same values) hits the same cache entry —
       the strip map keeps reply identity inside it. */
    const m2 = model({ sessionId: "s-c1", turns: [ta] });
    const t3 = cache.thread(
      inputs(c, { msgs: [], model: m2, bound: m2, asks: ASKS }),
      { rootId: "x", planCap: false },
    );
    expect(t3.thread.replies[0]).toBe(t1.thread.replies[0]);
  });
});
