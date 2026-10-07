import { RelayError } from "@lilos/client-runtime";
import type { Ask } from "@lilos/contracts/app";
import { atom } from "nanostores";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

/* #158: approve / deny from the phone. `decide` answers a pending ask through
   asks.respond (AC-1), the resolved ask lands back in the shared atoms so the
   thread folds to a receipt (AC-2), an already-answered ask is "done" not an
   error (AC-3), and the decide tap haptics like the prototype (AC-4). No
   approve-all exists (AC-5). expo-haptics / react-native are mocked — the
   pure behavior is what these tests pin. */

const haptics = vi.hoisted(() => ({ notify: vi.fn(() => Promise.resolve()) }));
vi.mock("expo-haptics", () => ({
  notificationAsync: haptics.notify,
  NotificationFeedbackType: { Success: "success", Warning: "warning" },
}));
const alertSpy = vi.hoisted(() => vi.fn());
vi.mock("react-native", () => ({ Alert: { alert: alertSpy } }));

import { reduceSessionEvents } from "@lilos/client-runtime";
import {
  answerQuestion,
  decide,
  negativeOutcome,
  outcomeAllowed,
  primaryOutcome,
} from "../src/asks";
import { $asks } from "../src/dm-store";
import { openAsks } from "../src/home-model";
import { mergeThreadEntries } from "../src/thread-model";

const T0 = Date.parse("2026-09-29T12:00:00Z");

const approvalAsk = (over: Partial<Ask> = {}): Ask => ({
  id: "ask-1",
  channelId: "ch-dm",
  conversationId: "conv-1",
  turnId: "t1",
  requestId: "r1",
  request: {
    kind: "approval",
    command: "bun run build",
    description: "build the app",
    options: ["once", "always", "deny"],
  },
  state: "open",
  createdAt: T0,
  ...over,
});

const planAsk = (over: Partial<Ask> = {}): Ask =>
  approvalAsk({
    request: { kind: "plan", planId: "plan-1" },
    ...over,
  });

const questionAsk = (over: Partial<Ask> = {}): Ask =>
  approvalAsk({
    request: { kind: "question", question: "which branch?" },
    ...over,
  });

const resolved = (ask: Ask, outcome: string): Ask =>
  ({ ...ask, state: "resolved", outcome }) as Ask;

type FakeClient = {
  asks: ReturnType<typeof atom<Ask[]>>;
  // vitest 4: ReturnType<typeof vi.fn> unions Constructable into the mock and
  // no longer satisfies DecideClient.request — bare Mock<> is a procedure mock.
  request: Mock;
};

const clientOf = (impl: FakeClient["request"]): FakeClient => ({
  asks: atom<Ask[]>([]),
  request: impl,
});

/** A respond impl that answers with the resolved ask; replies to asks.list. */
const respondOk =
  (resolvedAsk: Ask, list: Ask[] = [resolvedAsk]) =>
  async (method: string, _params: unknown) => {
    if (method === "asks.respond") return { ask: resolvedAsk };
    if (method === "asks.list") return { asks: list };
    throw new Error(`unexpected ${method}`);
  };

beforeEach(() => {
  $asks.set([]);
  haptics.notify.mockClear();
  alertSpy.mockClear();
});

