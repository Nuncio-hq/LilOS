/* Issue #467 — post-reload, engine-post rows must not paint unanchored below
   newer user rows while the session feed is still replaying its first
   `events.since` (no attach watermark → mergeTurns can't anchor — the inverse
   of the #308 invariant once the model binds).

   These tests pin the "pending" contract: before attach, employee-authored
   rows are held and the partial model live frames alone would mint is
   skipped; user rows (and the transcript note) still render. */
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
  dropped: false,
  removed: false,
  claimed: false,
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

describe("issue #467 — pre-attach, engine posts are held, not unanchored", () => {
  test('AC-1 "pending" holds employee rows so a newer user row never sits above an earlier answer', () => {
    /* Relay order after the queue drain: [qA, qB, postA]. Rendered raw this
       puts qB above postA — the CI flake frame ([mA][mB][post1][postA]…). */
    const replies = conversationReplies(
      [
        u("qA", 1, "first queued zebra"),
        u("qB", 2, "second queued apple"),
        a("a1", 3, "Done on main"),
        a("aA", 4, "First queued zebra"),
      ],
      "c1",
    );
    const out = mergeTurns(replies, "pending", "emp");
    expect(out.map((r) => r.id)).toEqual(["qA", "qB"]);
  });

  test('AC-1 "pending" mints no turn cards — a partial live-frames model must not render either', () => {
    /* Live frames landing pre-replay mint a bare leg turn in the feed; held
       model means it cannot paint its card above the held rows. */
    const replies = conversationReplies(
      [u("qA", 1, "first queued zebra")],
      "c1",
    );
    const out = mergeTurns(replies, "pending", "emp");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("qA");
  });

  test("AC-1 a relay-only conversation still passes rows through unchanged", () => {
    /* `undefined` model = no engine session at all — nothing to wait for. */
    const replies = conversationReplies(
      [u("qA", 1, "first queued zebra"), a("aA", 2, "First queued zebra")],
      "c1",
    );
    const out = mergeTurns(replies, undefined, "emp");
    expect(out.map((r) => r.id)).toEqual(["qA", "aA"]);
  });

  test("AC-1 once the model binds the converged order renders exactly", () => {
    const replies = conversationReplies(
      [
        u("qA", 1, "first queued zebra"),
        u("qB", 2, "second queued apple"),
        a("aA", 3, "First queued zebra"),
        a("aB", 4, "Second queued apple"),
      ],
      "c1",
    );
    const tA = turn({ turnId: "t1", ref: "qA", text: "First queued zebra" });
    const tB = turn({ turnId: "t2", ref: "qB", text: "Second queued apple" });
    const out = mergeTurns(replies, session([tA, tB]), "emp");
    expect(out.map((r) => r.id)).toEqual(["qA", "aA", "qB", "aB"]);
  });
});
