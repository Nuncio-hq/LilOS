import { reduceSessionEvents } from "@lilos/client-runtime";
import type {
  AppMessage,
  Ask,
  Conversation,
  Employee,
} from "@lilos/contracts/app";
import type { EngineEvent } from "@lilos/contracts/engine";
import { describe, expect, it } from "vitest";
import {
  dropRewound,
  mergeThreadEntries,
  toThreadDetail,
} from "../src/thread-model";

/* #157: the mobile live thread's pure projection — relay messages + engine
   events -> ui-native ThreadEntry[]. The reducer is the same one the Mac
   uses; these pin the phone-side rules (queued steer, stopped turn, footer,
   ask rendering, rewound hiding, plan/subagent neutral rows). */

const T0 = Date.parse("2026-09-29T12:00:00Z");

let seq = 0;
const ev = (
  type: string,
  payload: Record<string, unknown>,
  sessionId = "sess-1",
): EngineEvent => ({ seq: ++seq, sessionId, type, payload }) as EngineEvent;

const msg = (over: Partial<AppMessage> = {}): AppMessage => ({
  id: `m${seq}`,
  channelId: "ch-dm",
  authorId: "user",
  conversationId: "conv-1",
  authorKind: "user",
  text: "",
  seq: 1,
  createdAt: T0,
  rewound: false,
  ...over,
});

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "conv-1",
  channelId: "ch-dm",
  rootMessageId: "m0",
  engineRef: "sess-1",
  state: "idle",
  title: "ship it",
  titleSource: "auto",
  archived: false,
  deliveredSeq: 1,
  createdAt: T0 - 60_000,
  ...over,
});

const ada: Employee = {
  id: "emp-ada",
  name: "Ada",
  role: "eng",
  status: "busy",
  profile: "default",
  model: "fake-small",
  now: "",
  instructions: "",
  respondTo: "me",
  createdAt: 0,
};

const OPTS = {
  conversationId: "conv-1",
  deliveredSeq: 1,
  asks: [] as Ask[],
  employeeId: ada.id,
  employeeName: ada.name,
  sessionId: "sess-1",
  now: T0 + 60_000,
};