describe("asks — #158 approve/deny from the phone", () => {
  it("AC-1 approve calls asks.respond once; the ask leaves every open list in one update", async () => {
    const ask = approvalAsk();
    const client = clientOf(vi.fn(respondOk(resolved(ask, "once"))));
    client.asks.set([ask]);
    $asks.set([ask]);

    await decide(client, "ask-1", "once");

    expect(client.request).toHaveBeenCalledWith("asks.respond", {
      askId: "ask-1",
      outcome: "once",
    });
    expect(openAsks(client.asks.get())).toEqual([]);
    expect(openAsks($asks.get())).toEqual([]);
  });

  it("AC-1 deny calls asks.respond with deny and the ask leaves the list", async () => {
    const ask = approvalAsk();
    const client = clientOf(vi.fn(respondOk(resolved(ask, "deny"))));
    client.asks.set([ask]);

    await decide(client, "ask-1", "deny");

    expect(client.request).toHaveBeenCalledWith("asks.respond", {
      askId: "ask-1",
      outcome: "deny",
    });
    expect(openAsks(client.asks.get())).toEqual([]);
  });

  it("AC-2 the resolved ask folds to a decided receipt the turn carries", async () => {
    const ask = approvalAsk();
    const client = clientOf(vi.fn(respondOk(resolved(ask, "once"))));
    $asks.set([ask]);

    await decide(client, "ask-1", "once");

    const model = reduceSessionEvents("sess-1", [
      {
        seq: 1,
        sessionId: "sess-1",
        type: "turn.started",
        payload: { turnId: "t1", model: "fake-small" },
      },
    ] as never[]);
    const entries = mergeThreadEntries([], model, {
      conversationId: "conv-1",
      deliveredSeq: 1,
      asks: $asks.get(),
      employeeId: "emp-ada",
      employeeName: "Ada",
      sessionId: "sess-1",
      now: T0 + 60_000,
    });
    const card = entries[0];
    if (card.kind !== "agent") throw new Error("expected agent entry");
    expect(card.decided).toEqual({
      approved: true,
      what: "bun run build",
      outcome: "once",
    });
    expect(card.approval).toBeUndefined();
  });

  it("AC-3 answering an already-answered ask is done, not an error", async () => {
    const ask = approvalAsk();
    const client = clientOf(
      vi.fn(async (method: string) => {
        if (method === "asks.respond")
          throw new RelayError("ask already resolved", "conflict");
        if (method === "asks.list") return { asks: [resolved(ask, "deny")] };
        throw new Error(`unexpected ${method}`);
      }),
    );
    client.asks.set([ask]);
    $asks.set([ask]);

    await decide(client, "ask-1", "once");

    expect(alertSpy).not.toHaveBeenCalled();
    expect(client.request).toHaveBeenCalledWith("asks.list", {});
    expect(openAsks(client.asks.get())).toEqual([]);
    expect(openAsks($asks.get())).toEqual([]);
  });

  it("AC-4 decide haptics: success on approve, warning on deny", async () => {
    const ask = approvalAsk();
    const client = clientOf(vi.fn(respondOk(resolved(ask, "once"))));
    client.asks.set([approvalAsk(), approvalAsk({ id: "ask-2" })]);

    await decide(client, "ask-1", "once");
    expect(haptics.notify).toHaveBeenLastCalledWith("success");

    await decide(client, "ask-2", "deny");
    expect(haptics.notify).toHaveBeenLastCalledWith("warning");
  });

  it("AC-5 deciding one ask leaves the other open — no approve-all", async () => {
    const a1 = approvalAsk();
    const a2 = approvalAsk({ id: "ask-2", requestId: "r2" });
    const client = clientOf(
      vi.fn(respondOk(resolved(a1, "once"), [a2, resolved(a1, "once")])),
    );
    client.asks.set([a1, a2]);

    await decide(client, "ask-1", "once");

    const respondCalls = client.request.mock.calls.filter(
      ([m]) => m === "asks.respond",
    );
    expect(respondCalls).toHaveLength(1);
    expect(openAsks(client.asks.get()).map((a) => a.id)).toEqual(["ask-2"]);
  });

  it("outcomeAllowed: an approval answers only its own options (+cancel); plan/question take their kinds", async () => {
    expect(outcomeAllowed(approvalAsk(), "once")).toBe(true);
    expect(outcomeAllowed(approvalAsk(), "deny")).toBe(true);
    // #601: the ask offered "always" but no "session" — the phone can
    // never ship a respond the engine did not offer.
    expect(outcomeAllowed(approvalAsk(), "always")).toBe(true);
    expect(outcomeAllowed(approvalAsk(), "session")).toBe(false);
    expect(outcomeAllowed(approvalAsk(), "approve")).toBe(false);
    expect(outcomeAllowed(approvalAsk(), "cancel")).toBe(true);
    expect(outcomeAllowed(planAsk(), "approve")).toBe(true);
    expect(outcomeAllowed(planAsk(), "reject")).toBe(true);
    expect(outcomeAllowed(planAsk(), "change")).toBe(true);
    expect(outcomeAllowed(planAsk(), "once")).toBe(false);
    expect(outcomeAllowed(questionAsk(), "cancel")).toBe(true);
    expect(outcomeAllowed(questionAsk(), "answer")).toBe(true);
    expect(outcomeAllowed(questionAsk(), "once")).toBe(false);
  });

  it("#601 the tapped option is the outcome sent — 'This session' answers with session", async () => {
    const ask = approvalAsk({
      request: {
        kind: "approval",
        command: "bun run build",
        description: "build the app",
        options: ["once", "session", "always", "deny"],
      },
    });
    const client = clientOf(vi.fn(respondOk(resolved(ask, "session"))));
    client.asks.set([ask]);
    $asks.set([ask]);

    await decide(client, "ask-1", "session");

    expect(client.request).toHaveBeenCalledWith("asks.respond", {
      askId: "ask-1",
      outcome: "session",
    });
    expect(openAsks(client.asks.get())).toEqual([]);
  });

  it("#601 an outcome the ask's options never offered refuses — no respond ships", async () => {
    const ask = approvalAsk({
      request: {
        kind: "approval",
        command: "bun run build",
        description: "build the app",
        options: ["once", "deny"],
      },
    });
    const client = clientOf(vi.fn(respondOk(resolved(ask, "session"))));
    client.asks.set([ask]);

    await decide(client, "ask-1", "session");

    expect(
      client.request.mock.calls.filter(([m]) => m === "asks.respond"),
    ).toHaveLength(0);
    expect(openAsks(client.asks.get())).toHaveLength(1);
  });

  it("#601 primaryOutcome: the one-tap grant is the ask's first non-deny option", () => {
    expect(primaryOutcome(approvalAsk())).toBe("once");
    expect(
      primaryOutcome(
        approvalAsk({
          request: {
            kind: "approval",
            command: "rm x",
            options: ["session", "always", "deny"],
          },
        }),
      ),
    ).toBe("session");
    expect(
      primaryOutcome(
        approvalAsk({
          request: { kind: "approval", command: "rm x", options: ["deny"] },
        }),
      ),
    ).toBe("deny");
    expect(primaryOutcome(planAsk())).toBe("approve");
    expect(primaryOutcome(questionAsk())).toBe("cancel");
  });

  it("#601 negativeOutcome: the 'no' tap sends the outcome its kind takes", () => {
    expect(negativeOutcome(approvalAsk())).toBe("deny");
    expect(negativeOutcome(planAsk())).toBe("reject");
    expect(negativeOutcome(questionAsk())).toBe("cancel");
  });

  it("a failed respond surfaces an alert, not a silent no-op", async () => {
    const ask = approvalAsk();
    const client = clientOf(
      vi.fn(async (method: string) => {
        if (method === "asks.respond")
          throw new RelayError("socket closed", "not_connected");
        throw new Error(`unexpected ${method}`);
      }),
    );
    client.asks.set([ask]);

    await decide(client, "ask-1", "once");

    expect(alertSpy).toHaveBeenCalledOnce();
    // Still open — nothing claimed to have answered it.
    expect(openAsks(client.asks.get())).toHaveLength(1);
  });
});

