import { RelayError } from "@lilos/client-runtime";
import type { Ask } from "@lilos/contracts/app";
import { atom } from "nanostores";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { askOutcome, decide } from "../src/asks";
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
  request: ReturnType<typeof vi.fn>;
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

    await decide(client, "ask-1", true);

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

    await decide(client, "ask-1", false);

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

    await decide(client, "ask-1", true);

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
      what: "build the app",
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

    await decide(client, "ask-1", true);

    expect(alertSpy).not.toHaveBeenCalled();
    expect(client.request).toHaveBeenCalledWith("asks.list", {});
    expect(openAsks(client.asks.get())).toEqual([]);
    expect(openAsks($asks.get())).toEqual([]);
  });

  it("AC-4 decide haptics: success on approve, warning on deny", async () => {
    const ask = approvalAsk();
    const client = clientOf(vi.fn(respondOk(resolved(ask, "once"))));
    client.asks.set([approvalAsk(), approvalAsk({ id: "ask-2" })]);

    await decide(client, "ask-1", true);
    expect(haptics.notify).toHaveBeenLastCalledWith("success");

    await decide(client, "ask-2", false);
    expect(haptics.notify).toHaveBeenLastCalledWith("warning");
  });

  it("AC-5 deciding one ask leaves the other open — no approve-all", async () => {
    const a1 = approvalAsk();
    const a2 = approvalAsk({ id: "ask-2", requestId: "r2" });
    const client = clientOf(
      vi.fn(respondOk(resolved(a1, "once"), [a2, resolved(a1, "once")])),
    );
    client.asks.set([a1, a2]);

    await decide(client, "ask-1", true);

    const respondCalls = client.request.mock.calls.filter(
      ([m]) => m === "asks.respond",
    );
    expect(respondCalls).toHaveLength(1);
    expect(openAsks(client.asks.get()).map((a) => a.id)).toEqual(["ask-2"]);
  });

  it("kind map: plan approve/reject, question cancel; question+approve sends nothing", async () => {
    expect(askOutcome(approvalAsk(), true)).toBe("once");
    expect(askOutcome(approvalAsk(), false)).toBe("deny");
    expect(askOutcome(planAsk(), true)).toBe("approve");
    expect(askOutcome(planAsk(), false)).toBe("reject");
    expect(askOutcome(questionAsk(), false)).toBe("cancel");
    // A question's approve needs free text — the UI hides that pill and
    // decide refuses rather than shipping a malformed respond.
    expect(askOutcome(questionAsk(), true)).toBeUndefined();

    const client = clientOf(
      vi.fn(respondOk(resolved(questionAsk(), "answer"))),
    );
    client.asks.set([questionAsk()]);
    await decide(client, "ask-1", true);
    expect(
      client.request.mock.calls.filter(([m]) => m === "asks.respond"),
    ).toHaveLength(0);
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

    await decide(client, "ask-1", true);

    expect(alertSpy).toHaveBeenCalledOnce();
    // Still open — nothing claimed to have answered it.
    expect(openAsks(client.asks.get())).toHaveLength(1);
  });
});