describe("thread-model — #157 AC mapping", () => {
  it("AC-1 messages map in order; a finished turn swaps into its reply slot", () => {
    const user = msg({ id: "m1", seq: 1, text: "fix the bug" });
    const reply = msg({
      id: "m2",
      seq: 2,
      authorKind: "employee",
      authorId: ada.id,
      text: "done, pushed",
      createdAt: T0 + 5000,
    });
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small", ref: "m1" }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "done, pushed" }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    const entries = mergeThreadEntries([user, reply], model, OPTS);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "user", text: "fix the bug" });
    const card = entries[1];
    expect(card).toMatchObject({
      kind: "agent",
      id: "turn-t1",
      text: "done, pushed",
      live: false,
    });
    // Swapped in place: id follows the turn, not the message id — and the
    // footer carries the prompt→reply duration the wire gave us.
    if (card.kind !== "agent") throw new Error("expected agent entry");
    expect(card.footer).toMatchObject({ dur: 5, model: "fake-small" });
  });

  it("AC-md reply markdown reaches the agent entry verbatim (Prose renders it)", () => {
    /* The placeholder screen printed raw `**`/backticks; the real screen
       renders `text` through Prose — so the mapping must pass markdown
       through untouched, not strip or escape it. */
    const md =
      "Short answer:\n\n- `seq` is monotonic\n- **bold** claim\n\nTail.";
    const user = msg({ id: "m1", seq: 1, text: "go" });
    const reply = msg({
      id: "m2",
      seq: 2,
      authorKind: "employee",
      authorId: ada.id,
      text: md,
    });
    const model = reduceSessionEvents("sess-1", []);
    const entries = mergeThreadEntries([user, reply], model, OPTS);
    const card = entries[1];
    if (card.kind !== "agent") throw new Error("expected agent entry");
    expect(card.text).toBe(md);
  });

  it("AC-2 a live turn shows reasoning, a running step, then streaming text", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("turn.delta", {
        turnId: "t1",
        stream: "reasoning",
        delta: "look at the file",
      }),
      ev("tool.started", {
        turnId: "t1",
        toolCallId: "c1",
        tool: "read_file",
        input: { path: "src/index.ts" },
      }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "half of" }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: " the answer" }),
    ]);
    const entries = mergeThreadEntries([], model, OPTS);
    expect(entries).toHaveLength(1);
    const card = entries[0];
    if (card.kind !== "agent") throw new Error("expected agent entry");
    expect(card.live).toBe(true);
    expect(card.reasoning).toBe("look at the file");
    expect(card.steps).toMatchObject([
      { tool: "read_file", arg: "src/index.ts", running: true },
    ]);
    expect(card.text).toBe("half of the answer");
    expect(card.writing).toBe(true);
  });

  it("AC-2 finished turn footer carries model/effort/files; stopped has none", () => {
    const user = msg({ id: "m1", seq: 1, text: "go" });
    const reply = msg({
      id: "m2",
      seq: 2,
      authorKind: "employee",
      authorId: ada.id,
      text: "shipped",
      createdAt: T0 + 30_000,
    });
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", {
        turnId: "t1",
        model: "fake-small",
        effort: "high",
        ref: "m1",
      }),
      ev("tool.started", {
        turnId: "t1",
        toolCallId: "c1",
        tool: "patch",
        input: { path: "a.ts" },
      }),
      ev("tool.completed", {
        turnId: "t1",
        toolCallId: "c1",
        tool: "patch",
        status: "completed",
        diff: { path: "a.ts", status: "modified", add: 3, del: 1 },
      }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "shipped" }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    const entries = mergeThreadEntries([user, reply], model, OPTS);
    const card = entries[1];
    if (card.kind !== "agent") throw new Error("expected agent entry");
    expect(card.footer).toMatchObject({
      dur: 30,
      model: "fake-small",
      effort: "high",
      files: 1,
    });
  });

  it("AC-3 a user message past deliveredSeq renders queued", () => {
    const queued = msg({ id: "m2", seq: 3, text: "also this" });
    const entries = mergeThreadEntries(
      [msg({ id: "m1", seq: 1, text: "first" }), queued],
      undefined,
      { ...OPTS, deliveredSeq: 1 },
    );
    expect((entries[0] as { queued?: boolean }).queued).toBeUndefined();
    expect(entries[1]).toMatchObject({ kind: "user", queued: true });
    // Once deliveredSeq covers it, the flag clears.
    const delivered = mergeThreadEntries(
      [msg({ id: "m1", seq: 1, text: "first" }), queued],
      undefined,
      { ...OPTS, deliveredSeq: 3 },
    );
    expect(delivered[1]).toMatchObject({ kind: "user" });
    expect((delivered[1] as { queued?: boolean }).queued).toBeUndefined();
  });

  it("AC-4 a stopped turn ends the card stopped, not live", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "working—" }),
      ev("turn.completed", { turnId: "t1", stopReason: "cancelled" }),
    ]);
    const entries = mergeThreadEntries([], model, OPTS);
    const card = entries[0];
    if (card.kind !== "agent") throw new Error("expected agent entry");
    expect(card.stopped).toBe(true);
    expect(card.live).toBe(false);
    expect(card.text).toBe("working—");
  });

  it("an open ask hangs off its turn (read-only card for #158)", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("request.opened", {
        turnId: "t1",
        requestId: "r1",
        request: {
          kind: "approval",
          command: "rm -rf build/",
          description: "clean the build folder",
          options: ["once", "always", "deny"],
        },
      }),
    ]);
    const ask: Ask = {
      id: "ask-1",
      channelId: "ch-dm",
      conversationId: "conv-1",
      turnId: "t1",
      requestId: "r1",
      request: {
        kind: "approval",
        command: "rm -rf build/",
        description: "clean the build folder",
        options: ["once", "always", "deny"],
      },
      state: "open",
      createdAt: T0,
    };
    const entries = mergeThreadEntries([], model, { ...OPTS, asks: [ask] });
    const card = entries[0];
    if (card.kind !== "agent") throw new Error("expected agent entry");
    expect(card.approval).toMatchObject({
      id: "ask-1",
      reason: "rm -rf build/",
      command: "rm -rf build/",
    });
  });

  it("a resolved ask folds to a decided receipt", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "cleaned" }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    const ask: Ask = {
      id: "ask-1",
      channelId: "ch-dm",
      conversationId: "conv-1",
      turnId: "t1",
      requestId: "r1",
      request: {
        kind: "approval",
        command: "rm -rf build/",
        description: "clean the build folder",
        options: ["once", "always", "deny"],
      },
      state: "resolved",
      outcome: "deny",
      createdAt: T0,
    };
    const entries = mergeThreadEntries([], model, { ...OPTS, asks: [ask] });
    const card = entries[0];
    if (card.kind !== "agent") throw new Error("expected agent entry");
    expect(card.decided).toEqual({
      approved: false,
      what: "rm -rf build/",
    });
  });

  it("#264 the receipt carries the command verbatim — a long one never truncates", () => {
    const command =
      'git commit -am "fix: rebase the worktree index migration onto main and drop the stale checkpoint rows"';
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "done" }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    const ask: Ask = {
      id: "ask-1",
      channelId: "ch-dm",
      conversationId: "conv-1",
      turnId: "t1",
      requestId: "r1",
      request: {
        kind: "approval",
        command,
        description: `terminal wants to run: ${command}`,
        options: ["once", "always", "deny"],
      },
      state: "resolved",
      outcome: "once",
      createdAt: T0,
    };
    const entries = mergeThreadEntries([], model, { ...OPTS, asks: [ask] });
    const card = entries[0];
    if (card.kind !== "agent") throw new Error("expected agent entry");
    expect(card.decided).toEqual({ approved: true, what: command });
  });

  it("#134 a rewound turn never resurrects (refs and texts both hide it)", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small", ref: "m-gone" }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "old answer" }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
      ev("turn.started", { turnId: "t2", model: "fake-small", ref: "m1" }),
      ev("turn.delta", { turnId: "t2", stream: "text", delta: "current" }),
      ev("turn.completed", { turnId: "t2", stopReason: "end_turn" }),
    ]);
    const prompt = msg({ id: "m1", seq: 1, text: "again" });
    const entries = mergeThreadEntries([prompt], model, {
      ...OPTS,
      rewoundRefs: new Set(["m-gone"]),
      rewoundTexts: new Set(["old answer"]),
    });
    const texts = entries.map((e) => e.text);
    expect(texts).not.toContain("old answer");
    expect(entries.filter((e) => e.id === "turn-t2")).toHaveLength(1);
  });

  it("#134 dropRewound cuts the tail and files-only ids, reporting removed rows", () => {
    const msgs = [
      msg({ id: "m1", seq: 1, text: "a" }),
      msg({ id: "m2", seq: 2, text: "b", authorKind: "employee" }),
      msg({ id: "m3", seq: 3, text: "c" }),
      msg({ id: "m4", seq: 4, text: "mid" }),
    ];
    const cut = dropRewound(msgs, { fromSeq: 3, removedIds: ["m4"] });
    expect(cut.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(cut.removed.map((m) => m.id)).toEqual(["m3", "m4"]);
    // Files-only rewind: a mid-list id drop, no tail cut.
    const partial = dropRewound(msgs, { fromSeq: 99, removedIds: ["m2"] });
    expect(partial.messages.map((m) => m.id)).toEqual(["m1", "m3", "m4"]);
    expect(dropRewound(msgs).messages).toHaveLength(4);
  });

  it("#134 a rewind while viewing hides the turn its prompt spawned", () => {
    /* The rewind removed m-dead (the prompt) and its answer; the screen's
       dropRewound already cut both rows — the rewind record must still stop
       the finished turn resurrecting as an orphaned card. */
    const user = msg({ id: "m1", seq: 1, text: "earlier" });
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small", ref: "m-dead" }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "dead answer" }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    const detail = toThreadDetail({
      conversation: conv(),
      employee: ada,
      messages: [user],
      model,
      asks: [],
      pending: new Set(),
      now: T0 + 60_000,
      rewound: {
        refs: new Set(["m-dead"]),
        texts: new Set(["dead answer"]),
      },
    });
    expect(detail.entries.map((e) => e.id)).toEqual(["m1"]);
  });

  it("#134 a live ref wins over a rewound-text match (web rule)", () => {
    /* A legit turn whose text happens to duplicate a rewound answer stays:
       the rewound-texts check only applies to ref-less turns. */
    const user = msg({ id: "m2", seq: 2, text: "again" });
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small", ref: "m2" }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "same words" }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    const entries = mergeThreadEntries([user], model, {
      ...OPTS,
      rewoundRefs: new Set(["m-dead"]),
      rewoundTexts: new Set(["same words"]),
    });
    expect(entries.map((e) => e.id)).toEqual(["m2", "turn-t1"]);
  });

  it("an empty finished turn never renders a bare card; stopped keeps its receipt", () => {
    const user = msg({ id: "m1", seq: 1, text: "go" });
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small", ref: "m1" }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
      ev("turn.started", { turnId: "t2", model: "fake-small", ref: "m1" }),
      ev("turn.completed", { turnId: "t2", stopReason: "cancelled" }),
    ]);
    const entries = mergeThreadEntries([user], model, OPTS);
    expect(entries.map((e) => e.id)).toEqual(["m1", "turn-t2"]);
    const card = entries[1];
    if (card.kind !== "agent") throw new Error("expected agent entry");
    expect(card.stopped).toBe(true);
  });

  it("two leftover turns sharing one prompt ref keep turn order", () => {
    const user = msg({ id: "m1", seq: 1, text: "go" });
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small", ref: "m1" }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "first" }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
      ev("turn.started", { turnId: "t2", model: "fake-small", ref: "m1" }),
      ev("turn.delta", { turnId: "t2", stream: "text", delta: "second" }),
      ev("turn.completed", { turnId: "t2", stopReason: "end_turn" }),
    ]);
    const entries = mergeThreadEntries([user], model, OPTS);
    expect(entries.map((e) => e.id)).toEqual(["m1", "turn-t1", "turn-t2"]);
  });

  it("#179 subagents and jobs render as neutral rows, never crash", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("subagent.started", {
        turnId: "t1",
        subagentId: "sa-1",
        name: "helper 1",
        task: "probe the relay",
      }),
      ev("subagent.completed", {
        subagentId: "sa-1",
        status: "done",
        result: "found it",
        durationMs: 1200,
      }),
      ev("job.started", {
        jobId: "j1",
        command: "bun run dev",
        startedAt: T0 - 5000,
      }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    const entries = mergeThreadEntries([], model, OPTS);
    const card = entries[0];
    if (card.kind !== "agent") throw new Error("expected agent entry");
    expect(card.subagents).toMatchObject([
      { id: "sa-1", name: "helper 1", status: "done", dur: 1.2 },
    ]);
    expect(model.jobs.map((j) => j.jobId)).toEqual(["j1"]);
  });

  it("AC-6/7 toThreadDetail fills sheet fields; entries land newest last", () => {
    const user = msg({ id: "m1", seq: 1, text: "fix the bug" });
    const reply = msg({
      id: "m2",
      seq: 2,
      authorKind: "employee",
      authorId: ada.id,
      text: "done",
      createdAt: T0 + 10_000,
    });
    const model = reduceSessionEvents("sess-1", [
      ev("session.started", {
        agent: "ada",
        cwd: "~/code/lilos",
        model: "fake-small",
      }),
      ev("turn.started", { turnId: "t1", model: "fake-small", ref: "m1" }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "done" }),
      ev("turn.completed", {
        turnId: "t1",
        stopReason: "end_turn",
        usage: { input: 22400, output: 1800, reasoning: 0, cache: 15000 },
      }),
    ]);
    const detail = toThreadDetail({
      conversation: conv({
        cwd: "~/code/lilos",
        workspace: {
          mode: "new",
          repoPath: "~/code/lilos",
          branch: "ws/fix-7",
          base: "main",
        },
      }),
      employee: ada,
      messages: [user, reply],
      model,
      asks: [],
      pending: new Set(),
      now: T0 + 60_000,
      models: [{ id: "fake-small", name: "Fake Small", provider: "fake" }],
    });
    expect(detail.folder).toEqual({ name: "lilos", path: "~/code/lilos" });
    expect(detail.branch?.name).toBe("ws/fix-7");
    expect(detail.branch?.detail).toContain("off main");
    expect(detail.model).toBe("Fake Small");
    expect(detail.session).toBe("sess-1");
    expect(detail.usage).toBe("22.4k in · 1.8k out · 15k cached");
    // AC-7: newest is the last entry.
    expect(detail.entries.at(-1)).toMatchObject({ kind: "agent" });
  });

  it("AC-1 a user reply lands as a new entry; turn.merge keeps order", () => {
    const m1 = msg({ id: "m1", seq: 1, text: "first" });
    const a1 = msg({
      id: "m2",
      seq: 2,
      authorKind: "employee",
      authorId: ada.id,
      text: "answer one",
      createdAt: T0 + 1000,
    });
    const m2 = msg({ id: "m3", seq: 3, text: "second" });
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", ref: "m1" }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "answer one" }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
      ev("turn.started", { turnId: "t2", ref: "m3" }),
      ev("turn.delta", { turnId: "t2", stream: "reasoning", delta: "hmm" }),
    ]);
    const entries = mergeThreadEntries([m1, a1, m2], model, OPTS);
    expect(entries.map((e) => e.id)).toEqual([
      "m1",
      "turn-t1",
      "m3",
      "turn-t2",
    ]);
  });
});

