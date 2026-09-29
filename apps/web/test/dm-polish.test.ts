/* Issue #71, mapping layer (apps/web/src/lib/mapping.ts):
   AC-1 tool-event system rows ("⚙ …") never reach the thread — the tool cards
   inside the turn are the single rendering — and AC-4 an approval-blocked
   turn surfaces its own "waiting" phase (the engine's request.opened contract
   event) instead of folding into "tools"/"working". */
import type { TurnModel } from "@lilos/client-runtime";
import type { AppMessage } from "@lilos/contracts/app";
import { describe, expect, test } from "vitest";
import {
  conversationReplies,
  liveTurnReply,
  mergeTurns,
} from "../src/lib/mapping";

const msg = (over: Partial<AppMessage>): AppMessage => ({
  id: "m1",
  channelId: "ch1",
  conversationId: "c1",
  authorId: "harness",
  authorKind: "system",
  text: "",
  seq: 1,
  createdAt: 0,
  rewound: false,
  ...over,
});

const turn = (over: Partial<TurnModel>): TurnModel => ({
  turnId: "t1",
  phase: "tools",
  reasoning: "",
  text: "",
  steps: [],
  steers: [],
  plans: [],
  requests: [],
  subagents: [],
  ...over,
});

const approvalReq = {
  requestId: "r1",
  turnId: "t1",
  request: {
    kind: "approval" as const,
    command: "patch README.md",
    options: ["once", "always", "deny"] as ("once" | "always" | "deny")[],
  },
};

describe("issue #71", () => {
  test("AC-1 tool-event system rows are dropped from the thread", () => {
    const replies = conversationReplies(
      [
        msg({ text: "⚙ search_files — README.md" }),
        msg({ id: "m2", seq: 2, text: "⚙ patch — README.md" }),
        // Other system rows (stops, engine errors) still render.
        msg({ id: "m3", seq: 3, text: "Stopped." }),
      ],
      "c1",
    );
    expect(replies.map((r) => r.text)).toEqual(["⚠ Stopped."]);
  });

  test("AC-4 an approval-blocked turn maps to phase waiting, flagged on the request", () => {
    const reply = liveTurnReply(
      turn({
        phase: "waiting",
        steps: [{ id: "s1", tool: "patch", input: {}, status: "running" }],
        requests: [{ ...approvalReq }],
      }),
      "emp1",
    );
    expect(reply.phase).toBe("waiting");
    expect(reply.waitingOn).toBe("approval");
    expect(reply.live).toBe(true);
  });

  test("AC-4 a resolved request is not waiting even if phase lingers", () => {
    const reply = liveTurnReply(
      turn({
        phase: "waiting",
        requests: [{ ...approvalReq, outcome: "once" }],
      }),
      "emp1",
    );
    expect(reply.waitingOn).toBeUndefined();
  });

  test("AC-7 replies carry the engine model id for the footer", () => {
    // Posted turn (relay message): AppMessage.model lands on the reply.
    const replies = conversationReplies(
      [
        msg({
          authorKind: "employee",
          authorId: "emp1",
          text: "done",
          model: "fake-large",
        }),
      ],
      "c1",
    );
    expect(replies[0].model).toBe("fake-large");
    // Live/merged turn: the turn.started model id.
    const reply = liveTurnReply(
      turn({ phase: "done", text: "done", model: "fake-large" }),
      "emp1",
    );
    expect(reply.model).toBe("fake-large");
  });
});

