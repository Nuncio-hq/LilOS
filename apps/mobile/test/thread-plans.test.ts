import { reduceSessionEvents } from "@lilos/client-runtime";
import type {
  AppMessage,
  Ask,
  Conversation,
  Employee,
} from "@lilos/contracts/app";
import type { EngineEvent } from "@lilos/contracts/engine";
import { describe, expect, it, vi } from "vitest";

vi.mock("expo-haptics", () => ({
  notificationAsync: vi.fn(() => Promise.resolve()),
  NotificationFeedbackType: { Success: "success", Warning: "warning" },
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

import { openPlanAsk, planChangeSend } from "../src/asks";
import { conversationState } from "../src/dm-model";
import { openAsks } from "../src/home-model";
import { mergeThreadEntries, toThreadDetail } from "../src/thread-model";

/* #182 — plans and task lists in the mobile thread. The web's #180 surface
   ported: a ticking Tasks card, a Plan card gated on a `plan` ask
   (Approve / Change… / Reject, change -> v2 with v1 folded "Replaced"), the
   waiting plan feeding Needs you, the Plan sheet collecting every version,
   and restore through the same session.events replay the reducer reads.
   Capability gate (D-#19): nothing renders without the engine's `plan`. */

const T0 = Date.parse("2026-09-29T12:00:00Z");

let seq = 0;
const ev = (
  type: string,
  payload: Record<string, unknown>,
  sessionId = "sess-1",
): EngineEvent => ({ seq: ++seq, sessionId, type, payload }) as EngineEvent;

const msg = (over: Partial<AppMessage> = {}): AppMessage => ({
  id: `m${seq}`,
  channelId: "ch-dm",
  authorId: "user",
  conversationId: "conv-1",
  authorKind: "user",
  text: "",
  seq: 1,
  createdAt: T0,
  rewound: false,
  dropped: false,
  removed: false,
  ...over,
});

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "conv-1",
  channelId: "ch-dm",
  rootMessageId: "m0",
  engineRef: "sess-1",
  state: "idle",
  title: "reconnect the client",
  titleSource: "auto",
  access: "ask",
  archived: false,
  deliveredSeq: 1,
  createdAt: T0 - 60_000,
  ...over,
});

const ada: Employee = {
  id: "emp-ada",
  name: "Ada",
  role: "eng",
  status: "busy",
  profile: "default",
  model: "fake-small",
  now: "",
  instructions: "",
  respondTo: "me",
  createdAt: 0,
};

const OPTS = {
  conversationId: "conv-1",
  deliveredSeq: 1,
  asks: [] as Ask[],
  employeeId: ada.id,
  employeeName: ada.name,
  sessionId: "sess-1",
  now: T0 + 60_000,
};

const planAsk = (over: Partial<Ask> = {}): Ask => ({
  id: "ask-1",
  channelId: "ch-dm",
  conversationId: "conv-1",
  turnId: "t1",
  requestId: "r1",
  request: { kind: "plan", planId: "plan-t1" },
  state: "open",
  createdAt: T0 + 1000,
  ...over,
});

const STEPS = [
  { text: "Add a backoff helper", files: ["src/backoff.ts"] },
  { text: "Wire it into the socket", files: ["src/socket.ts"] },
  { text: "Resume from the last seq", files: ["src/sync.ts"] },
];

const proposeEvents = (turnId = "t1") => [
  ev("turn.started", { turnId, model: "fake-small" }),
  ev("plan.updated", {
    turnId,
    planId: `plan-${turnId}`,
    kind: "plan",
    version: 1,
    goal: "Reconnect the relay client on its own after a drop",
    steps: STEPS.map((s) => ({ ...s, status: "pending" })),
    risks: ["Reconnect storms if many clients drop at once"],
  }),
  ev("request.opened", {
    turnId,
    requestId: "r1",
    request: { kind: "plan", planId: `plan-${turnId}` },
  }),
];

const agentCard = (entries: ReturnType<typeof mergeThreadEntries>) => {
  /* The LAST agent entry is the turn's own card — earlier ones are the
     folded superseded plan cards that precede it. */
  const card = entries.findLast((e) => e.kind === "agent");
  if (card?.kind !== "agent") throw new Error("expected agent entry");
  return card;
};

describe("thread plans — #182 ACs", () => {
  it("AC-1 a tasks list ticks live on the card and folds when the list ends", () => {
    const events = [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("plan.updated", {
        turnId: "t1",
        planId: "plan-t1",
        kind: "tasks",
        version: 1,
        steps: [
          { text: "Read the client", status: "in_progress" },
          { text: "Wire the backoff", status: "pending" },
        ],
      }),
    ];
    const card = agentCard(
      mergeThreadEntries([], reduceSessionEvents("sess-1", events), OPTS),
    );
    expect(card.plan).toMatchObject({
      kind: "tasks",
      status: "approved",
      steps: [
        { text: "Read the client", status: "in_progress" },
        { text: "Wire the backoff", status: "pending" },
      ],
    });

    /* A later tick reaches the same row — one card, statuses updated. */
    events.push(
      ev("plan.updated", {
        turnId: "t1",
        planId: "plan-t1",
        kind: "tasks",
        version: 2,
        steps: [
          { text: "Read the client", status: "completed" },
          { text: "Wire the backoff", status: "in_progress" },
        ],
      }),
      ev("plan.updated", {
        turnId: "t1",
        planId: "plan-t1",
        kind: "tasks",
        version: 3,
        steps: [
          { text: "Read the client", status: "completed" },
          { text: "Wire the backoff", status: "completed" },
        ],
      }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    );
    const done = agentCard(
      mergeThreadEntries([], reduceSessionEvents("sess-1", events), OPTS),
    );
    expect(done.plan?.steps.map((s) => s.status)).toEqual([
      "completed",
      "completed",
    ]);
  });

  it("AC-1 a stopped task list leaves the remaining steps cancelled", () => {
    /* The card reads "Stopped · n/m" from cancelled steps alone (#180's
       turn-model rule): pending/in_progress -> cancelled on interrupt. */
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("plan.updated", {
        turnId: "t1",
        planId: "plan-t1",
        kind: "tasks",
        version: 2,
        steps: [
          { text: "Read the client", status: "completed" },
          { text: "Wire the backoff", status: "in_progress" },
          { text: "Run the checks", status: "pending" },
        ],
      }),
      ev("turn.completed", { turnId: "t1", stopReason: "cancelled" }),
    ]);
    const card = agentCard(mergeThreadEntries([], model, OPTS));
    expect(card.stopped).toBe(true);
    expect(card.plan?.steps.map((s) => s.status)).toEqual([
      "completed",
      "cancelled",
      "cancelled",
    ]);
  });

  it("AC-2 a proposed plan waits on its ask — and shows no approval card", () => {
    /* The Plan card IS the ask's surface: `turnApproval` must skip
       kind:"plan" asks or the turn renders a duplicate Approve/Deny card. */
    const model = reduceSessionEvents("sess-1", proposeEvents());
    const entries = mergeThreadEntries([], model, {
      ...OPTS,
      asks: [planAsk()],
    });
    const card = agentCard(entries);
    expect(card.plan).toMatchObject({
      kind: "plan",
      version: 1,
      status: "proposed",
      goal: "Reconnect the relay client on its own after a drop",
    });
    expect(card.approval).toBeUndefined();
    expect(card.decided).toBeUndefined();
  });

  it("AC-2 Change folds v1 into its own card and v2 waits in place", () => {
    const model = reduceSessionEvents("sess-1", [
      ...proposeEvents(),
      ev("request.resolved", {
        requestId: "r1",
        outcome: "change",
        answer: "keep the jitter",
      }),
      ev("plan.updated", {
        turnId: "t1",
        planId: "plan-t1",
        kind: "plan",
        version: 2,
        goal: "Reconnect the relay client on its own after a drop",
        steps: [
          ...STEPS,
          { text: "Your change: keep the jitter", files: [] },
        ].map((s) => ({ ...s, status: "pending" })),
        risks: ["Reconnect storms if many clients drop at once"],
      }),
      ev("request.opened", {
        turnId: "t1",
        requestId: "r2",
        request: { kind: "plan", planId: "plan-t1" },
      }),
    ]);
    const asks = [
      planAsk({
        state: "resolved",
        outcome: "change",
        answer: "keep the jitter",
      }),
      planAsk({ id: "ask-2", requestId: "r2" }),
    ];
    const entries = mergeThreadEntries([], model, { ...OPTS, asks });
    /* v1 is its own folded card ahead of the turn (web supersededPlanReplies):
       "Replaced by v2" on the card, v2 waiting underneath. */
    const plans = entries.flatMap((e) =>
      e.kind === "agent" && e.plan ? [e.plan] : [],
    );
    expect(plans.map((p) => `${p.kind}:v${p.version}:${p.status}`)).toEqual([
      "plan:v1:replaced",
      "plan:v2:proposed",
    ]);
    const card = agentCard(entries);
    expect(card.plan?.version).toBe(2);
    expect(card.approval).toBeUndefined();
  });

  it("AC-2 Approve ticks the approved version's steps until done", () => {
    const tick = (i: number) =>
      ev("plan.updated", {
        turnId: "t1",
        planId: "plan-t1",
        kind: "plan",
        version: 1,
        goal: "Reconnect the relay client on its own after a drop",
        steps: STEPS.map((s, j) => ({
          ...s,
          status: j <= i ? "completed" : "pending",
        })),
        risks: ["Reconnect storms if many clients drop at once"],
      });
    const model = reduceSessionEvents("sess-1", [
      ...proposeEvents(),
      ev("request.resolved", { requestId: "r1", outcome: "approve" }),
      tick(0),
      tick(1),
      tick(2),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    const card = agentCard(
      mergeThreadEntries([], model, {
        ...OPTS,
        asks: [planAsk({ state: "resolved", outcome: "approve" })],
      }),
    );
    expect(card.plan).toMatchObject({ status: "approved", version: 1 });
    expect(card.plan?.steps.every((s) => s.status === "completed")).toBe(true);
    /* No decided receipt either — the plan card carries the outcome. */
    expect(card.decided).toBeUndefined();
  });

  it("AC-2 Reject marks the plan rejected and the turn ends empty of a card ask", () => {
    const model = reduceSessionEvents("sess-1", [
      ...proposeEvents(),
      ev("request.resolved", { requestId: "r1", outcome: "reject" }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    const card = agentCard(
      mergeThreadEntries([], model, {
        ...OPTS,
        asks: [planAsk({ state: "resolved", outcome: "reject" })],
      }),
    );
    expect(card.plan?.status).toBe("rejected");
    expect(card.approval).toBeUndefined();
    expect(card.decided).toBeUndefined();
  });

  it("AC-3 a waiting plan ask puts the conversation in Needs you; resolving clears it", () => {
    /* Same source as #262 approvals: one open ask (any kind) -> needs-you;
       a resolved plan ask no longer counts. */
    expect(
      conversationState(conv(), { openAsks: [planAsk()], pending: new Set() }),
    ).toBe("needs-you");
    expect(openAsks([planAsk()])).toHaveLength(1);
    const resolved = planAsk({ state: "resolved", outcome: "approve" });
    expect(
      conversationState(conv(), { openAsks: [resolved], pending: new Set() }),
    ).toBe("done");
    expect(openAsks([resolved])).toHaveLength(0);
  });

  it("AC-4 the Plan sheet collects every version oldest-first with files + risks", () => {
    const model = reduceSessionEvents("sess-1", [
      ...proposeEvents(),
      ev("request.resolved", {
        requestId: "r1",
        outcome: "change",
        answer: "keep the jitter",
      }),
      ev("plan.updated", {
        turnId: "t1",
        planId: "plan-t1",
        kind: "plan",
        version: 2,
        goal: "Reconnect the relay client on its own after a drop",
        steps: STEPS.map((s) => ({ ...s, status: "pending" })),
        risks: ["Reconnect storms if many clients drop at once"],
      }),
    ]);
    const detail = toThreadDetail({
      conversation: conv(),
      employee: ada,
      messages: [msg({ id: "m1", seq: 1, text: "plan: propose" })],
      model,
      asks: [],
      pending: new Set(),
      now: T0 + 60_000,
      planCapable: true,
    });
    const plans = detail.entries.flatMap((e) =>
      e.kind === "agent" && e.plan ? [e.plan] : [],
    );
    expect(plans.map((p) => p.version)).toEqual([1, 2]);
    expect(plans[0].status).toBe("replaced");
    expect(plans[1].risks?.[0]).toContain("Reconnect storms");
    expect(plans[1].steps[0].files).toEqual(["src/backoff.ts"]);
  });

  it("AC-5 replaying the feed rebuilds the same plan rows (background/foreground restore)", () => {
    /* The screen re-reduces the full `session.events` window on every
       reconnect — same events must produce the same entries, twice. */
    const events = [
      ...proposeEvents(),
      ev("request.resolved", { requestId: "r1", outcome: "approve" }),
      ev("plan.updated", {
        turnId: "t1",
        planId: "plan-t1",
        kind: "plan",
        version: 1,
        goal: "Reconnect the relay client on its own after a drop",
        steps: STEPS.map((s) => ({ ...s, status: "completed" })),
        risks: ["Reconnect storms if many clients drop at once"],
      }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ];
    const a = mergeThreadEntries(
      [],
      reduceSessionEvents(
        "sess-1",
        events.map((e) => ({ ...e })),
      ),
      OPTS,
    );
    const b = mergeThreadEntries(
      [],
      reduceSessionEvents("sess-1", events),
      OPTS,
    );
    expect(b).toEqual(a);
    expect(
      agentCard(b).plan?.steps.every((s) => s.status === "completed"),
    ).toBe(true);
  });

  it("AC-5 without the engine's plan capability nothing plan-shaped renders", () => {
    /* D-#19: an engine that never declared `plan` can't emit plan.updated —
       the gate keeps stale rows/asks from surfacing anyway. */
    const detail = toThreadDetail({
      conversation: conv(),
      employee: ada,
      messages: [msg({ id: "m1", seq: 1, text: "plan: propose" })],
      model: reduceSessionEvents("sess-1", proposeEvents()),
      asks: [planAsk()],
      pending: new Set(),
      now: T0 + 60_000,
      planCapable: false,
    });
    for (const e of detail.entries) {
      expect(e.kind === "agent" ? e.plan : undefined).toBeUndefined();
    }
  });
});

describe("plan asks — helpers the thread screen uses", () => {
  it("openPlanAsk finds the open plan ask for a conversation", () => {
    const asks = [
      planAsk({ id: "a1", conversationId: "conv-1" }),
      planAsk({ id: "a2", conversationId: "conv-2" }),
      planAsk({ id: "a3", conversationId: "conv-1", state: "resolved" }),
    ];
    expect(openPlanAsk(asks, "conv-1")?.id).toBe("a1");
    expect(openPlanAsk(asks, "conv-9")).toBeUndefined();
  });

  it("planChangeSend intercepts a prefixed draft only while a plan ask is open", () => {
    const hit = planChangeSend(
      "Change the plan: keep the jitter",
      [planAsk()],
      "conv-1",
    );
    expect(hit).toEqual({ askId: "ask-1", answer: "keep the jitter" });
    /* Bare prefix still means a (blank) change; no ask -> send normally. */
    expect(
      planChangeSend("Change the plan: keep the jitter", [], "conv-1"),
    ).toBeUndefined();
    expect(
      planChangeSend(
        "Change the plan: keep the jitter",
        [planAsk({ state: "resolved" })],
        "conv-1",
      ),
    ).toBeUndefined();
    /* A normal message never gets intercepted. */
    expect(
      planChangeSend("change the plan please", [planAsk()], "conv-1"),
    ).toBeUndefined();
  });
});