describe("#264 blocked-on-ask — one waiting state across turn surfaces", () => {
  const approvalAsk = (over: Partial<Ask> = {}): Ask => ({
    id: "ask-1",
    channelId: "ch-dm",
    conversationId: "conv-1",
    turnId: "t1",
    requestId: "r1",
    request: {
      kind: "approval",
      command: "gh pr create --title ship",
      description: "open the PR",
      options: ["once", "always", "deny"],
    },
    state: "open",
    createdAt: T0,
    ...over,
  });

  const gatedTurn = () =>
    reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("tool.started", {
        turnId: "t1",
        toolCallId: "c1",
        tool: "terminal",
        input: { command: "gh pr create --title ship" },
      }),
    ]);

  it("a live turn gated by an approval ask reports waiting='approval'", () => {
    const entries = mergeThreadEntries([], gatedTurn(), {
      ...OPTS,
      asks: [approvalAsk()],
    });
    const card = entries.at(-1);
    if (card?.kind !== "agent") throw new Error("expected agent entry");
    expect(card.waiting).toBe("approval");
  });

  it("a live turn gated by a question ask reports waiting='question'", () => {
    const entries = mergeThreadEntries([], gatedTurn(), {
      ...OPTS,
      asks: [
        approvalAsk({
          request: { kind: "question", question: "which branch?" },
        }),
      ],
    });
    const card = entries.at(-1);
    if (card?.kind !== "agent") throw new Error("expected agent entry");
    expect(card.waiting).toBe("question");
  });

  it("a live turn gated by a proposed plan reports waiting='plan'", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("plan.updated", {
        turnId: "t1",
        planId: "plan-t1",
        kind: "plan",
        version: 1,
        goal: "ship it",
        steps: [
          { text: "do a", status: "pending" },
          { text: "do b", status: "pending" },
        ],
      }),
      ev("request.opened", {
        turnId: "t1",
        requestId: "r1",
        request: { kind: "plan", planId: "plan-t1" },
      }),
    ]);
    const entries = mergeThreadEntries([], model, {
      ...OPTS,
      asks: [approvalAsk({ request: { kind: "plan", planId: "plan-t1" } })],
    });
    const card = entries.at(-1);
    if (card?.kind !== "agent") throw new Error("expected agent entry");
    expect(card.waiting).toBe("plan");
  });

  it("a running turn with no open ask is not waiting", () => {
    const entries = mergeThreadEntries([], gatedTurn(), OPTS);
    const card = entries.at(-1);
    if (card?.kind !== "agent") throw new Error("expected agent entry");
    expect(card.live).toBe(true);
    expect(card.waiting).toBeUndefined();
  });

  it("a resolved ask clears waiting on the still-live turn", () => {
    const entries = mergeThreadEntries([], gatedTurn(), {
      ...OPTS,
      asks: [
        approvalAsk({ state: "resolved", outcome: "once", resolvedAt: T0 + 1 }),
      ],
    });
    const card = entries.at(-1);
    if (card?.kind !== "agent") throw new Error("expected agent entry");
    expect(card.waiting).toBeUndefined();
  });

  it("a queued user line is waiting while the conversation has an open ask", () => {
    const queued = msg({ id: "m9", seq: 9, text: "also do this" });
    const entries = mergeThreadEntries([queued], gatedTurn(), {
      ...OPTS,
      asks: [approvalAsk()],
    });
    const bubble = entries.find((e) => e.id === "m9");
    if (bubble?.kind !== "user") throw new Error("expected user entry");
    expect(bubble.queued).toBe(true);
    expect(bubble.waiting).toBe(true);
  });

  it("a queued user line is not waiting when nothing asks", () => {
    const queued = msg({ id: "m9", seq: 9, text: "also do this" });
    const entries = mergeThreadEntries([queued], gatedTurn(), OPTS);
    const bubble = entries.find((e) => e.id === "m9");
    if (bubble?.kind !== "user") throw new Error("expected user entry");
    expect(bubble.queued).toBe(true);
    expect(bubble.waiting).toBeUndefined();
  });

  it("an open ask on another conversation does not mark the bubble waiting", () => {
    const queued = msg({ id: "m9", seq: 9, text: "also do this" });
    const entries = mergeThreadEntries([queued], gatedTurn(), {
      ...OPTS,
      asks: [approvalAsk({ conversationId: "conv-other" })],
    });
    const bubble = entries.find((e) => e.id === "m9");
    if (bubble?.kind !== "user") throw new Error("expected user entry");
    expect(bubble.queued).toBe(true);
    expect(bubble.waiting).toBeUndefined();
  });

  it("a delivered user line never carries queued/waiting", () => {
    const sent = msg({ id: "m1", seq: 1, text: "go" });
    const entries = mergeThreadEntries([sent], gatedTurn(), {
      ...OPTS,
      asks: [approvalAsk()],
    });
    const bubble = entries.find((e) => e.id === "m1");
    if (bubble?.kind !== "user") throw new Error("expected user entry");
    expect(bubble.queued).toBeUndefined();
    expect(bubble.waiting).toBeUndefined();
  });
});

