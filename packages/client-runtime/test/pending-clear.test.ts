import { describe, expect, it } from "vitest";
import type { SessionModel, TurnModel, TurnPhase } from "../src/turn-model";
import { shouldClearPending } from "../src/turn-model";

/* #645: the "submitted" marker armed on send clears only once the turn is
   OBSERVED — live now, or folded to a terminal phase with events past the
   attach watermark (`liveAttached`). Replayed history and the
   send→`turn.started` gap must keep it armed (#606 pick-hold). */

const turn = (over: Partial<TurnModel>): TurnModel => ({
  turnId: "t1",
  phase: "done",
  reasoning: "",
  text: "",
  steps: [],
  steers: [],
  requests: [],
  plans: [],
  subagents: [],
  ...over,
});

const model = (over: Partial<SessionModel>): SessionModel => ({
  sessionId: "sess-1",
  state: "idle",
  turns: [],
  openRequests: [],
  jobs: [],
  ...over,
});

describe("shouldClearPending (#645)", () => {
  it("clears while a turn is live", () => {
    expect(shouldClearPending(model({ live: turn({ phase: "tools" }) }))).toBe(
      true,
    );
  });

  it.each<TurnPhase>(["done", "stopped", "failed"])(
    "clears on a %s turn the feed watched end (folded replay, liveAttached)",
    (phase) => {
      expect(
        shouldClearPending(
          model({ turns: [turn({ phase, liveAttached: true })] }),
        ),
      ).toBe(true);
    },
  );

  it("does NOT clear on replayed history — a terminal turn with no liveAttached", () => {
    expect(
      shouldClearPending(model({ turns: [turn({ phase: "done" })] })),
    ).toBe(false);
  });

  it("does NOT clear in the send→turn.started gap (no live, only stale history)", () => {
    expect(
      shouldClearPending(
        model({
          turns: [
            turn({ phase: "done" }),
            turn({ turnId: "t2", phase: "stopped" }),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("does NOT clear with no model or no turns", () => {
    expect(shouldClearPending(undefined)).toBe(false);
    expect(shouldClearPending(model({}))).toBe(false);
  });
});
