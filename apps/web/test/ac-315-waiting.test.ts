/* Issue #315 — mergeTurns half of the waiting tray. Red-first pair with
   client-runtime's waitingMessages tests: the hiddenIds it returns must
   drop a mid-turn send from the reply list entirely (AC-1 — tray only),
   and a landed steer must render exactly ONCE — the turn's own steers
   row — with no bubble (AC-2). A queued send whose turn ran re-enters as
   a normal bubble (AC-3). */
import type { SessionModel, TurnModel } from "@lilos/client-runtime";
import { waitingMessages } from "@lilos/client-runtime";
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

const model = (turns: TurnModel[], live?: TurnModel): SessionModel => ({
  sessionId: "s1",
  state: "idle",
  turns,
  live,
  openRequests: [],
  jobs: [],
});

/* A user message renders as the reply row whose id IS the message id; a
   merged turn card keeps `live-<turnId>` (or the relay id of the employee
   row it claimed) and carries `steers`. */
const rowsFor = (
  messages: AppMessage[],
  deliveredSeq: number,
  m: SessionModel,
) => {
  const hidden = waitingMessages(messages, deliveredSeq, m).hiddenIds;
  return mergeTurns(
    conversationReplies(
      messages.filter((row) => !hidden.has(row.id)),
      "c1",
    ),
    m,
    "emp",
  );
};

describe("#315 waiting tray — mergeTurns", () => {
  test("AC-1 a mid-turn send renders no reply row — it lives in the tray only", () => {
    const prompt = msg({ id: "m1", seq: 1, text: "first" });
    const mid = msg({ id: "m2", seq: 2, text: "queued while it runs" });
    const live = turn({ phase: "tools", ref: "m1", text: "work" });
    const replies = rowsFor([prompt, mid], 1, model([live], live));
    expect(replies.find((r) => r.id === "m2")).toBeUndefined();
    expect(
      replies.find((r) => r.text === "queued while it runs"),
    ).toBeUndefined();
    /* The prompt and its running turn still render. */
    expect(replies.find((r) => r.id === "m1")).toBeTruthy();
    expect(replies.find((r) => r.text === "work")).toBeTruthy();
  });

  test("AC-2 a landed steer shows once inside the turn — never as a bubble", () => {
    const prompt = msg({ id: "m1", seq: 1, text: "first" });
    const steer = msg({ id: "m2", seq: 2, text: "veer left" });
    const landed = turn({
      phase: "done",
      ref: "m1",
      steers: ["veer left"],
      text: "done",
    });
    const replies = rowsFor([prompt, steer], 3, model([landed]));
    /* Exactly one steer row (on the turn it landed in); zero rows for the
       steer's own message id. */
    expect(replies.filter((r) => r.steers?.includes("veer left"))).toHaveLength(
      1,
    );
    expect(replies.find((r) => r.id === "m2")).toBeUndefined();
    expect(replies.find((r) => r.text === "veer left")).toBeUndefined();
  });

  test("AC-3 a queued send that ran as the next prompt bubbles normally below the answer", () => {
    const prompt = msg({ id: "m1", seq: 1, text: "first" });
    const next = msg({ id: "m2", seq: 2, text: "then this" });
    const first = turn({ phase: "done", ref: "m1", text: "answer one" });
    const second = turn({
      turnId: "t2",
      phase: "done",
      ref: "m2",
      text: "answer two",
    });
    const replies = rowsFor([prompt, next], 2, model([first, second]));
    /* The queued message leaves the tray and re-enters as its own row. */
    const idxMsg = replies.findIndex((r) => r.id === "m2");
    expect(idxMsg).toBeGreaterThanOrEqual(0);
    const idxAnswer1 = replies.findIndex((r) => r.text === "answer one");
    const idxAnswer2 = replies.findIndex((r) => r.text === "answer two");
    expect(idxMsg).toBeGreaterThan(idxAnswer1);
    expect(idxAnswer2).toBeGreaterThan(idxMsg);
  });
});