/* #553: a question ask answers from the phone — the option tap sends its
   wire id, the typed text sends itself, and the resolved ask folds to a
   "You answered:" receipt naming the option's label (AC-1 card, AC-2
   resolve + continue). */
describe("asks — #553 answer a question from the phone", () => {
  const qAsk = (over: Partial<Ask> = {}): Ask =>
    questionAsk({
      request: {
        kind: "question",
        question: "Where should #96 land?",
        options: [
          { id: "cherry-pick", label: "Cherry-pick to release/0.1" },
          { id: "next-train", label: "Keep it on main" },
        ],
        freeText: true,
      },
      ...over,
    });
  const answered = (ask: Ask, answer: string): Ask =>
    ({ ...ask, state: "resolved", outcome: "answer", answer }) as Ask;

  it("AC-1 an open question carries options + freeText onto the turn card", () => {
    const ask = qAsk();
    $asks.set([ask]);
    const model = reduceSessionEvents("sess-1", [
      {
        seq: 1,
        sessionId: "sess-1",
        type: "turn.started",
        payload: { turnId: "t1", model: "fake-small" },
      },
    ] as never[]);
    const entries = mergeThreadEntries([], model, {
      conversationId: "conv-1",
      deliveredSeq: 1,
      asks: $asks.get(),
      employeeId: "emp-ada",
      employeeName: "Ada",
      sessionId: "sess-1",
      now: T0 + 60_000,
    });
    const card = entries[0];
    if (card.kind !== "agent") throw new Error("expected agent entry");
    expect(card.approval).toMatchObject({
      kind: "question",
      options: [
        { id: "cherry-pick", label: "Cherry-pick to release/0.1" },
        { id: "next-train", label: "Keep it on main" },
      ],
      freeText: true,
    });
    expect(card.waiting).toBe("question");
  });

  it("AC-2 an option tap sends asks.respond 'answer' with the wire id", async () => {
    const ask = qAsk();
    const client = clientOf(vi.fn(respondOk(answered(ask, "cherry-pick"))));
    client.asks.set([ask]);
    $asks.set([ask]);

    await answerQuestion(client, "ask-1", "cherry-pick");

    expect(client.request).toHaveBeenCalledWith("asks.respond", {
      askId: "ask-1",
      outcome: "answer",
      answer: "cherry-pick",
    });
    expect(openAsks(client.asks.get())).toEqual([]);
    expect(openAsks($asks.get())).toEqual([]);
    expect(haptics.notify).toHaveBeenLastCalledWith("success");
  });

  it("AC-2 typed free text sends the text itself as the answer", async () => {
    const ask = qAsk();
    const client = clientOf(
      vi.fn(respondOk(answered(ask, "hold it until Friday"))),
    );
    client.asks.set([ask]);

    await answerQuestion(client, "ask-1", "hold it until Friday");

    expect(client.request).toHaveBeenCalledWith("asks.respond", {
      askId: "ask-1",
      outcome: "answer",
      answer: "hold it until Friday",
    });
  });

  it("AC-2 the answered ask folds to a 'You answered:' receipt naming the option's label", async () => {
    const ask = qAsk();
    const client = clientOf(vi.fn(respondOk(answered(ask, "cherry-pick"))));
    $asks.set([ask]);

    await answerQuestion(client, "ask-1", "cherry-pick");

    const model = reduceSessionEvents("sess-1", [
      {
        seq: 1,
        sessionId: "sess-1",
        type: "turn.started",
        payload: { turnId: "t1", model: "fake-small" },
      },
    ] as never[]);
    const entries = mergeThreadEntries([], model, {
      conversationId: "conv-1",
      deliveredSeq: 1,
      asks: $asks.get(),
      employeeId: "emp-ada",
      employeeName: "Ada",
      sessionId: "sess-1",
      now: T0 + 60_000,
    });
    const card = entries[0];
    if (card.kind !== "agent") throw new Error("expected agent entry");
    expect(card.decided).toEqual({
      approved: true,
      what: "Cherry-pick to release/0.1",
      question: true,
      outcome: "answer",
    });
    expect(card.approval).toBeUndefined();
  });

  it("AC-2 a typed answer's receipt names the text; a cancelled one reads 'You cancelled:'", () => {
    const typed = answered(qAsk(), "hold it until Friday");
    const cancelled = {
      ...qAsk(),
      state: "resolved",
      outcome: "cancel",
    } as Ask;
    for (const [ask, want] of [
      [typed, "hold it until Friday"],
      [cancelled, "Where should #96 land?"],
    ] as const) {
      $asks.set([ask]);
      const model = reduceSessionEvents("sess-1", [
        {
          seq: 1,
          sessionId: "sess-1",
          type: "turn.started",
          payload: { turnId: "t1", model: "fake-small" },
        },
      ] as never[]);
      const entries = mergeThreadEntries([], model, {
        conversationId: "conv-1",
        deliveredSeq: 1,
        asks: $asks.get(),
        employeeId: "emp-ada",
        employeeName: "Ada",
        sessionId: "sess-1",
        now: T0 + 60_000,
      });
      const card = entries[0];
      if (card.kind !== "agent") throw new Error("expected agent entry");
      expect(card.decided?.question).toBe(true);
      expect(card.decided?.what).toBe(want);
    }
  });

  it("a question answered on the Mac folds quietly — conflict is done, not an error", async () => {
    const ask = qAsk();
    const client = clientOf(
      vi.fn(async (method: string) => {
        if (method === "asks.respond")
          throw new RelayError("ask already resolved", "conflict");
        if (method === "asks.list")
          return { asks: [answered(ask, "next-train")] };
        throw new Error(`unexpected ${method}`);
      }),
    );
    client.asks.set([ask]);
    $asks.set([ask]);

    await answerQuestion(client, "ask-1", "cherry-pick");

    expect(alertSpy).not.toHaveBeenCalled();
    expect(client.request).toHaveBeenCalledWith("asks.list", {});
    expect(openAsks(client.asks.get())).toEqual([]);
    expect(openAsks($asks.get())).toEqual([]);
  });

  it("a failed respond surfaces an alert; the ask stays open", async () => {
    const ask = qAsk();
    const client = clientOf(
      vi.fn(async (method: string) => {
        if (method === "asks.respond")
          throw new RelayError("socket closed", "not_connected");
        throw new Error(`unexpected ${method}`);
      }),
    );
    client.asks.set([ask]);

    await answerQuestion(client, "ask-1", "cherry-pick");

    expect(alertSpy).toHaveBeenCalledOnce();
    expect(openAsks(client.asks.get())).toHaveLength(1);
  });
});
