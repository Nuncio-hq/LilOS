import type { EngineEvent } from "@lilos/contracts/engine";
import { describe, expect, it } from "vitest";
import { reduceSessionEvents, SessionReducer } from "../src/turn-model";

/* #430 — SessionReducer folds incrementally: a live feed only appends,
   so each apply replays just the new tail while clone-on-write keeps
   every untouched TurnModel's object identity. That identity is what the
   fold cache and the memoized turn rows key on — this file pins the
   contract: tail work only, identical answers, no mutation of already
   emitted models. */

let seq = 0;
const ev = (
  type: string,
  payload: Record<string, unknown>,
  sessionId = "sess-1",
): EngineEvent => ({ seq: ++seq, sessionId, type, payload }) as EngineEvent;

const t1Done = () => [
  ev("turn.started", { turnId: "t1" }),
  ev("tool.started", {
    turnId: "t1",
    toolCallId: "c1",
    tool: "read_file",
    input: { path: "a.ts" },
  }),
  ev("tool.completed", {
    turnId: "t1",
    toolCallId: "c1",
    status: "done",
    output: "o",
  }),
  ev("turn.delta", { turnId: "t1", stream: "text", delta: "answer one" }),
  ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
];

describe("#430 incremental reduce — only the tail replays", () => {
  it("keeps an untouched turn's identity (and nested refs) across a delta", () => {
    const base = [...t1Done(), ev("turn.started", { turnId: "t2" })];
    const r = new SessionReducer("sess-1");
    const m1 = r.apply(base);
    const m2 = r.apply([
      ...base,
      ev("turn.delta", { turnId: "t2", stream: "text", delta: "w" }),
    ]);
    /* The delta landed on t2 — t1 is the same OBJECT, nested lists too. */
    expect(m2.turns[0]).toBe(m1.turns[0]);
    expect(m2.turns[0].steps).toBe(m1.turns[0].steps);
    expect(m2.turns[0].plans).toBe(m1.turns[0].plans);
    expect(m2.turns[1]).not.toBe(m1.turns[1]);
    expect(m2.turns[1].text).toBe("w");
  });

  it("equals the one-shot reduce at every prefix split", () => {
    const events = [
      ev("session.started", { model: "m1", provider: "p" }),
      ev("session.state", { state: "running" }),
      ev("turn.started", { turnId: "t1" }),
      ev("turn.delta", { turnId: "t1", stream: "reasoning", delta: "hmm" }),
      ev("tool.started", {
        turnId: "t1",
        toolCallId: "c1",
        tool: "read_file",
        input: { path: "x" },
      }),
      ev("plan.updated", {
        turnId: "t1",
        planId: "p1",
        kind: "plan",
        version: 1,
        steps: [{ text: "s1", status: "pending" }],
      }),
      ev("request.opened", {
        turnId: "t1",
        requestId: "r1",
        request: { kind: "question", question: "q?" },
      }),
      ev("request.resolved", {
        requestId: "r1",
        outcome: "approve",
        answer: "yes",
      }),
      ev("subagent.started", {
        turnId: "t1",
        subagentId: "sa1",
        name: "n",
        task: "t",
      }),
      ev("tool.started", {
        turnId: "t1",
        toolCallId: "c2",
        tool: "x",
        input: {},
        parentToolCallId: "sa1",
      }),
      ev("job.started", { jobId: "j1", command: "dev", startedAt: 1 }),
      ev("job.output", { jobId: "j1", tail: "log" }),
      ev("subagent.completed", {
        subagentId: "sa1",
        status: "done",
        result: "ok",
        durationMs: 5,
      }),
      ev("tool.completed", {
        turnId: "t1",
        toolCallId: "c1",
        status: "done",
        output: "o",
      }),
      ev("turn.steered", { turnId: "t1", text: "more" }),
      ev("turn.completed", {
        turnId: "t1",
        stopReason: "end_turn",
        usage: { inputTokens: 1 },
      }),
      ev("job.exited", { jobId: "j1", status: "exited", exitCode: 0 }),
      ev("session.state", { state: "idle" }),
      ev("turn.started", { turnId: "t2" }),
      ev("turn.delta", { turnId: "t2", stream: "text", delta: "two" }),
    ];
    const inc = new SessionReducer("sess-1");
    for (let i = 0; i < events.length; i++) {
      const slice = events.slice(0, i + 1);
      /* slice() shares elements — a true prefix, so each apply is tail-only
         yet lands the identical model the full replay would. */
      expect(inc.apply(slice)).toEqual(reduceSessionEvents("sess-1", slice));
    }
  });

  it("a tail apply never mutates the previously emitted model", () => {
    const base = t1Done();
    const r = new SessionReducer("sess-1");
    const m1 = r.apply(base);
    const before = JSON.stringify(m1);
    r.apply([
      ...base,
      ev("turn.started", { turnId: "t2" }),
      /* Even the settle sweep (t2 minted → nothing settles) and the
         derived passes leave m1's objects alone. */
      ev("turn.delta", { turnId: "t2", stream: "reasoning", delta: "r" }),
      ev("request.opened", {
        turnId: "t2",
        requestId: "r9",
        request: { kind: "approval", command: "x" },
      }),
    ]);
    expect(JSON.stringify(m1)).toBe(before);
  });

  it("a settled turn the sweep closes is cloned, not mutated", () => {
    /* t1 open when t2 starts → the sweep settles t1 done — the emitted
       t1 must be a clone or it would silently rewrite the last model. */
    const base = [ev("turn.started", { turnId: "t1" })];
    const r = new SessionReducer("sess-1");
    const m1 = r.apply(base);
    const m2 = r.apply([...base, ev("turn.started", { turnId: "t2" })]);
    expect(m1.turns[0].phase).toBe("reasoning");
    expect(m2.turns[0]).not.toBe(m1.turns[0]);
    expect(m2.turns[0].phase).toBe("done");
  });

  it("a fresh snapshot resets to a full replay — new objects, snapshot's answer", () => {
    const events = [
      ev("turn.started", { turnId: "t1" }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "hi" }),
    ];
    const r = new SessionReducer("sess-1");
    const m1 = r.apply(events);
    const m2 = r.apply(events, { state: "idle" });
    expect(m2.turns[0]).not.toBe(m1.turns[0]);
    expect(m2.turns[0].phase).toBe("done");
    expect(m2.state).toBe("idle");
  });

  it("a replaced prefix replays the whole log (resync/dedup safety)", () => {
    const e1 = ev("turn.started", { turnId: "t1" });
    const e2 = ev("turn.delta", {
      turnId: "t1",
      stream: "text",
      delta: "a",
    });
    const r = new SessionReducer("sess-1");
    const m1 = r.apply([e1, e2]);
    /* Same seq/type but a NEW object — the merge swapped it out, so the
       tail-only fast path can't trust the list. */
    const replay = [{ ...e1 }, e2];
    const m2 = r.apply(replay);
    expect(m2.turns[0]).not.toBe(m1.turns[0]);
    expect(m2).toEqual(reduceSessionEvents("sess-1", replay));
  });

  it("a turn minted while state reads idle revives when active lands (#430)", () => {
    /* The emit-time settle is a projection: the harness can deliver a
       leg's turn.started a frame BEFORE session.state flips active — the
       first apply projects it settled under the stale idle, but the next
       apply must put it live again, exactly as the one-shot reduce of
       each prefix does. */
    const idle = [...t1Done(), ev("session.state", { state: "idle" })];
    const legStarted = [
      ...idle,
      ev("turn.started", { turnId: "leg", initiatedBy: "agent" }),
    ];
    const live = [
      ...legStarted,
      ev("session.state", { state: "active" }),
      ev("turn.delta", { turnId: "leg", stream: "text", delta: "x" }),
    ];
    const r = new SessionReducer("sess-1");
    const m1 = r.apply(legStarted);
    expect(m1.turns[1].phase).toBe("done");
    expect(m1.live).toBeUndefined();
    const m2 = r.apply(live);
    expect(m2.live?.turnId).toBe("leg");
    expect(m2.live?.agentInitiated).toBe(true);
    expect(m2.turns[1].phase).toBe("text");
    expect(m2).toEqual(reduceSessionEvents("sess-1", live));
  });

  it("ignores other sessions' tail events identically", () => {
    const base = t1Done();
    const r = new SessionReducer("sess-1");
    const m1 = r.apply(base);
    const m2 = r.apply([
      ...base,
      ev("turn.started", { turnId: "other" }, "sess-2"),
      ev("turn.delta", { turnId: "t2", stream: "text", delta: "x" }, "sess-2"),
    ]);
    expect(m2.turns).toHaveLength(1);
    expect(m2.turns[0]).toBe(m1.turns[0]);
  });
});
