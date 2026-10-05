import { describe, expect, it } from "vitest";
import {
  isAnswerableQuestion,
  waitingOnQuestion,
} from "../src/employees/question-gate";
import type { AgentEntry, Approval } from "../src/employees/types";

/* #420: the waiting surfaces (composer copy, the hidden context ring) key
   on `waitingOnQuestion` — and ONLY on a question ask this card can
   answer. A real-app question ask maps no options/freeText onto its
   Approval view-model (apps/mobile/src/thread-model.ts), so it must keep
   reporting false: the shipping app stays on the Reply composer and the
   context ring until the real-app slice wires answers end to end
   (Hermes FIX #515). */

const ask = (over: Partial<Approval> = {}): Approval => ({
  id: "a1",
  employeeId: "e-rev",
  employee: "Reviewer",
  tone: "mint",
  session: "s-1",
  reason: "Where does the fix land?",
  age: "1m",
  ...over,
});

const liveTurn = (approval?: Approval): AgentEntry => ({
  kind: "agent",
  id: "g1",
  time: "10:00",
  live: true,
  ...(approval ? { approval } : {}),
});

describe("waitingOnQuestion — waiting is a question the card can answer", () => {
  it("a live turn parked on an optioned question waits", () => {
    expect(
      waitingOnQuestion([
        liveTurn(
          ask({ kind: "question", options: [{ id: "o1", title: "Main" }] }),
        ),
      ]),
    ).toBe(true);
  });

  it("a live turn parked on a free-text-only question waits", () => {
    expect(
      waitingOnQuestion([liveTurn(ask({ kind: "question", freeText: true }))]),
    ).toBe(true);
  });

  it("a real-app question ask (no options/freeText) does NOT wait — inert", () => {
    expect(waitingOnQuestion([liveTurn(ask({ kind: "question" }))])).toBe(
      false,
    );
  });

  it("a live turn parked on an approval ask does NOT wait", () => {
    expect(waitingOnQuestion([liveTurn(ask({ kind: "approval" }))])).toBe(
      false,
    );
    expect(waitingOnQuestion([liveTurn(ask())])).toBe(false);
  });

  it("a finished turn with an answered question does NOT wait", () => {
    expect(
      waitingOnQuestion([
        { ...liveTurn(ask({ kind: "question", options: [] })), live: false },
      ]),
    ).toBe(false);
  });

  it("a live turn carrying no ask does NOT wait", () => {
    expect(waitingOnQuestion([liveTurn()])).toBe(false);
    expect(waitingOnQuestion([])).toBe(false);
  });
});

describe("isAnswerableQuestion — the answerable-ask gate", () => {
  it("question + options or freeText answers; question alone can't", () => {
    expect(isAnswerableQuestion(ask({ kind: "question" }))).toBe(false);
    expect(
      isAnswerableQuestion(ask({ kind: "question", freeText: true })),
    ).toBe(true);
    expect(
      isAnswerableQuestion(
        ask({ kind: "question", options: [{ id: "o1", title: "Main" }] }),
      ),
    ).toBe(true);
  });

  it("an approval ask is never a question, options or not", () => {
    expect(
      isAnswerableQuestion(
        ask({ kind: "approval", options: [{ id: "o1", title: "Main" }] }),
      ),
    ).toBe(false);
  });
});
