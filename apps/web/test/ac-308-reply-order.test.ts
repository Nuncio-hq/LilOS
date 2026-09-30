/* Issue #308 — a reply must anchor under the user message that prompted it,
   regardless of when its frames arrive. Live capture showed a follow-up
   posting before its answer's leg minted a turn: the reply then rendered
   BELOW the newer user message at its posted position, and post-turn legs
   stamped the settled turn id (merging into the previous answer).

   These tests pin the mapping layer: turns anchor by `turn.started.ref`
   (their prompting message), an engine-initiated leg renders as its own
   agent entry, and a ref'd turn is never text-claimed into a stranger's
   slot. */
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
  subagentJobs: [],
});

const u = (id: string, seq: number, text: string) => msg({ id, seq, text });
const a = (id: string, seq: number, text: string) =>
  msg({ id, seq, text, authorId: "emp", authorKind: "employee" });

describe("issue #308 — replies anchor to their own turn's question", () => {
  test("AC-1 an answer posted after a newer message still lands under its own prompt", () => {
    /* qA's turn completes; the relay row for its answer arrives after qB
       was posted (feed order [qA, qB, aA]). The card must sit under qA —
       anchoring by `ref`, not by the answer's posted position. */
    const replies = conversationReplies(
      [
        u("qA", 1, "first question"),
        u("qB", 2, "second question"),
        a("aA", 3, "answer to A"),
      ],
      "c1",
    );
    const t1 = turn({ turnId: "t1", ref: "qA", text: "answer to A" });
    const out = mergeTurns(replies, session([t1]), "emp");
    expect(out.map((r) => r.id)).toEqual(["qA", "aA", "qB"]);
    expect(out[1].text).toBe("answer to A");
  });

  test("AC-1 the live turn anchors under its prompting message while it streams", () => {
    /* qB's leg minted ref=qB; qC posts while it runs. The live card must
       sit right after qB, not parked below qC at the tail. */
    const replies = conversationReplies(
      [
        u("qA", 1, "first"),
        a("aA", 2, "done A"),
        u("qB", 3, "second"),
        u("qC", 4, "third"),
      ],
      "c1",
    );
    const live = turn({
      turnId: "t2",
      ref: "qB",
      phase: "text",
      text: "answering B…",
    });
    const t1 = turn({ turnId: "t1", ref: "qA", text: "done A" });
    const out = mergeTurns(replies, session([t1, live], live), "emp");
    expect(out.map((r) => r.id)).toEqual(["qA", "aA", "qB", "live-t2", "qC"]);
  });

  test("AC-2 an engine-initiated leg claims its own posted answer into one card", () => {
    /* A delivery leg finishes and the harness posts its text as a plain
       employee row — the leg claims that row so the answer renders ONCE
       (as the agent-initiated card, keeping the relay row's id). */
    const replies = conversationReplies(
      [
        u("qA", 1, "first"),
        a("aA", 2, "answer A"),
        a("aLeg", 3, "ZEBRA report"),
      ],
      "c1",
    );
    const t1 = turn({ turnId: "t1", ref: "qA", text: "answer A" });
    const leg = turn({
      turnId: "t2",
      agentInitiated: true,
      text: "ZEBRA report",
    });
    const out = mergeTurns(replies, session([t1, leg]), "emp");
    expect(out.map((r) => r.id)).toEqual(["qA", "aA", "aLeg"]);
    expect(out[2].agentInitiated).toBe(true);
    expect(out[2].phase).toBe("done");
  });

  test("AC-2 a leg never steals an already-claimed answer row", () => {
    /* Leg text identical to turn1's claimed answer — the leg's own post
       arrives as the newer row and only it may be claimed. */
    const replies = conversationReplies(
      [
        u("qA", 1, "first"),
        a("aA", 2, "same words"),
        a("aLeg", 3, "same words"),
      ],
      "c1",
    );
    const t1 = turn({ turnId: "t1", ref: "qA", text: "same words" });
    const leg = turn({
      turnId: "t2",
      agentInitiated: true,
      text: "same words",
    });
    const out = mergeTurns(replies, session([t1, leg]), "emp");
    expect(out.map((r) => r.id)).toEqual(["qA", "aA", "aLeg"]);
    expect(out[1].agentInitiated).toBeFalsy();
    expect(out[2].agentInitiated).toBe(true);
  });

  test("AC-3 a live agent leg renders right after the previous turn — a newer user message never sits above it", () => {
    /* The delivery leg is still running when the user posts again; the
       leg card anchors after the previous turn's block, not tail-appended
       below the newer message. */
    const replies = conversationReplies(
      [u("qA", 1, "first"), a("aA", 2, "answer A"), u("qB", 3, "meanwhile")],
      "c1",
    );
    const t1 = turn({ turnId: "t1", ref: "qA", text: "answer A" });
    const leg = turn({
      turnId: "t2",
      agentInitiated: true,
      phase: "text",
      text: "working…",
    });
    const out = mergeTurns(replies, session([t1, leg], leg), "emp");
    expect(out.map((r) => r.id)).toEqual(["qA", "aA", "live-t2", "qB"]);
  });

  test("AC-3 a finished leg's claimed card re-anchors above the user message that landed while it worked", () => {
    /* qB posted during the leg; the leg's answer row landed at the tail.
       The claimed card moves up to right after the previous turn — the
       user message renders below the work, in time order. */
    const replies = conversationReplies(
      [
        u("qA", 1, "first"),
        a("aA", 2, "answer A"),
        u("qB", 3, "meanwhile"),
        a("aLeg", 4, "ZEBRA report"),
      ],
      "c1",
    );
    const t1 = turn({ turnId: "t1", ref: "qA", text: "answer A" });
    const leg = turn({
      turnId: "t2",
      agentInitiated: true,
      text: "ZEBRA report",
    });
    const out = mergeTurns(replies, session([t1, leg]), "emp");
    expect(out.map((r) => r.id)).toEqual(["qA", "aA", "aLeg", "qB"]);
  });

  test("AC-1 a turn answering the root anchors at the top — newer messages never render above it", () => {
    /* The queued-message e2e (ac-27 AC-5b): turn1's prompt is the thread
       root, which dm.tsx filters out of `replies` — it renders as the
       thread header, so its answer anchors directly under the header at
       the TOP of the list; the queued prompt and its own answer follow. */
    const replies = conversationReplies(
      [
        u("q2", 2, "also mention bananas"),
        a("a1", 3, "Done on work: release note"),
        a("a2", 4, "Noted. Plan now: 2. Also mention bananas"),
      ],
      "c1",
    );
    const t1 = turn({
      turnId: "t1",
      ref: "q1-root",
      text: "Done on work: release note",
    });
    const t2 = turn({
      turnId: "t2",
      ref: "q2",
      text: "Noted. Plan now: 2. Also mention bananas",
    });
    const out = mergeTurns(
      replies,
      session([t1, t2]),
      "emp",
      [],
      undefined,
      undefined,
      "q1-root",
    );
    expect(out.map((r) => r.id)).toEqual(["a1", "q2", "a2"]);
  });

  test("AC-1 an anchored turn never leapfrogs a claimed card whose own ref is invisible", () => {
    /* Same layout but t1's ref is neither visible nor the thread root —
       its claimed card keeps the slot its relay row earned and turn2's
       anchored landing queues after it instead of hopping above. */
    const replies = conversationReplies(
      [
        u("q2", 2, "also mention bananas"),
        a("a1", 3, "Done on work: release note"),
        a("a2", 4, "Noted. Plan now: 2. Also mention bananas"),
      ],
      "c1",
    );
    const t1 = turn({
      turnId: "t1",
      ref: "q1-gone",
      text: "Done on work: release note",
    });
    const t2 = turn({
      turnId: "t2",
      ref: "q2",
      text: "Noted. Plan now: 2. Also mention bananas",
    });
    const out = mergeTurns(replies, session([t1, t2]), "emp");
    expect(out.map((r) => r.id)).toEqual(["q2", "a1", "a2"]);
  });

  test("AC-1 a ref'd turn is never text-claimed into a different message's slot", () => {
    /* Two identical answer texts: the ref'd turn anchors to its own
       prompt; the other employee message keeps its plain row. */
    const replies = conversationReplies(
      [u("qA", 1, "first"), u("qB", 2, "second"), a("aB", 3, "same words")],
      "c1",
    );
    const t1 = turn({ turnId: "t1", ref: "qA", text: "same words" });
    const out = mergeTurns(replies, session([t1]), "emp");
    expect(out.map((r) => r.id)).toEqual(["qA", "aB", "qB"]);
    /* out[1] is the turn's card (it claimed aB's relay row for its id) —
       anchored under its own prompt, not parked where the text matched. */
    expect(out[1].phase).toBe("done");
  });
});
