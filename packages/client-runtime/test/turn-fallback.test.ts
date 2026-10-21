import type { EngineEvent } from "@lilos/contracts/engine";
import { describe, expect, it } from "vitest";
import { reduceSessionEvents } from "../src/turn-model";

/* #790: the footer reads the turn's model. turn.completed carries the
   model that actually ran; the session pick the composer shows stays. */

let seq = 0;
const ev = (type: string, payload: Record<string, unknown>): EngineEvent =>
  ({ seq: ++seq, sessionId: "sess-1", type, payload }) as EngineEvent;

describe("#790 fallback model on the settled turn", () => {
  it("turn.completed.model replaces the turn's model and leaves the session pick", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("session.started", { agent: "builder", model: "fake-large" }),
      ev("turn.started", {
        turnId: "t1",
        model: "fake-large",
        provider: "fake",
      }),
      ev("turn.completed", {
        turnId: "t1",
        stopReason: "end_turn",
        model: "fake/opus-2",
        provider: "fake",
      }),
    ]);
    expect(model.turns[0]?.model).toBe("fake/opus-2");
    expect(model.turns[0]?.provider).toBe("fake");
    expect(model.model).toBe("fake-large");
  });
});
