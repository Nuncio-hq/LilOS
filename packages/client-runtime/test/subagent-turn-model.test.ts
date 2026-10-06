import type { EngineEvent } from "@lilos/contracts/engine";
import { describe, expect, it } from "vitest";
import { reduceSessionEvents } from "../src/turn-model";

/* #309 — a background `delegate_task` outlives its parent's turn by design:
   `tool.completed` on the delegate call is only the DISPATCH receipt
   ({status:"dispatched"}), the real `subagent.completed` lands later — after
   `turn.completed`. These tests pin the lifecycle the live Hermes capture
   showed:
     seq 8  tool.completed c1 output={"status":"dispatched","mode":"background"}
     seq 12 turn.completed t1
     seq 20 subagent.completed sa1 status=done            (18s later)
   The reducer used to force every still-running subagent to "stopped" at
   turn end; a genuinely-finished one still settles the moment the engine
   says so. */

let seq = 0;
const ev = (
  type: string,
  payload: Record<string, unknown>,
  sessionId = "sess-1",
): EngineEvent => ({ seq: ++seq, sessionId, type, payload }) as EngineEvent;

const delegateFrames = () => [
  ev("turn.started", { turnId: "t1", ref: "m1" }),
  ev("tool.started", {
    turnId: "t1",
    toolCallId: "c1",
    tool: "delegate_task",
    input: { tasks: [{ goal: "scan the relay" }] },
  }),
  ev("subagent.started", {
    turnId: "t1",
    subagentId: "sa1",
    name: "task 1",
    task: "scan the relay",
    parentToolCallId: "c1",
    startedAt: 1_700_000_000_000,
  }),
  ev("tool.completed", {
    turnId: "t1",
    toolCallId: "c1",
    tool: "delegate_task",
    status: "completed",
    output: '{"status":"dispatched","mode":"background","count":1}',
  }),
  ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
];

describe("background subagents past turn end — #309, #587", () => {
  it("AC-1 a dispatched subagent stays running past turn.completed until the engine settles it", () => {
    const model = reduceSessionEvents("sess-1", [
      ...delegateFrames(),
      ev("subagent.completed", {
        subagentId: "sa1",
        status: "done",
        result: "child report",
        durationMs: 18_200,
      }),
    ]);
    const sa = model.turns[0].subagents.find((s) => s.subagentId === "sa1");
    expect(sa?.status).toBe("done");
    expect(sa?.result).toBe("child report");
    expect(sa?.durationMs).toBe(18_200);
  });

  it("AC-1 between turn.completed and subagent.completed the row reads running, not stopped", () => {
    const model = reduceSessionEvents("sess-1", delegateFrames());
    const sa = model.turns[0].subagents.find((s) => s.subagentId === "sa1");
    expect(sa?.status).toBe("running");
    /* The parent turn itself is settled — only the helper row stays live. */
    expect(model.turns[0].phase).toBe("done");
    expect(model.live).toBeUndefined();
  });

  it("a subagent's own tool calls landing after turn.completed nest under it without reopening the turn", () => {
    /* An async child keeps working between the parent's turns. The engine
       stamps these tool.* frames with whatever turnId is current — here
       the settled t1 — and they must extend the helper's step list without
       flipping the settled turn back to "tools". */
    const model = reduceSessionEvents("sess-1", [
      ...delegateFrames(),
      ev("tool.started", {
        turnId: "t1",
        toolCallId: "c9",
        tool: "read_file",
        input: { path: "a.ts" },
        parentToolCallId: "sa1",
      }),
      ev("tool.completed", {
        turnId: "t1",
        toolCallId: "c9",
        tool: "read_file",
        status: "completed",
        output: "12 lines",
        parentToolCallId: "sa1",
      }),
    ]);
    const t = model.turns[0];
    expect(t.phase).toBe("done");
    expect(model.live).toBeUndefined();
    const sa = t.subagents.find((s) => s.subagentId === "sa1");
    expect(sa?.steps).toHaveLength(1);
    expect(sa?.steps[0]).toMatchObject({
      tool: "read_file",
      status: "completed",
    });
  });

  it("steps stamped on a LATER turn still land on the helper that spawned them", () => {
    /* Review probe: helper sa1 runs past t1; while t2 is open the engine
       stamps its tool.* frames with t2's id. The reducer must resolve the
       parent across turns like subagent.completed does — not drop them
       into orphanSteps where they never render. */
    const model = reduceSessionEvents("sess-1", [
      ...delegateFrames(),
      ev("turn.started", { turnId: "t2", ref: "m2" }),
      ev("tool.started", {
        turnId: "t2",
        toolCallId: "c9",
        tool: "read_file",
        input: { path: "a.ts" },
        parentToolCallId: "sa1",
      }),
      ev("tool.completed", {
        turnId: "t2",
        toolCallId: "c9",
        tool: "read_file",
        status: "completed",
        output: "12 lines",
        parentToolCallId: "sa1",
      }),
    ]);
    const sa = model.turns[0].subagents.find((s) => s.subagentId === "sa1");
    expect(sa?.steps).toHaveLength(1);
    expect(sa?.steps[0]).toMatchObject({
      tool: "read_file",
      status: "completed",
    });
    expect(model.turns[1].subagents).toHaveLength(0);
  });

  it("a request stamped on a settled turn records but never reopens it", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", ref: "m1" }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
      ev("request.opened", {
        turnId: "t1",
        requestId: "r1",
        request: { kind: "question", question: "which file?" },
      }),
    ]);
    expect(model.turns[0].phase).toBe("done");
    expect(model.openRequests.map((r) => r.requestId)).toEqual(["r1"]);
  });

  it("a cancelled turn still settles its running subagents as stopped", () => {
    /* User Stop kills the work tree: the engine emits no child completion
       for a cancelled turn, so the row settles here. */
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", ref: "m1" }),
      ev("tool.started", {
        turnId: "t1",
        toolCallId: "c1",
        tool: "delegate_task",
        input: {},
      }),
      ev("subagent.started", {
        turnId: "t1",
        subagentId: "sa1",
        name: "task 1",
        task: "scan",
        parentToolCallId: "c1",
      }),
      ev("turn.completed", { turnId: "t1", stopReason: "cancelled" }),
    ]);
    expect(model.turns[0].subagents[0].status).toBe("stopped");
  });

  it("AC-2 subagents list only under Subagents, never as job rows (#587)", () => {
    /* #309 merged helpers into the Background feed as `sa:<id>` job rows —
       the exact duplication #587 AC-2 flags: a helper lives on
       turn.subagents and nowhere else. */
    const model = reduceSessionEvents("sess-1", delegateFrames());
    expect(model.jobs).toHaveLength(0);
    expect(model.turns[0].subagents[0]).toMatchObject({
      subagentId: "sa1",
      task: "scan the relay",
      status: "running",
    });
    const done = reduceSessionEvents("sess-1", [
      ...delegateFrames(),
      ev("subagent.completed", {
        subagentId: "sa1",
        status: "done",
        result: "child report",
        durationMs: 18_200,
      }),
    ]);
    expect(done.jobs).toHaveLength(0);
    expect(done.turns[0].subagents[0].status).toBe("done");
  });
});
