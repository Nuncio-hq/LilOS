import type { EngineEvent } from "@lilos/contracts/engine";
import { describe, expect, it } from "vitest";
import { reduceSessionEvents } from "../src/turn-model";

/* #327 — a turn can't outlive its session. Engines emit `session.state:
   idle` at every turn end, closed/error when the session is gone, and a
   new turn.started once the previous ended: a turn still open under any
   of those proofs lost its turn.completed to a truncated or degraded
   replay (#300) and must settle instead of staying live forever (mobile
   held "Thinking…" expanded with no chevron; web's typing cursor kept
   pulsing). The settle folds INTO the reduce — a replay produces the
   same answer, and no later frame can reopen it (every turn patch is
   guarded on a non-settled phase).
   Asymmetry with #309: the idle settle is turn-only — a background
   subagent legitimately runs through the idle gap between turns, so
   helper rows settle only under closed/error (or when the engine itself
   emits subagent.completed, as engine-hermes now does for dispatched ACP
   rows through Session.untrackedSubagents). */

let seq = 0;
const ev = (
  type: string,
  payload: Record<string, unknown>,
  sessionId = "sess-1",
): EngineEvent => ({ seq: ++seq, sessionId, type, payload }) as EngineEvent;

describe("#327 turn settle — the session stopped running", () => {
  it("AC-3 session.state idle settles a still-open turn done", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1" }),
      ev("turn.delta", { turnId: "t1", stream: "reasoning", delta: "hmm" }),
      ev("session.state", { state: "idle" }),
    ]);
    expect(model.turns[0].phase).toBe("done");
    expect(model.live).toBeUndefined();
  });

  it("AC-3 a replayed snapshot of an idle session settles a turn its log never completed", () => {
    /* The cold-start path: session.events returns the turn's head but no
       completion, and the snapshot proves the session is idle — the
       missing turn.completed isn't coming. */
    const model = reduceSessionEvents(
      "sess-1",
      [
        ev("turn.started", { turnId: "t1" }),
        ev("turn.delta", { turnId: "t1", stream: "reasoning", delta: "hmm" }),
        ev("turn.delta", { turnId: "t1", stream: "text", delta: "answ" }),
      ],
      { state: "idle" },
    );
    expect(model.turns[0].phase).toBe("done");
    expect(model.live).toBeUndefined();
    expect(model.turns[0].text).toBe("answ");
  });

  it("closed settles a turn stopped — requests cancel, running steps cancel, plan steps cancel", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1" }),
      ev("request.opened", {
        turnId: "t1",
        requestId: "r1",
        request: { kind: "approval", command: "rm -rf a" },
      }),
      ev("tool.started", {
        turnId: "t1",
        toolCallId: "c1",
        tool: "read_file",
        input: { path: "a.ts" },
      }),
      ev("plan.updated", {
        turnId: "t1",
        planId: "p1",
        kind: "tasks",
        version: 1,
        steps: [
          { text: "one", status: "completed" },
          { text: "two", status: "in_progress" },
        ],
      }),
      ev("session.state", { state: "closed" }),
    ]);
    const t = model.turns[0];
    expect(t.phase).toBe("stopped");
    expect(t.requests[0].outcome).toBe("cancel");
    expect(t.steps[0].status).toBe("cancelled");
    expect(t.plans[0].steps.map((s) => s.status)).toEqual([
      "completed",
      "cancelled",
    ]);
    expect(model.openRequests).toHaveLength(0);
  });

  it("a later turn.started settles an orphaned earlier turn with no state event at all", () => {
    /* Engines run one turn at a time — t2 existing proves t1 ended, even
       when its turn.completed was lost. */
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1" }),
      ev("turn.delta", { turnId: "t1", stream: "reasoning", delta: "lost" }),
      ev("turn.started", { turnId: "t2" }),
      ev("turn.delta", { turnId: "t2", stream: "text", delta: "now" }),
    ]);
    expect(model.turns[0].phase).toBe("done");
    expect(model.turns[1].phase).not.toBe("done");
    expect(model.live?.turnId).toBe("t2");
  });

  it("a snapshot naming another turn current settles the live turn", () => {
    const model = reduceSessionEvents(
      "sess-1",
      [
        ev("turn.started", { turnId: "t1" }),
        ev("turn.delta", { turnId: "t1", stream: "reasoning", delta: "hmm" }),
      ],
      { state: "running", turn: { turnId: "t2" } },
    );
    expect(model.turns[0].phase).toBe("done");
  });

  it("a settled turn can't reopen — stragglers land as data, never as life", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1" }),
      ev("session.state", { state: "idle" }),
      /* Frames replayed after the idle marker still fold (settle runs
         once at the end) — the text they carried is kept, the step cancels
         with the turn, and nothing brings the phase back to live. */
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "late" }),
      ev("tool.started", {
        turnId: "t1",
        toolCallId: "c9",
        tool: "read_file",
        input: { path: "a.ts" },
      }),
    ]);
    expect(model.turns[0].phase).toBe("done");
    expect(model.turns[0].text).toBe("late");
    expect(model.turns[0].steps[0].status).toBe("cancelled");
    expect(model.live).toBeUndefined();
  });

  it("a live tail past the snapshot watermark outranks it — the stale idle can't settle", () => {
    /* The feed freezes its snapshot at the replay watermark while
       engine.event frames keep appending to the same log. Folding a
       live stream against that stale "idle" settled every running turn
       (web e2e: no streaming, no approvals). The watermark makes the
       snapshot's freshness explicit: any event past it wins. */
    const stale = ev("session.state", { state: "idle" });
    const model = reduceSessionEvents(
      "sess-1",
      [
        stale,
        ev("turn.started", { turnId: "t2" }),
        ev("session.state", { state: "running" }),
        ev("turn.delta", { turnId: "t2", stream: "text", delta: "live" }),
      ],
      { state: "idle", atSeq: stale.seq },
    );
    expect(model.live?.turnId).toBe("t2");
    expect(model.turns.at(-1)?.phase).not.toBe("done");
  });

  it("a fresh snapshot (nothing past atSeq) still settles the unfinished turn", () => {
    const events = [
      ev("turn.started", { turnId: "t1" }),
      ev("turn.delta", { turnId: "t1", stream: "reasoning", delta: "hmm" }),
    ];
    const model = reduceSessionEvents("sess-1", events, {
      state: "idle",
      atSeq: events.at(-1)?.seq,
    });
    expect(model.turns.at(-1)?.phase).toBe("done");
    expect(model.live).toBeUndefined();
  });

  it("#370 a turn event past the attach watermark marks liveAttached; replayed history stays unmarked", () => {
    /* mergeTurns keeps a finished card through the settle→claim window
       only when the feed watched the turn live — #288's orphan arrives
       already-done in the replayed prefix and stays droppable. */
    const attach = ev("session.state", { state: "idle" });
    const model = reduceSessionEvents(
      "sess-1",
      [
        ev("turn.started", { turnId: "t-old" }),
        ev("turn.completed", { turnId: "t-old" }),
        ev("turn.started", { turnId: "t-new" }),
        ev("turn.completed", { turnId: "t-new" }),
      ],
      /* atSeq covers the marker plus t-old's two frames; t-new's pair
         lands past it — watched live. */
      { state: "idle", atSeq: attach.seq + 2 },
    );
    expect(model.turns[0].liveAttached).toBeUndefined();
    expect(model.turns[1].liveAttached).toBe(true);
  });

  it("idle does NOT settle a running helper row (#309) — closed does", () => {
    const frames = () => [
      ev("turn.started", { turnId: "t1" }),
      ev("subagent.started", {
        turnId: "t1",
        subagentId: "sa1",
        name: "task 1",
        task: "scan the relay",
      }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
      ev("session.state", { state: "idle" }),
    ];
    const idle = reduceSessionEvents("sess-1", frames());
    expect(idle.turns[0].subagents[0].status).toBe("running");
    const closed = reduceSessionEvents("sess-1", [
      ...frames(),
      ev("session.state", { state: "closed" }),
    ]);
    expect(closed.turns[0].subagents[0].status).toBe("stopped");
  });
});
