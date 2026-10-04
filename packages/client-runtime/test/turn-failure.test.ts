import type { EngineEvent } from "@lilos/contracts/engine";
import { describe, expect, it } from "vitest";
import { reduceSessionEvents } from "../src/turn-model";

/* #419 — a turn that ends on `turn.completed.error` failed; folding the
   payload away leaves it reading `done` like any clean end (the DM card
   never shows its alert, the turn has no failure state, Retry never earns
   its keep). The fold carries the error through: `phase: "failed"` +
   `error` text, still a terminal phase (never `live`, never reopened by
   late frames), and a failed turn can still claim the relay row its
   partial text posted (the harness ships whatever streamed). */

let seq = 0;
const ev = (
  type: string,
  payload: Record<string, unknown>,
  sessionId = "sess-1",
): EngineEvent => ({ seq: ++seq, sessionId, type, payload }) as EngineEvent;

describe("#419 turn failure — turn.completed.error survives the fold", () => {
  it("AC-1 an errored turn completes failed, carrying the engine's error text", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1" }),
      ev("turn.delta", { turnId: "t1", stream: "reasoning", delta: "hmm" }),
      ev("turn.completed", {
        turnId: "t1",
        stopReason: "refusal",
        error: "provider returned 429 (rate limited)",
      }),
    ]);
    const t = model.turns[0];
    expect(t.phase).toBe("failed");
    expect(t.error).toBe("provider returned 429 (rate limited)");
    expect(t.stopReason).toBe("refusal");
    expect(model.live).toBeUndefined();
  });

  it("a clean turn.completed still reads done; cancelled still reads stopped", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1" }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
      ev("turn.started", { turnId: "t2" }),
      ev("turn.completed", { turnId: "t2", stopReason: "cancelled" }),
    ]);
    expect(model.turns[0].phase).toBe("done");
    expect(model.turns[0].error).toBeUndefined();
    expect(model.turns[1].phase).toBe("stopped");
    expect(model.turns[1].error).toBeUndefined();
  });

  it("a failed turn can't reopen — stragglers land as data, never as life", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1" }),
      ev("turn.completed", {
        turnId: "t1",
        stopReason: "refusal",
        error: "boom",
      }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "late" }),
      ev("tool.started", {
        turnId: "t1",
        toolCallId: "c9",
        tool: "read_file",
        input: { path: "a.ts" },
      }),
    ]);
    expect(model.turns[0].phase).toBe("failed");
    expect(model.turns[0].text).toBe("late");
    expect(model.live).toBeUndefined();
  });

  it("the settle sweep leaves a failed turn failed — idle can't wash it back to done", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1" }),
      ev("turn.completed", {
        turnId: "t1",
        stopReason: "refusal",
        error: "boom",
      }),
      ev("session.state", { state: "idle" }),
    ]);
    expect(model.turns[0].phase).toBe("failed");
    expect(model.turns[0].error).toBe("boom");
    expect(model.live).toBeUndefined();
  });
});
