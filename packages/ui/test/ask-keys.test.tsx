// @vitest-environment happy-dom
/* AC tests for issue #558 — answer the newest pending approval/plan card
   from the keyboard: ↵ allows once (approves a plan), ⌫ denies (rejects) —
   Esc is never Deny. Keys act only on the newest pending card in the
   visible thread and never while typing in the composer. */
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { askHint, askKeyDown, pendingAsk } from "../src/conversation/ask-keys";
import type { Reply } from "../src/types";

afterEach(cleanup);

const approvalReply = (
  id: string,
  options = ["once", "session", "deny"],
): Reply => ({
  id: `r-${id}`,
  from: "builder",
  time: "",
  text: "I need approval.",
  approval: { id, command: "rm -rf tmp", note: "Cleanup", options },
});

const planReply = (
  id: string,
  status: "proposed" | "approved" | "replaced" | "rejected",
): Reply => ({
  id: `r-${id}`,
  from: "builder",
  time: "",
  text: "",
  plan: {
    id,
    version: 1,
    status,
    steps: [{ text: "Do it", status: "pending" }],
  },
});

const ev = (
  key: string,
  target: HTMLElement | null = document.body,
  mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
): KeyboardEvent => {
  const e = new window.KeyboardEvent("keydown", {
    key,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(e, "target", { value: target });
  return e;
};

describe("issue #558 pending ask selection", () => {
  test("AC-558-1 the newest unresolved approval card is the pending one", () => {
    const replies = [
      approvalReply("a1"),
      { id: "u1", from: "user", time: "", text: "ok" },
      approvalReply("a2"),
    ];
    const ask = pendingAsk(replies, {}, false);
    expect(ask?.kind).toBe("approval");
    expect(ask?.reply.approval?.id).toBe("a2");
  });

  test("AC-558-2 a resolved card is skipped — the next open one owns the keys", () => {
    const replies = [approvalReply("a1"), approvalReply("a2")];
    const ask = pendingAsk(replies, { a2: "Denied by you" }, false);
    expect(ask?.reply.approval?.id).toBe("a1");
  });

  test("AC-558-3 a proposed plan is pending only with a plan handler", () => {
    const replies = [planReply("p1", "proposed")];
    expect(pendingAsk(replies, {}, true)?.kind).toBe("plan");
    expect(pendingAsk(replies, {}, false)).toBeNull();
    expect(pendingAsk(replies, {}, true)?.reply.plan?.id).toBe("p1");
  });

  test("AC-558-4 approved/rejected plans and questions are not pending", () => {
    expect(pendingAsk([planReply("p1", "approved")], {}, true)).toBeNull();
    expect(pendingAsk([planReply("p1", "rejected")], {}, true)).toBeNull();
  });
});

describe("issue #558 key routing", () => {
  const ctx = (over: Partial<Parameters<typeof askKeyDown>[1]> = {}) => ({
    viewer: "Riley",
    resolved: {},
    running: false,
    ...over,
  });

  test("AC-558-5 ↵ allows once on the pending approval — same resolved label the Once button writes", () => {
    const r = approvalReply("a1");
    const setResolved = vi.fn();
    const handled = askKeyDown(
      ev("Enter"),
      ctx({ ask: { kind: "approval", reply: r }, setResolved }),
    );
    expect(handled).toBe(true);
    expect(setResolved).toHaveBeenCalledWith({
      a1: "Allowed once by Riley",
    });
  });

  test("AC-558-6 ⌫ denies — Esc never does", () => {
    const r = approvalReply("a1");
    const setResolved = vi.fn();
    expect(
      askKeyDown(
        ev("Backspace"),
        ctx({ ask: { kind: "approval", reply: r }, setResolved }),
      ),
    ).toBe(true);
    expect(setResolved).toHaveBeenCalledWith({ a1: "Denied by Riley" });
    setResolved.mockClear();
    // Esc is close-only (#576) — it must never answer a card.
    expect(
      askKeyDown(
        ev("Escape"),
        ctx({ ask: { kind: "approval", reply: r }, setResolved }),
      ),
    ).toBe(false);
    expect(setResolved).not.toHaveBeenCalled();
  });

  test("AC-558-7 ↵/⌫ approve and reject a waiting plan through onPlan", () => {
    const r = planReply("p1", "proposed");
    const onPlan = vi.fn();
    expect(
      askKeyDown(ev("Enter"), ctx({ ask: { kind: "plan", reply: r }, onPlan })),
    ).toBe(true);
    expect(onPlan).toHaveBeenCalledWith("approve", "p1");
    expect(
      askKeyDown(
        ev("Backspace"),
        ctx({ ask: { kind: "plan", reply: r }, onPlan }),
      ),
    ).toBe(true);
    expect(onPlan).toHaveBeenCalledWith("reject", "p1");
  });

  test("AC-558-8 keys stay inert while typing in the composer or on a control", () => {
    const r = approvalReply("a1");
    const setResolved = vi.fn();
    const onPlan = vi.fn();
    const ask = { kind: "approval" as const, reply: r };
    const ta = document.createElement("textarea");
    const btn = document.createElement("button");
    expect(askKeyDown(ev("Enter", ta), ctx({ ask, setResolved }))).toBe(false);
    expect(askKeyDown(ev("Backspace", ta), ctx({ ask, setResolved }))).toBe(
      false,
    );
    expect(askKeyDown(ev("Enter", btn), ctx({ ask, setResolved }))).toBe(false);
    // A modifier-held Enter is never a card answer.
    expect(
      askKeyDown(
        ev("Enter", document.body, { meta: true }),
        ctx({ ask, setResolved }),
      ),
    ).toBe(false);
    expect(setResolved).not.toHaveBeenCalled();
    expect(onPlan).not.toHaveBeenCalled();
  });

  test("AC-558-9 ⌘. stops through the surface layer — even while typing", () => {
    const onStop = vi.fn();
    const ta = document.createElement("textarea");
    expect(
      askKeyDown(ev(".", ta, { meta: true }), ctx({ running: true, onStop })),
    ).toBe(true);
    expect(onStop).toHaveBeenCalledTimes(1);
    // Nothing running → nothing to stop → not handled.
    expect(askKeyDown(ev(".", ta, { meta: true }), ctx({ onStop }))).toBe(
      false,
    );
  });
});

describe("issue #558 shortcut hint", () => {
  test("AC-558-10 the hint names only the keys the card offers", () => {
    expect(askHint(approvalReply("a1"), "approval")).toBe(
      "↵ Allow once · ⌫ Deny",
    );
    // "once" missing → no ↵; "deny" missing → no ⌫; neither → no hint.
    expect(askHint(approvalReply("a2", ["once", "session"]), "approval")).toBe(
      "↵ Allow once",
    );
    expect(askHint(approvalReply("a3", ["session", "deny"]), "approval")).toBe(
      "⌫ Deny",
    );
    expect(
      askHint(approvalReply("a4", ["session", "always"]), "approval"),
    ).toBeNull();
    expect(askHint(planReply("p1", "proposed"), "plan")).toBe(
      "↵ Approve · ⌫ Reject",
    );
  });
});