describe("#247 mobile polish — prototype thread details on real data", () => {
  /* The wire is already right: engine-fake emits diff.patch on
     tool.completed and cumulative usage on turn.completed. The mobile
     projection had to carry both through to ui-native. */
  const patch =
    "@@ -46,3 +46,6 @@ fn main\n   boot();\n-  old();\n+  next();\n+  next2();\n";

  it("AC-3 an edit step carries the patch — it opens to the coloured diff", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("tool.started", {
        turnId: "t1",
        toolCallId: "c1",
        tool: "patch",
        input: { path: "a.ts" },
      }),
      ev("tool.completed", {
        turnId: "t1",
        toolCallId: "c1",
        tool: "patch",
        status: "completed",
        diff: { path: "a.ts", status: "modified", add: 4, del: 1, patch },
      }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    const entries = mergeThreadEntries([], model, OPTS);
    const card = entries.at(-1);
    if (card?.kind !== "agent") throw new Error("expected agent entry");
    expect(card.steps).toMatchObject([
      { tool: "patch", arg: "a.ts", add: 4, del: 1, patch, running: false },
    ]);
  });

  it("AC-3 a terminal step opens to its output — no patch key on it", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("tool.started", {
        turnId: "t1",
        toolCallId: "c2",
        tool: "terminal",
        input: { command: "bun test" },
      }),
      ev("tool.completed", {
        turnId: "t1",
        toolCallId: "c2",
        tool: "terminal",
        status: "completed",
        output: "3 pass, 0 fail",
      }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    const entries = mergeThreadEntries([], model, OPTS);
    const card = entries.at(-1);
    if (card?.kind !== "agent") throw new Error("expected agent entry");
    const step = card.steps?.find((s) => s.tool === "terminal");
    expect(step?.output).toBe("3 pass, 0 fail");
    expect(step?.patch).toBeUndefined();
  });

  it("AC-4 context fills from the newest turn's usage + the engine window", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("session.started", {
        agent: "ada",
        cwd: "~/code/lilos",
        model: "fake-small",
      }),
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("turn.completed", {
        turnId: "t1",
        stopReason: "end_turn",
        usage: {
          input: 40_000,
          output: 2_000,
          reasoning: 800,
          cache: 12_000,
          contextWindow: 256_000,
        },
      }),
    ]);
    const detail = toThreadDetail({
      conversation: conv(),
      employee: ada,
      messages: [],
      model,
      asks: [],
      pending: new Set(),
      now: T0 + 60_000,
    });
    expect(detail.context).toEqual({
      input: 40_000,
      output: 2_000,
      reasoning: 800,
      cache: 12_000,
      max: 256_000,
      estimated: false,
    });
  });

  it("AC-4 the window falls back to the model's catalog row, else ~", () => {
    const turn = (t: string, model: string) => [
      /* The session model the window looks up lives on session.started —
         the shape the real wire (and engine-fake) always emits. */
      ev("session.started", { agent: "ada", cwd: "~/code", model }),
      ev("turn.started", { turnId: t, model }),
      ev("turn.completed", {
        turnId: t,
        stopReason: "end_turn",
        usage: { input: 10_000, output: 500, reasoning: 0, cache: 0 },
      }),
    ];
    const mk = (
      events: EngineEvent[],
      models: {
        id: string;
        name: string;
        provider: string;
        contextWindow?: number;
      }[],
    ) =>
      toThreadDetail({
        conversation: conv(),
        employee: ada,
        messages: [],
        model: reduceSessionEvents("sess-1", events),
        asks: [],
        pending: new Set(),
        now: T0 + 60_000,
        models,
      });
    /* Catalog row wins over the guess when the engine reports no window. */
    expect(
      mk(turn("t1", "fake-small"), [
        {
          id: "fake-small",
          name: "Fake Small",
          provider: "fake",
          contextWindow: 32_768,
        },
      ]).context,
    ).toMatchObject({ max: 32_768, estimated: false });
    /* Nothing reports it: the ~-labelled estimate (qwen = 262k, else 200k). */
    expect(mk(turn("t2", "qwen3-coder"), []).context).toMatchObject({
      max: 262_000,
      estimated: true,
    });
    expect(mk(turn("t3", "claude-x"), []).context).toMatchObject({
      max: 200_000,
      estimated: true,
    });
  });

  it("AC-4 no usage yet keeps the meter away (no invented numbers)", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "working" }),
    ]);
    const detail = toThreadDetail({
      conversation: conv(),
      employee: ada,
      messages: [],
      model,
      asks: [],
      pending: new Set(),
      now: T0 + 60_000,
    });
    expect(detail.context).toBeUndefined();
  });

  it("#300 a dead engine session keeps the meter off the persisted conv.usage", () => {
    /* Legacy engineRefs degrade to an empty replay — no turns, no model —
       but the relay's persisted last turn.completed still fills the meter
       + ring exactly as a live usage would. */
    const detail = toThreadDetail({
      conversation: conv({
        engineRef: "s1",
        usage: {
          input: 12000,
          output: 3400,
          reasoning: 200,
          cache: 5000,
          contextWindow: 200000,
        },
      }),
      employee: ada,
      messages: [],
      asks: [],
      pending: new Set(),
      now: T0 + 60_000,
    });
    expect(detail.context).toEqual({
      input: 12000,
      output: 3400,
      reasoning: 200,
      cache: 5000,
      max: 200000,
      estimated: false,
    });
    expect(detail.usage).toBe("12k in · 3.6k out · 5k cached");
    /* A live turn's usage still wins over the persisted row. */
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("turn.completed", {
        turnId: "t1",
        stopReason: "end_turn",
        usage: { input: 99000, output: 100, reasoning: 0, cache: 0 },
      }),
    ]);
    const live = toThreadDetail({
      conversation: conv({
        usage: {
          input: 12000,
          output: 3400,
          reasoning: 0,
          cache: 0,
        },
      }),
      employee: ada,
      messages: [],
      model,
      asks: [],
      pending: new Set(),
      now: T0 + 60_000,
    });
    expect(live.context?.input).toBe(99000);
  });
});
