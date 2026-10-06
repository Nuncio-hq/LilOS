/* Issue #585: system notes look like system notes — relay rows with
   authorKind "system" map to `system` replies (centred notes, never the user's
   bubbles), a note that only repeats its neighbour's state drops, and a
   denied approval keeps the turn + its card visible. */
import type { TurnModel } from "@lilos/client-runtime";
import type { AppMessage } from "@lilos/contracts/app";
import { describe, expect, test } from "vitest";
import { conversationReplies, mergeTurns } from "../src/lib/mapping";

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
  dropped: false,
  removed: false,
  claimed: false,
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

const session = (turns: TurnModel[], live?: TurnModel) => ({
  sessionId: "s1",
  state: "idle" as const,
  turns,
  live,
  openRequests: [],
  jobs: [],
});

describe("issue #585 system notes", () => {
  test("AC-1 a relay system row maps to a `system` reply with bare text and no author", () => {
    const replies = conversationReplies([msg({ text: "Stopped." })], "c1");
    expect(replies).toHaveLength(1);
    expect(replies[0].system).toBe(true);
    expect(replies[0].text).toBe("Stopped.");
    expect(replies[0].from).toBe("");
  });

  test("AC-1 a 'Stopped.' note drops next to the stopped turn it repeats", () => {
    const replies = conversationReplies(
      [
        msg({ id: "u1", authorKind: "user", authorId: "me", text: "go" }),
        msg({ id: "s1", seq: 2, text: "Stopped." }),
      ],
      "c1",
    );
    const stopped = turn({ turnId: "t1", phase: "stopped", ref: "u1" });
    const out = mergeTurns(replies, session([stopped]), "emp");
    expect(out.map((r) => r.id)).toEqual(["u1", "live-t1"]);
  });

  test("AC-1 an 'Error:' note drops next to the failed turn it repeats", () => {
    const replies = conversationReplies(
      [
        msg({ id: "u1", authorKind: "user", authorId: "me", text: "go" }),
        msg({ id: "s1", seq: 2, text: "Error: engine died" }),
      ],
      "c1",
    );
    const failed = turn({ turnId: "t1", phase: "failed", ref: "u1" });
    const out = mergeTurns(replies, session([failed]), "emp");
    expect(out.map((r) => r.id)).toEqual(["u1", "live-t1"]);
  });

  test("AC-1 a note saying something no neighbour shows always stays", () => {
    const replies = conversationReplies(
      [
        msg({ id: "u1", authorKind: "user", authorId: "me", text: "go" }),
        msg({ id: "s1", seq: 2, text: "Auto-approved: read only" }),
      ],
      "c1",
    );
    const out = mergeTurns(replies, session([]), "emp");
    expect(out.map((r) => r.id)).toEqual(["u1", "s1"]);
  });

  test("AC-2 a denied approval keeps the turn and its card; the silent-end note drops", () => {
    const replies = conversationReplies(
      [
        msg({ id: "u1", authorKind: "user", authorId: "me", text: "push it" }),
        msg({
          id: "s1",
          seq: 2,
          text: "(the engine ended the turn silently)",
        }),
      ],
      "c1",
    );
    const denied = turn({
      turnId: "t1",
      phase: "done",
      text: "",
      ref: "u1",
      requests: [
        {
          requestId: "r1",
          turnId: "t1",
          request: {
            kind: "approval" as const,
            command: "git push origin main",
            options: ["once", "session", "always", "deny"] as (
              | "once"
              | "session"
              | "always"
              | "deny"
            )[],
          },
          outcome: "deny" as const,
        },
      ],
    });
    const asks = [
      {
        id: "a1",
        channelId: "ch1",
        conversationId: "c1",
        turnId: "t1",
        requestId: "r1",
        state: "resolved" as const,
        outcome: "deny" as const,
        request: {
          kind: "approval" as const,
          command: "git push origin main",
          options: ["once", "session", "always", "deny"] as (
            | "once"
            | "session"
            | "always"
            | "deny"
          )[],
        },
        createdAt: 0,
      },
    ];
    const out = mergeTurns(replies, session([denied]), "emp", asks);
    // The turn survives with its resolved approval card; the bare note drops.
    expect(out.map((r) => r.id)).toEqual(["u1", "live-t1"]);
    expect(out[1].approval?.command).toBe("git push origin main");
  });
});
