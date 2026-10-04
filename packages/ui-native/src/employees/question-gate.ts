import type { Approval, ThreadEntry } from "./types";

/* #420: which asks the question card answers, and whether the thread is
   parked on one. Pure logic kept out of question-card.tsx (RN imports)
   so surfaces and tests can use it without a native runtime — the
   approval-copy pattern. */

/* A question ask the card can actually answer. Prototype asks carry
   `options`/`freeText`; the real app's Approval view-model doesn't map
   them yet, so those asks stay on the old Deny-only card until the
   real-app slice wires answers end to end. */
export const isAnswerableQuestion = (a: Approval) =>
  a.kind === "question" && (a.options != null || a.freeText != null);

/* The thread is parked on an open question the card can answer — the
   surfaces that read "waiting" (composer copy, the hidden context ring)
   key on this. A real-app question ask carries no options/freeText, so
   it reports false and every surface stays exactly as it was. */
export const waitingOnQuestion = (entries: ThreadEntry[]) =>
  entries.some(
    (e) =>
      e.kind === "agent" &&
      !!e.live &&
      !!e.approval &&
      isAnswerableQuestion(e.approval),
  );
