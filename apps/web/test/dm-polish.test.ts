/* Issue #71, mapping layer (apps/web/src/lib/mapping.ts):
   AC-1 tool-event system rows ("⚙ …") never reach the thread — the tool cards
   inside the turn are the single rendering — and AC-4 an approval-blocked
   turn surfaces its own "waiting" phase (the engine's request.opened contract
   event) instead of folding into "tools"/"working". */
import type { TurnModel } from "@lilos/client-runtime";
import type { AppMessage } from "@lilos/contracts/app";
import { describe, expect, test } from "vitest";
import { conversationReplies, liveTurnReply } from "../src/lib/mapping";

const msg = (over: Partial<AppMessage>): AppMessage => ({
  id: "m1",
  channelId: "ch1",
  conversationId: "c1",
  authorId: "harness",
  authorKind: "system",
  text: "",
  seq: 1,
  createdAt: 0,
  ...over,
});

const turn = (over: Partial<TurnModel>): TurnModel => ({
  turnId: "t1",
  phase: "tools",
  reasoning: "",
  text: "",
  steps: [],
  steers: [],
  requests: [],
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
        steps: [
          { id: "s1", tool: "patch", input: {}, status: "running" },
        ],
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
});
