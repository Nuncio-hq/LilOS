/* Issue #659 — an agent reply rendered twice in one thread (ac-134 strict
   locators: two identical <p>s, run 37543572110 shard 3). Root cause is a
   cross-socket race: the harness posts the completed employee answer as a
   relay `message.created` row the instant `turn.completed` lands
   (finishTurn), while the web model accumulates `turn.delta` frames on the
   separate feed socket. When the row beats the delta tail, the model's turn
   text is a strict PREFIX of the posted row — or still empty — and the
   exact-text claim misses: the bare row renders beside the live card for
   the whole gap.

   These tests pin `mergeTurns`: the conversation's live turn claims an
   employee row whose text extends its streamed prefix (the in-flight
   deltas can only converge to the posted text), so the reply never
   renders twice at any point of the drain. */
import type { TurnModel } from "@lilos/client-runtime";
import type { AppMessage } from "@lilos/contracts/app";
import { describe, expect, test } from "vitest";
import { conversationReplies, mergeTurns } from "../src/lib/mapping";

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

const turn = (over: Partial<TurnModel>): TurnModel => ({
  turnId: "t1",
  phase: "done",
  reasoning: "",
  text: "",
  steps: [],
  steers: [],
  plans: [],
  requests: [],
  subagents: [],
  ...over,
});

const session = (turns: TurnModel[], live?: TurnModel) => ({
  sessionId: "s1",
  state: "idle" as const,
  turns,
  live,
  openRequests: [],
  jobs: [],
});

const u = (id: string, seq: number, text: string) => msg({ id, seq, text });
const a = (id: string, seq: number, text: string) =>
  msg({ id, seq, text, authorId: "emp", authorKind: "employee" });

const ANSWER = "Noted. Plan for this session now:\n\n1. ship it";

/* Surfaces visibly carrying the answer — the bare row's `text` or the
   card's `streaming`/settled `text`. The strict locator that caught #659
   fails when this is ever 2; while the card has claimed the row early its
   own streamed text is what shows, so 0 here just means "claimed before
   the first delta" — never a duplicate. */
const answerSurfaces = (out: { text: string; streaming?: string }[]) =>
  out.filter((r) => (r.streaming ?? r.text).includes("Noted. Plan"));

describe("issue #659 — an agent reply renders exactly once", () => {
  test("AC-2 the live turn claims the posted answer while its text is still a prefix", () => {
    /* a2 landed via message.created while the last turn.delta is still in
       flight — the card has streamed only "…now:" of the posted text. The
       live turn claims the row: one surface, not row + card. */
    const replies = conversationReplies(
      [u("q2", 1, "ship it"), a("a2", 2, ANSWER)],
      "c1",
    );
    const live = turn({
      turnId: "t2",
      ref: "q2",
      phase: "text",
      text: "Noted. Plan for this session now:",
    });
    const out = mergeTurns(replies, session([live], live), "emp");
    expect(answerSurfaces(out)).toHaveLength(1);
    /* the card kept the relay row's id (search anchor, #138). */
    expect(out.map((r) => r.id)).toEqual(["q2", "a2"]);
    expect(out[1].turnId).toBe("t2");
  });

  test("AC-2 the claim holds while every text delta is still in flight", () => {
    /* Harsher window: the row beat the WHOLE stream — the model knows the
       turn (turn.started) but no text delta has landed. The live turn
       still claims its in-flight post — the row never sits bare beside a
       card that is about to stream the same answer. */
    const replies = conversationReplies(
      [u("q2", 1, "ship it"), a("a2", 2, ANSWER)],
      "c1",
    );
    const live = turn({
      turnId: "t2",
      ref: "q2",
      phase: "reasoning",
      text: "",
    });
    const out = mergeTurns(replies, session([live], live), "emp");
    expect(out.map((r) => r.id)).toEqual(["q2", "a2"]);
    expect(out[1].turnId).toBe("t2");
    expect(answerSurfaces(out).length).toBeLessThanOrEqual(1);
  });

  test("AC-2 every mid-drain fold keeps a single surface", () => {
    /* Replay the paced stream: for each streamed prefix the fold must keep
       the answer on ONE reply — the race is not just the last delta, it is
       every frame the relay row can beat. */
    const replies = conversationReplies(
      [u("q2", 1, "ship it"), a("a2", 2, ANSWER)],
      "c1",
    );
    for (const delta of [
      "",
      "Noted. ",
      "Noted. Plan for this session ",
      "Noted. Plan for this session now:",
      "Noted. Plan for this session now:\n\n1. ship it",
    ]) {
      const live = turn({
        turnId: "t2",
        ref: "q2",
        phase: delta ? "text" : "reasoning",
        text: delta,
      });
      const out = mergeTurns(replies, session([live], live), "emp");
      expect(answerSurfaces(out).length).toBeLessThanOrEqual(1);
      expect(out.map((r) => r.id)).toEqual(["q2", "a2"]);
    }
  });

  test("AC-2 a settled turn never prefix-claims — only the live turn may", () => {
    /* Guard: the relaxation is live-only. A finished turn's post is its
       full text, so a row it merely prefixes is not its answer — the row
       stays bare instead of being glued to the wrong card. */
    const replies = conversationReplies(
      [u("q2", 1, "ship it"), a("a2", 2, ANSWER)],
      "c1",
    );
    const settled = turn({
      turnId: "t2",
      ref: "q2",
      phase: "done",
      text: "Noted. Plan for this session now:",
    });
    const out = mergeTurns(replies, session([settled]), "emp");
    /* not claimed: the row keeps its own id and the settled card renders
       separately (its ref is visible, so the orphan drop does not apply). */
    expect(out.map((r) => r.id)).toEqual(["q2", "live-t2", "a2"]);
  });

  test("AC-2 the live turn never reaches behind its own prompt", () => {
    /* A row that renders BEFORE the live turn's prompt is a different
       answer — position binding still outranks the prefix claim. */
    const replies = conversationReplies(
      [u("q1", 1, "first"), a("a1", 2, ANSWER), u("q2", 3, "ship it again")],
      "c1",
    );
    const live = turn({
      turnId: "t2",
      ref: "q2",
      phase: "text",
      text: "Noted. Plan for this session now:",
    });
    const out = mergeTurns(replies, session([live], live), "emp");
    /* a1 stays a bare row ahead of q2; the card anchors under q2. */
    expect(out.map((r) => r.id)).toEqual(["q1", "a1", "q2", "live-t2"]);
  });
});
