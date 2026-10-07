/* Issue #553 — the Mac renders the shared QuestionCard for a real
   `question` ask, like the phone (AC-1): liveTurnReply maps the ask onto
   r.question so cards.tsx mounts the shared card; a resolved ask keeps
   the card up as its receipt, which names the answer's label — the
   option's human wording, or the typed text itself (AC-2). */
import type { SessionModel, TurnModel } from "@lilos/client-runtime";
import type { Ask } from "@lilos/contracts/app";
import { describe, expect, test } from "vitest";
import { liveTurnReply, questionReceipt } from "../src/lib/mapping";

const turn = (over: Partial<TurnModel> = {}): TurnModel => ({
  turnId: "t1",
  phase: "waiting",
  reasoning: "thinking…",
  text: "",
  steps: [],
  steers: [],
  plans: [],
  requests: [],
  subagents: [],
  ...over,
});

const qAsk = (over: Partial<Ask> = {}): Ask => ({
  id: "ask-1",
  channelId: "ch1",
  conversationId: "c1",
  turnId: "t1",
  requestId: "r1",
  request: {
    kind: "question",
    question: "Where should #96 land?",
    options: [
      { id: "cherry-pick", label: "Cherry-pick to `release/0.1`" },
      { id: "next-train", label: "Keep it on main" },
    ],
    freeText: true,
  },
  state: "open",
  createdAt: 0,
  ...over,
});

const approvalAsk = (over: Partial<Ask> = {}): Ask =>
  qAsk({
    request: {
      kind: "approval",
      command: "bun run build",
      options: ["once", "deny"],
    },
    ...over,
  });

describe("#553 shared question card on the Mac", () => {
  test("AC-1 an open question ask maps onto r.question with options + freeText", () => {
    const t = turn({
      requests: [
        {
          requestId: "r1",
          turnId: "t1",
          request: qAsk().request,
        },
      ],
    });
    const r = liveTurnReply(t, "emp", [qAsk()]);
    expect(r.question).toEqual({
      id: "ask-1",
      question: "Where should #96 land?",
      options: [
        { id: "cherry-pick", label: "Cherry-pick to `release/0.1`" },
        { id: "next-train", label: "Keep it on main" },
      ],
      freeText: true,
    });
    expect(r.waitingOn).toBe("question");
  });

  test("AC-2 a resolved question keeps its card — the receipt rides resolved[]", () => {
    const done: Ask = {
      ...qAsk(),
      state: "resolved",
      outcome: "answer",
      answer: "cherry-pick",
    };
    const t = turn({
      phase: "reasoning",
      requests: [
        {
          requestId: "r1",
          turnId: "t1",
          request: done.request,
          outcome: "answer",
          answer: "cherry-pick",
        },
      ],
    });
    const r = liveTurnReply(t, "emp", [done]);
    expect(r.question?.id).toBe("ask-1");
  });

  test("an approval ask maps to r.approval, never r.question", () => {
    const r = liveTurnReply(turn(), "emp", [approvalAsk()]);
    expect(r.approval?.command).toBe("bun run build");
    expect(r.question).toBeUndefined();
  });

  test("questionReceipt names the picked option's label", () => {
    const done: Ask = {
      ...qAsk(),
      state: "resolved",
      outcome: "answer",
      answer: "cherry-pick",
    };
    expect(questionReceipt(done, "Riley")).toBe(
      "Answered “Cherry-pick to `release/0.1`” by Riley",
    );
  });

  test("questionReceipt names the typed text when the answer is no option", () => {
    const done: Ask = {
      ...qAsk(),
      state: "resolved",
      outcome: "answer",
      answer: "hold it until Friday",
    };
    expect(questionReceipt(done, "Riley")).toBe(
      "Answered “hold it until Friday” by Riley",
    );
  });

  test("questionReceipt reads cancelled for a skip", () => {
    const done: Ask = { ...qAsk(), state: "resolved", outcome: "cancel" };
    expect(questionReceipt(done, "Riley")).toBe("Cancelled by Riley");
  });
});
