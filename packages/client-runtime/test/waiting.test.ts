/* Issue #315 — the waiting tray's relay-truth rules. A user message sent
   while a turn runs must render ONLY in the tray (AC-1): never as a reply
   bubble. `waitingMessages` decides that from deliveredSeq + the turn
   model, so a reload shows the same tray (AC-6).

   removable splits the two waiting kinds (AC-4): the harness still holds a
   `seq > deliveredSeq` message — Remove/Edit cancel it — while an
   accepted-but-unlanded steer already reached the engine, so its row lists
   without the actions. */
import type { AppMessage } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import type { SessionModel, TurnModel } from "../src/turn-model";
import { waitingMessages } from "../src/waiting";

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
  subagentJobs: [],
});

describe("#315 waitingMessages", () => {
  it("AC-1 a mid-turn send (seq > deliveredSeq) waits and hides from replies", () => {
    const prompt = msg({ id: "m1", seq: 1, text: "work on it" });
    const mid = msg({ id: "m2", seq: 2, text: "also this" });
    const live = turn({ phase: "tools", ref: "m1" });
    const out = waitingMessages([prompt, mid], 1, model([live], live));
    expect(out.waiting.map((w) => w.message.id)).toEqual(["m2"]);
    expect(out.waiting[0].removable).toBe(true);
    expect(out.hiddenIds.has("m2")).toBe(true);
    expect(out.hiddenIds.has("m1")).toBe(false);
  });

  it("AC-1 holds on a steer-capable engine and with none — the tray is the same", () => {
    /* The helper knows nothing of `steer`: an accepted steer is waiting
       under the watermark, a queued next-prompt is waiting over it. */
    const prompt = msg({ id: "m1", seq: 1 });
    const mid = msg({ id: "m2", seq: 2 });
    const live = turn({ phase: "tools", ref: "m1" });
    expect(
      waitingMessages([prompt, mid], 1, model([live], live)).waiting,
    ).toHaveLength(1);
  });

  it("AC-2 a landed steer leaves the tray and is not a reply row", () => {
    /* turn.steered text pairs to the message in order — it renders once,
       inside the turn, so it is hidden from replies but NOT waiting. */
    const prompt = msg({ id: "m1", seq: 1 });
    const steer = msg({ id: "m2", seq: 2, text: "nudge left" });
    const landed = turn({ phase: "done", ref: "m1", steers: ["nudge left"] });
    const out = waitingMessages([prompt, steer], 3, model([landed]));
    expect(out.waiting).toEqual([]);
    expect(out.hiddenIds.has("m2")).toBe(true);
  });

  it("AC-2 repeated identical steers pair in order, not twice onto one row", () => {
    const prompt = msg({ id: "m1", seq: 1 });
    const a = msg({ id: "m2", seq: 2, text: "again" });
    const b = msg({ id: "m3", seq: 3, text: "again" });
    const landed = turn({
      phase: "done",
      ref: "m1",
      steers: ["again", "again"],
    });
    const out = waitingMessages([prompt, a, b], 5, model([landed]));
    expect(out.hiddenIds.has("m2")).toBe(true);
    expect(out.hiddenIds.has("m3")).toBe(true);
    expect(out.waiting).toEqual([]);
  });

  it("AC-3 a queued send that ran as the next prompt is a normal bubble, not waiting", () => {
    const prompt = msg({ id: "m1", seq: 1 });
    const next = msg({ id: "m2", seq: 2 });
    const first = turn({ phase: "done", ref: "m1" });
    const second = turn({ turnId: "t2", phase: "done", ref: "m2" });
    const out = waitingMessages([prompt, next], 2, model([first, second]));
    expect(out.waiting).toEqual([]);
    expect(out.hiddenIds.has("m2")).toBe(false);
  });

  it("AC-4 an accepted-but-unlanded steer waits without Remove/Edit", () => {
    /* The engine acked `steered` but no turn.steered has landed: the
       message sits under deliveredSeq yet the engine hasn't consumed it
       visibly. The row lists; the actions aren't offered. */
    const prompt = msg({ id: "m1", seq: 1 });
    const accepted = msg({ id: "m2", seq: 2, text: "hold on" });
    const live = turn({ phase: "tools", ref: "m1" });
    const out = waitingMessages([prompt, accepted], 2, model([live], live));
    expect(out.waiting.map((w) => w.message.id)).toEqual(["m2"]);
    expect(out.waiting[0].removable).toBe(false);
    expect(out.hiddenIds.has("m2")).toBe(true);
  });

  it("a dropped (not-sent) or removed row is hidden and never waits", () => {
    const prompt = msg({ id: "m1", seq: 1 });
    const parked = msg({ id: "m2", seq: 2, dropped: true });
    const gone = msg({ id: "m3", seq: 3, removed: true });
    const live = turn({ phase: "tools", ref: "m1" });
    const out = waitingMessages([prompt, parked, gone], 0, model([live], live));
    expect(out.waiting).toEqual([]);
    expect(out.hiddenIds.has("m2")).toBe(true);
    expect(out.hiddenIds.has("m3")).toBe(true);
  });

  it("a live engine leg (no ref) still anchors the waiting window", () => {
    /* An accepted steer into an agent-initiated leg queues under the
       watermark — it still lists in the tray, un-removable. */
    const accepted = msg({ id: "m2", seq: 2, text: "hold on" });
    const leg = turn({ phase: "tools", agentInitiated: true });
    const out = waitingMessages([accepted], 2, model([leg], leg));
    expect(out.waiting.map((w) => w.message.id)).toEqual(["m2"]);
    expect(out.waiting[0].removable).toBe(false);
  });

  it("idle and fully delivered: nothing waits", () => {
    const prompt = msg({ id: "m1", seq: 1 });
    const done = turn({ phase: "done", ref: "m1" });
    const out = waitingMessages([prompt], 1, model([done]));
    expect(out.waiting).toEqual([]);
    expect(out.hiddenIds.size).toBe(0);
  });
});