describe("mergeTurns ordering", () => {
  const session = (turns: TurnModel[], live?: TurnModel) => ({
    sessionId: "s1",
    state: "idle" as const,
    turns,
    live,
    openRequests: [],
    jobs: [],
  });
  test("a stopped turn stays after the message that prompted it, not below later answers", () => {
    const replies = conversationReplies(
      [
        msg({ id: "u1", authorKind: "user", authorId: "me", text: "first" }),
        msg({ id: "s1", seq: 2, text: "Stopped." }),
        msg({
          id: "u2",
          seq: 3,
          authorKind: "user",
          authorId: "me",
          text: "second",
        }),
        msg({
          id: "a2",
          seq: 4,
          authorKind: "employee",
          authorId: "emp",
          text: "Done on main",
        }),
      ],
      "c1",
    );
    const stopped = turn({ turnId: "t1", phase: "stopped", ref: "u1" });
    const answered = turn({
      turnId: "t2",
      phase: "done",
      text: "Done on main",
      ref: "u2",
    });
    const out = mergeTurns(replies, session([stopped, answered]), "emp");
    expect(out.map((r) => r.id)).toEqual(["u1", "live-t1", "s1", "u2", "a2"]);
  });
  test("the live turn still goes last", () => {
    const replies = conversationReplies(
      [msg({ id: "u1", authorKind: "user", authorId: "me", text: "go" })],
      "c1",
    );
    const live = turn({ turnId: "t1", phase: "text", text: "wor", ref: "u1" });
    const out = mergeTurns(replies, session([live], live), "emp");
    expect(out.map((r) => r.id)).toEqual(["u1", "live-t1"]);
  });
});

/* Issue #180: plan.updated snapshots land on the turn's reply as a ui Plan;
   superseded versions fold into synthetic "Replaced by vN" replies ahead of
   it; a <2-item tasks list never renders. */
describe("issue #180 plans", () => {
  const session = (turns: TurnModel[], live?: TurnModel) => ({
    sessionId: "s1",
    state: "idle" as const,
    turns,
    live,
    openRequests: [],
    jobs: [],
  });
  const steps = (n: number, status: "pending" | "completed" = "pending") =>
    Array.from({ length: n }, (_, i) => ({ text: `step ${i}`, status }));

  test("AC-1 a tasks snapshot maps onto the turn reply; <2 items never renders", () => {
    const tasks = {
      planId: "p1",
      kind: "tasks" as const,
      version: 1,
      steps: steps(3),
      status: "approved" as const,
    };
    const reply = liveTurnReply(turn({ plans: [tasks] }), "emp");
    expect(reply.plan?.kind).toBe("tasks");
    expect(reply.plan?.steps).toHaveLength(3);

    const small = liveTurnReply(
      turn({ plans: [{ ...tasks, steps: steps(1) }] }),
      "emp",
    );
    expect(small.plan).toBeUndefined();
  });

  test("AC-3 a proposed plan maps waiting + carries goal/steps/risks", () => {
    const plan = {
      planId: "p1",
      kind: "plan" as const,
      version: 1,
      goal: "Add reconnect backoff",
      steps: steps(3),
      risks: ["may drop in-flight sends"],
      status: "proposed" as const,
    };
    const reply = liveTurnReply(
      turn({
        phase: "waiting",
        plans: [plan],
        requests: [
          {
            requestId: "r1",
            turnId: "t1",
            request: { kind: "plan", planId: "p1" },
          },
        ],
      }),
      "emp",
    );
    expect(reply.waitingOn).toBe("plan");
    expect(reply.plan?.status).toBe("proposed");
    expect(reply.plan?.goal).toBe("Add reconnect backoff");
    expect(reply.plan?.risks).toEqual(["may drop in-flight sends"]);
  });

  test("AC-4 a superseded v1 folds into its own reply ahead of v2", () => {
    const t = turn({
      turnId: "t1",
      phase: "done",
      text: "Done",
      plans: [
        {
          planId: "p1",
          kind: "plan" as const,
          version: 1,
          steps: steps(2),
          status: "replaced" as const,
        },
        {
          planId: "p1",
          kind: "plan" as const,
          version: 2,
          steps: steps(2, "completed" as const),
          status: "approved" as const,
        },
      ],
    });
    const replies = conversationReplies(
      [
        msg({ id: "u1", authorKind: "user", authorId: "me", text: "plan it" }),
        msg({
          id: "a1",
          seq: 2,
          authorKind: "employee",
          authorId: "emp",
          text: "Done",
        }),
      ],
      "c1",
    );
    const out = mergeTurns(replies, session([t]), "emp");
    expect(out.map((r) => r.id)).toEqual(["u1", "t1-plan-1", "a1"]);
    expect(out[1].plan?.status).toBe("replaced");
    expect(out[1].plan?.version).toBe(1);
    expect(out[2].plan?.version).toBe(2);
    expect(out[2].plan?.status).toBe("approved");
  });
});
