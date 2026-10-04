import type { EngineEvent } from "@lilos/contracts/engine";
import { describe, expect, it } from "vitest";
import { reduceSessionEvents } from "../src/turn-model";

/* #431 — a finished turn's streams replay as ONE `turn.recap` at the last
   superseded delta's seq (D-#431). The fold treats it as replace: the model
   lands identically whether the replay window carried the delta run, the
   recap, or deltas up to the anchor plus the recap — exactly the coverage
   states a reconnecting feed can hold. */

let seq = 0;
const ev = (
  type: string,
  payload: Record<string, unknown>,
  sessionId = "sess-1",
): EngineEvent => ({ seq: ++seq, sessionId, type, payload }) as EngineEvent;

describe("#431 turn.recap — replace fold", () => {
  it("fresh replay: one recap carries the whole turn's text + reasoning", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1" }),
      ev("turn.recap", {
        turnId: "t1",
        text: "full answer",
        reasoning: "chain",
      }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    const t = model.turns[0];
    expect(t.text).toBe("full answer");
    expect(t.reasoning).toBe("chain");
    expect(t.phase).toBe("done");
  });

  it("partial overlap: held deltas plus the recap fold to the live text", () => {
    /* The feed watched deltas 1–2 live, lost the socket, and the replay
       came back compacted — the recap re-stamps the whole stream, so the
       fold lands exactly what a full live watch produced. */
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1" }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "Hel" }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "lo" }),
      ev("turn.recap", {
        turnId: "t1",
        text: "Hello world",
        reasoning: "",
      }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    expect(model.turns[0].text).toBe("Hello world");
  });

  it("a reasoning-only recap transitions phase like the delta it replaces", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1" }),
      ev("turn.recap", { turnId: "t1", text: "", reasoning: "chain" }),
    ]);
    expect(model.turns[0].phase).toBe("reasoning");
    expect(model.turns[0].reasoning).toBe("chain");
  });

  it("a replayed recap never reopens a settled turn", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1" }),
      ev("turn.recap", { turnId: "t1", text: "a", reasoning: "" }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
      /* A second overlapping replay (feed resync) can hand the same recap
         back — the fold must stay idempotent. */
      ev("turn.recap", { turnId: "t1", text: "a", reasoning: "" }),
    ]);
    expect(model.turns[0].phase).toBe("done");
    expect(model.turns[0].text).toBe("a");
  });
});
