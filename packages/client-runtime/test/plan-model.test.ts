import type { EngineEvent } from "@lilos/contracts/engine";
import { describe, expect, it } from "vitest";
import { reduceSessionEvents, type TurnPlan } from "../src/index";

/**
 * Issue #180 — the turn model derives the UI's plan/task-list state from
 * `plan.updated` snapshots and the plan request lifecycle. Engines stream
 * full snapshots; superseded versions stay as `replaced`; unfinished items
 * read `cancelled` when the turn is stopped.
 */

const SID = "s1";

let seq = 0;
const ev = (type: string, payload: unknown): EngineEvent =>
  ({
    seq: ++seq,
    sessionId: SID,
    type,
    payload,
  }) as EngineEvent;

const tasksSnapshot = (version: number, statuses: string[]) => ({
  turnId: "t1",
  planId: "plan-t1",
  kind: "tasks",
  version,
  steps: statuses.map((status, i) => ({
    text: `step ${i + 1}`,
    status,
  })),
});

const proposal = (version: number) => ({
  turnId: "t1",
  planId: "plan-t1",
  kind: "plan",
  version,
  goal: "Reconnect the relay client on its own",
  steps: [
    { text: "Add backoff", files: ["src/backoff.ts"], status: "pending" },
    { text: "Wire the socket", status: "pending" },
  ],
  risks: ["Reconnect storms without jitter"],
});

const planRequest = (requestId: string, planId = "plan-t1") => ({
  turnId: "t1",
  requestId,
  request: { kind: "plan", planId },
});

const latest = (plans: TurnPlan[], planId = "plan-t1") =>
  plans.filter((p) => p.planId === planId).at(-1);

describe("plan.updated -> turn model (#180)", () => {
  it("AC-1 a tasks snapshot lands on its turn and later ticks update it", () => {
    const m = reduceSessionEvents(SID, [
      ev("turn.started", { turnId: "t1" }),
      ev(
        "plan.updated",
        tasksSnapshot(1, ["in_progress", "pending", "pending"]),
      ),
      ev(
        "plan.updated",
        tasksSnapshot(2, ["completed", "in_progress", "pending"]),
      ),
      ev(
        "plan.updated",
        tasksSnapshot(3, ["completed", "completed", "completed"]),
      ),
    ]);
    const plan = latest(m.turns[0].plans);
    /* Tasks tick in place — the card updates, no version history rows. */
    expect(m.turns[0].plans).toHaveLength(1);
    expect(plan?.kind).toBe("tasks");
    expect(plan?.version).toBe(3);
    expect(plan?.status).toBe("approved");
    expect(plan?.steps.map((s) => s.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
  });

  it("AC-1 replay: re-reducing the same log restores the plan (seq replay)", () => {
    const log = [
      ev("turn.started", { turnId: "t1" }),
      ev("plan.updated", tasksSnapshot(1, ["in_progress", "pending"])),
      ev("plan.updated", tasksSnapshot(2, ["completed", "in_progress"])),
    ];
    const first = reduceSessionEvents(SID, log);
    const replayed = reduceSessionEvents(SID, log);
    expect(replayed.turns[0].plans).toEqual(first.turns[0].plans);
  });

  it("AC-2 stop mid-list: unfinished steps read cancelled", () => {
    const m = reduceSessionEvents(SID, [
      ev("turn.started", { turnId: "t1" }),
      ev(
        "plan.updated",
        tasksSnapshot(1, ["completed", "in_progress", "pending"]),
      ),
      ev("turn.completed", { turnId: "t1", stopReason: "cancelled" }),
    ]);
    expect(latest(m.turns[0].plans)?.steps.map((s) => s.status)).toEqual([
      "completed",
      "cancelled",
      "cancelled",
    ]);
  });

  it("AC-2 a finished turn keeps its steps untouched", () => {
    const m = reduceSessionEvents(SID, [
      ev("turn.started", { turnId: "t1" }),
      ev("plan.updated", tasksSnapshot(1, ["completed", "completed"])),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    expect(
      latest(m.turns[0].plans)?.steps.every((s) => s.status === "completed"),
    ).toBe(true);
  });

  it("AC-3 a plan proposal opens a plan request: the turn waits on it", () => {
    const m = reduceSessionEvents(SID, [
      ev("turn.started", { turnId: "t1" }),
      ev("plan.updated", proposal(1)),
      ev("request.opened", planRequest("r1")),
    ]);
    const t = m.turns[0];
    expect(t.phase).toBe("waiting");
    expect(latest(t.plans)?.status).toBe("proposed");
    expect(latest(t.plans)?.goal).toContain("Reconnect");
    expect(latest(t.plans)?.risks).toEqual(["Reconnect storms without jitter"]);
    expect(m.openRequests.map((r) => r.requestId)).toEqual(["r1"]);
    expect(m.openRequests[0].request.kind).toBe("plan");
  });

  it("AC-4 approve: the plan runs (status approved, steps tick)", () => {
    const m = reduceSessionEvents(SID, [
      ev("turn.started", { turnId: "t1" }),
      ev("plan.updated", proposal(1)),
      ev("request.opened", planRequest("r1")),
      ev("request.resolved", { requestId: "r1", outcome: "approve" }),
      ev("plan.updated", {
        ...proposal(1),
        steps: [
          { text: "Add backoff", status: "completed" },
          { text: "Wire the socket", status: "in_progress" },
        ],
      }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    const plan = latest(m.turns[0].plans);
    expect(plan?.status).toBe("approved");
    expect(m.turns[0].phase).toBe("done");
    expect(m.openRequests).toEqual([]);
  });

  it("AC-4 reject: the plan reads rejected", () => {
    const m = reduceSessionEvents(SID, [
      ev("turn.started", { turnId: "t1" }),
      ev("plan.updated", proposal(1)),
      ev("request.opened", planRequest("r1")),
      ev("request.resolved", { requestId: "r1", outcome: "reject" }),
    ]);
    expect(latest(m.turns[0].plans)?.status).toBe("rejected");
  });

  it("AC-4 change: v1 reads replaced, the next version waits proposed", () => {
    const m = reduceSessionEvents(SID, [
      ev("turn.started", { turnId: "t1" }),
      ev("plan.updated", proposal(1)),
      ev("request.opened", planRequest("r1")),
      ev("request.resolved", {
        requestId: "r1",
        outcome: "change",
        answer: "skip the banner",
      }),
      ev("plan.updated", proposal(2)),
      ev("request.opened", planRequest("r2")),
    ]);
    const versions = m.turns[0].plans.filter((p) => p.planId === "plan-t1");
    expect(versions.map((p) => [p.version, p.status])).toEqual([
      [1, "replaced"],
      [2, "proposed"],
    ]);
    expect(m.openRequests.map((r) => r.requestId)).toEqual(["r2"]);
  });

  it("AC-4 change then approve v2: v1 stays replaced, v2 approved", () => {
    const m = reduceSessionEvents(SID, [
      ev("turn.started", { turnId: "t1" }),
      ev("plan.updated", proposal(1)),
      ev("request.opened", planRequest("r1")),
      ev("request.resolved", {
        requestId: "r1",
        outcome: "change",
        answer: "skip the banner",
      }),
      ev("plan.updated", proposal(2)),
      ev("request.opened", planRequest("r2")),
      ev("request.resolved", { requestId: "r2", outcome: "approve" }),
    ]);
    const versions = m.turns[0].plans.filter((p) => p.planId === "plan-t1");
    expect(versions.at(-1)?.status).toBe("approved");
    expect(versions[0].status).toBe("replaced");
  });
});
