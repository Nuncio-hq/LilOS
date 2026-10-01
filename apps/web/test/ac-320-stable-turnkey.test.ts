/* Issue #320 — a user-opened turn block must keep its React identity when the
   turn settles: mergeTurns swaps the card's `id` (live-<turnId> → relay row id)
   when the finished text posts to the relay, and web keys turn cards by
   `r.turnId ?? r.id`. This pins that turnId reaches the card row at every
   phase — a missing turnId remounts AgentTurn and silently drops the user's
   collapse choice at turn end. */
import type { TurnModel } from "@lilos/client-runtime";
import type { AppMessage } from "@lilos/contracts/app";
import { describe, expect, test } from "vitest";
import { conversationReplies, mergeTurns } from "../src/lib/mapping";

const msg = (over: Partial<AppMessage>): AppMessage => ({
  id: "m1",
  channelId: "ch1",
  conversationId: "c1",
  authorId: "me",
  authorKind: "user",
  text: "",
  seq: 1,
  createdAt: 0,
  rewound: false,
  ...over,
});

const turn = (over: Partial<TurnModel>): TurnModel => ({
  turnId: "t1",
  phase: "done",
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
  subagentJobs: [],
});

const u = (id: string, seq: number, text: string) => msg({ id, seq, text });
const a = (id: string, seq: number, text: string) =>
  msg({ id, seq, text, authorId: "emp", authorKind: "employee" });

describe("issue #320 — turn cards keep a stable key across the id swap", () => {
  test("the live card carries turnId before and after its answer posts", () => {
    const t1 = turn({
      turnId: "t1",
      ref: "q1",
      text: "working",
      phase: "text",
    });
    const replies = conversationReplies([u("q1", 1, "hi")], "c1");

    const running = mergeTurns(replies, session([t1], t1), "emp");
    const liveCard = running.find((r) => r.id === "live-t1");
    expect(liveCard?.turnId).toBe("t1");

    /* Turn ends; the engine posts the answer as a relay row. The card claims
       that row (its id swaps) but turnId must persist — the React key. */
    const done = mergeTurns(
      conversationReplies([u("q1", 1, "hi"), a("a1", 2, "the answer")], "c1"),
      session([turn({ turnId: "t1", ref: "q1", text: "the answer" })]),
      "emp",
    );
    const card = done.find((r) => r.id === "a1");
    expect(card?.turnId).toBe("t1");
    expect(card?.text).toBe("the answer");
  });
});
