import { reduceSessionEvents } from "@lilos/client-runtime";
import type { AppMessage, Conversation, Employee } from "@lilos/contracts/app";
import type { EngineEvent, Job } from "@lilos/contracts/engine";
import { describe, expect, it } from "vitest";
import { threadBottomInset } from "../../../packages/ui-native/src/employees/thread-layout";
import { toThreadDetail } from "../src/thread-model";

/* #181 — subagents & background jobs on the phone's live thread. The reducer
   and row shapes are shared with web (#179); these pin the phone-side rules:
   employee-helper resolution (profile ref -> employee, sessionRef -> thread),
   the jobs.list overlay under live job.* rows, and capability gating (D-#19). */

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

const blair: Employee = {
  id: "emp-blair",
  name: "Blair",
  role: "review",
  status: "online",
  profile: "blair",
  model: "fake-small",
  now: "",
  instructions: "",
  respondTo: "me",
  createdAt: 0,
};

const BASE = {
  conversation: conv(),
  employee: ada,
  messages: [] as AppMessage[],
  asks: [],
  pending: new Set<string>(),
  now: T0 + 60_000,
};

describe("thread subagents & background jobs — #181", () => {
  it("AC-1 a delegating turn carries live helper rows that settle with dur + report", () => {
    const user = msg({ id: "m1", seq: 1, text: "delegate the audit" });
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small", ref: "m1" }),
      ev("subagent.started", {
        turnId: "t1",
        subagentId: "sa-1",
        name: "Scan the relay package",
        task: "List the relay exports",
        parentToolCallId: "c0",
      }),
      ev("tool.started", {
        turnId: "t1",
        toolCallId: "c1",
        tool: "search_files",
        input: { pattern: "export" },
        parentToolCallId: "sa-1",
      }),
      ev("tool.completed", {
        turnId: "t1",
        toolCallId: "c1",
        tool: "search_files",
        status: "completed",
        output: "4 matches",
        parentToolCallId: "sa-1",
      }),
      ev("subagent.completed", {
        subagentId: "sa-1",
        status: "done",
        result: "Relay exports client + server.",
        durationMs: 3200,
      }),
      ev("subagent.started", {
        turnId: "t1",
        subagentId: "sa-2",
        name: "Verify the findings",
        task: "Cross-check the scan",
      }),
      ev("subagent.completed", {
        subagentId: "sa-2",
        status: "failed",
        result: "workspace probe timed out",
        durationMs: 1400,
      }),
      ev("turn.delta", {
        turnId: "t1",
        stream: "text",
        delta: "helpers reported back",
      }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    const detail = toThreadDetail({ ...BASE, messages: [user], model });
    const card = detail.entries.find(
      (e) => e.kind === "agent" && e.id === "turn-t1",
    );
    if (card?.kind !== "agent") throw new Error("expected agent card");
    expect(card.subagents).toHaveLength(2);
    expect(card.subagents?.[0]).toMatchObject({
      id: "sa-1",
      name: "Scan the relay package",
      status: "done",
      dur: 3.2,
      result: "Relay exports client + server.",
    });
    expect(card.subagents?.[0]?.steps[0]).toMatchObject({
      tool: "search_files",
      arg: "export",
      output: "4 matches",
    });
    expect(card.subagents?.[1]).toMatchObject({
      id: "sa-2",
      status: "failed",
      dur: 1.4,
      result: "workspace probe timed out",
    });
  });

  it("AC-1 a still-running helper row shows its live step", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("subagent.started", {
        turnId: "t1",
        subagentId: "sa-1",
        name: "Scan",
        task: "scan the tree",
      }),
      ev("tool.started", {
        turnId: "t1",
        toolCallId: "c1",
        tool: "search_files",
        input: { pattern: "TODO" },
        parentToolCallId: "sa-1",
      }),
    ]);
    const detail = toThreadDetail({ ...BASE, model });
    const card = detail.entries.at(-1);
    if (card?.kind !== "agent") throw new Error("expected agent card");
    expect(card.subagents?.[0]).toMatchObject({
      id: "sa-1",
      status: "running",
    });
    expect(card.subagents?.[0]?.steps[0]?.running).toBe(true);
  });

  it("AC-2 an employee helper row resolves to the LilOS employee + their thread", () => {
    const blairConv = conv({
      id: "conv-blair",
      channelId: "ch-blair",
      engineRef: "sess-9",
    });
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("subagent.started", {
        turnId: "t1",
        subagentId: "sa-1",
        name: "Draft the summary",
        task: "Summarise the helpers' findings",
        employee: { employeeRef: "blair", sessionRef: "sess-9" },
      }),
      ev("subagent.completed", {
        subagentId: "sa-1",
        status: "done",
        durationMs: 900,
      }),
    ]);
    const detail = toThreadDetail({
      ...BASE,
      model,
      employees: [ada, blair],
      conversations: [conv(), blairConv],
    });
    const card = detail.entries.at(-1);
    if (card?.kind !== "agent") throw new Error("expected agent card");
    expect(card.subagents?.[0]?.employee).toMatchObject({
      id: "emp-blair",
      name: "Blair",
      threadId: "conv-blair",
    });
  });

  it("AC-2 an unknown profile ref still renders a neutral row (no employee link)", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("subagent.started", {
        turnId: "t1",
        subagentId: "sa-1",
        name: "helper",
        task: "work",
        employee: { employeeRef: "ghost", sessionRef: "sess-x" },
      }),
    ]);
    const detail = toThreadDetail({
      ...BASE,
      model,
      employees: [ada],
      conversations: [conv()],
    });
    const card = detail.entries.at(-1);
    if (card?.kind !== "agent") throw new Error("expected agent card");
    /* The row keeps the ref as a plain label — no thread to open. */
    expect(card.subagents?.[0]?.employee?.id).toBe("ghost");
    expect(card.subagents?.[0]?.employee?.threadId).toBeUndefined();
  });

  it("AC-3 a running job lists on the thread with command + output tail; exited settles it", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("job.started", {
        jobId: "j1",
        command: "bun run dev",
        startedAt: T0 - 30_000,
      }),
      ev("job.output", {
        jobId: "j1",
        tail: "$ bun run dev\nvite v7 ready\nLocal: http://localhost:4173/",
        url: "http://localhost:4173/",
      }),
    ]);
    const detail = toThreadDetail({ ...BASE, model, jobsCapable: true });
    expect(detail.jobs).toHaveLength(1);
    expect(detail.jobs?.[0]).toMatchObject({
      id: "j1",
      command: "bun run dev",
      status: "running",
      uptime: "1m",
      url: "http://localhost:4173/",
    });
    expect(detail.jobs?.[0]?.log).toContain("vite v7 ready");

    const stopped = reduceSessionEvents("sess-1", [
      ev("job.started", {
        jobId: "j1",
        command: "bun run dev",
        startedAt: T0 - 30_000,
      }),
      ev("job.exited", { jobId: "j1", status: "stopped" }),
    ]);
    const d2 = toThreadDetail({ ...BASE, model: stopped, jobsCapable: true });
    expect(d2.jobs?.[0]?.status).toBe("stopped");
  });

  it("AC-3 jobs.list rows merge under the event stream without duplicates", () => {
    /* Reconnect shape: the engine's snapshot still shows j1 running while
       its job.exited event already replayed — the event wins (fresher), and
       a job the stream never saw (pre-attach start) still lists. */
    const listed: Job[] = [
      {
        jobId: "j1",
        command: "bun run dev",
        status: "running",
        startedAt: T0 - 30_000,
        tail: "stale tail",
      },
      {
        jobId: "j0",
        command: "bun run build",
        status: "exited",
        exitCode: 0,
        startedAt: T0 - 90_000,
        tail: "build done",
      },
    ];
    const model = reduceSessionEvents("sess-1", [
      ev("job.started", { jobId: "j1", command: "bun run dev", startedAt: T0 }),
      ev("job.exited", { jobId: "j1", status: "stopped" }),
    ]);
    const detail = toThreadDetail({
      ...BASE,
      model,
      jobsCapable: true,
      listedJobs: listed,
    });
    expect(detail.jobs?.map((j) => j.id)).toEqual(["j1", "j0"]);
    expect(detail.jobs?.[0]?.status).toBe("stopped");
    expect(detail.jobs?.[1]).toMatchObject({
      command: "bun run build",
      status: "exited",
      log: "build done",
    });
  });

  it("AC-4 replayed job/subagent events rebuild the same rows, no duplicates", () => {
    const events = [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("subagent.started", {
        turnId: "t1",
        subagentId: "sa-1",
        name: "Scan",
        task: "scan",
      }),
      ev("job.started", {
        jobId: "j1",
        command: "bun run dev",
        startedAt: T0 - 5_000,
      }),
      /* The feed merge dedupes by sessionId#seq; a replay window overlapping
         a live frame sends job.started twice — the row must not double. */
      ev("job.started", {
        jobId: "j1",
        command: "bun run dev",
        startedAt: T0 - 5_000,
      }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ];
    const detail = toThreadDetail({
      ...BASE,
      model: reduceSessionEvents("sess-1", events),
      jobsCapable: true,
    });
    /* j1 + the still-running helper's synthesized sa: row (#309 — an
       unclosed subagent stays running past turn.completed). */
    expect(detail.jobs?.map((j) => j.id)).toEqual(["j1", "sa:sa-1"]);
    const card = detail.entries.at(-1);
    if (card?.kind !== "agent") throw new Error("expected agent card");
    expect(card.subagents).toHaveLength(1);
    expect(card.subagents?.[0].status).toBe("running");
  });

  it("AC-4 identical canned replies across turns stay separate cards (no dup turn ids)", () => {
    /* A rebound engine re-issues t1/t2 with byte-identical canned text. The
       byText map stamped the SAME turn on every matching message — each turn
       may claim at most one message, in order (web's `used` set). */
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small", ref: "m1" }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "same reply" }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
      ev("turn.started", { turnId: "t2", model: "fake-small", ref: "m3" }),
      ev("turn.delta", { turnId: "t2", stream: "text", delta: "same reply" }),
      ev("turn.completed", { turnId: "t2", stopReason: "end_turn" }),
    ]);
    const messages = [
      msg({ id: "m1", seq: 1, text: "first" }),
      msg({ id: "m2", seq: 2, authorKind: "employee", text: "same reply" }),
      msg({ id: "m3", seq: 3, text: "second" }),
      msg({ id: "m4", seq: 4, authorKind: "employee", text: "same reply" }),
    ];
    const detail = toThreadDetail({ ...BASE, messages, model });
    const cardIds = detail.entries
      .filter((e) => e.kind === "agent")
      .map((e) => e.id);
    expect(cardIds).toEqual(["turn-t1", "turn-t2"]);
    expect(new Set(cardIds).size).toBe(cardIds.length);
  });

  it("AC-4 a rebound turn never claims an older session's identical reply (no phantom card)", () => {
    /* Session A ran two prompts whose replies were "same reply". After a
       restart, session B's turn t2 (ids restart per session) produced the
       same text — but its prompt (m5) sits AFTER A's replies. The claim is
       position-bounded: t2 may only match a message after its ref prompt,
       so m2/m4 keep their plain rows and t2 lands on its own reply m7. */
    const model = reduceSessionEvents("sess-2", [
      ev(
        "turn.started",
        { turnId: "t2", model: "fake-small", ref: "m5" },
        "sess-2",
      ),
      ev(
        "subagent.started",
        {
          turnId: "t2",
          subagentId: "sa-1",
          name: "Scan",
          task: "scan",
        },
        "sess-2",
      ),
      ev(
        "subagent.completed",
        { subagentId: "sa-1", status: "done", durationMs: 900 },
        "sess-2",
      ),
      ev(
        "turn.delta",
        { turnId: "t2", stream: "text", delta: "same reply" },
        "sess-2",
      ),
      ev("turn.completed", { turnId: "t2", stopReason: "end_turn" }, "sess-2"),
    ]);
    const messages = [
      msg({ id: "m1", seq: 1, text: "first" }),
      msg({ id: "m2", seq: 2, authorKind: "employee", text: "same reply" }),
      msg({ id: "m3", seq: 3, text: "second" }),
      msg({ id: "m4", seq: 4, authorKind: "employee", text: "same reply" }),
      msg({ id: "m5", seq: 5, text: "third" }),
      msg({ id: "m7", seq: 6, authorKind: "employee", text: "same reply" }),
    ];
    const detail = toThreadDetail({ ...BASE, messages, model });
    const agentIds = detail.entries
      .filter((e) => e.kind === "agent")
      .map((e) => e.id);
    expect(agentIds).toEqual(["m2", "m4", "turn-t2"]);
    expect(detail.entries.at(-1)?.id).toBe("turn-t2");
  });

  it("AC-4 a live turn's streamed reply never claims its posted message (no duplicate turn-<id> key)", () => {
    /* The relay can deliver the reply message a frame before turn.completed
       — the live turn's streamed text already equals it, so an unconditional
       claim renders the card at the message AND at the tail under the same
       `turn-tN` key (the React duplicate-key warning the reviewer caught).
       Only a settled turn may claim. */
    const messages = [
      msg({ id: "m1", seq: 1, text: "go" }),
      msg({ id: "m2", seq: 2, authorKind: "employee", text: "same reply" }),
    ];
    const live = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small", ref: "m1" }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "same reply" }),
    ]);
    const whileLive = toThreadDetail({ ...BASE, messages, model: live });
    const ids = whileLive.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    /* The message stays a plain row until the turn settles; the live card
       anchors under the message that prompted it (#308). */
    expect(ids).toEqual(["m1", "turn-t1", "m2"]);
    const done = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small", ref: "m1" }),
      ev("turn.delta", { turnId: "t1", stream: "text", delta: "same reply" }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    const settled = toThreadDetail({ ...BASE, messages, model: done });
    expect(settled.entries.map((e) => e.id)).toEqual(["m1", "turn-t1"]);
  });

  it("AC-4 a finished job's uptime freezes at endedAt (no inflation past exit)", () => {
    const exited = reduceSessionEvents("sess-1", [
      ev("job.started", {
        jobId: "j1",
        command: "bun run dev",
        startedAt: T0 - 30_000,
      }),
      ev("job.exited", {
        jobId: "j1",
        status: "stopped",
        endedAt: T0 - 25_000,
      }),
    ]);
    const detail = toThreadDetail({
      ...BASE,
      model: exited,
      jobsCapable: true,
    });
    expect(detail.jobs?.[0]?.uptime).toBe("5s");
    /* A jobs.list row carries endedAt through too. */
    const listed = toThreadDetail({
      ...BASE,
      jobsCapable: true,
      listedJobs: [
        {
          jobId: "j2",
          command: "bun run dev",
          status: "stopped",
          startedAt: T0 - 30_000,
          endedAt: T0 - 10_000,
        },
      ],
    });
    expect(listed.jobs?.[0]?.uptime).toBe("20s");
  });

  it("the thread bottom inset clears the pill too — composer + gap + pill, not composer alone", () => {
    /* Review fix: #182's composer-only inset left the newest line under the
       floating pill — the inset must cover the whole bottom stack. */
    expect(threadBottomInset(96, 0)).toBe(96);
    expect(threadBottomInset(96, 32)).toBe(96 + 32 + 8);
  });

  it("AC-5 background surfaces stay empty when the engine did not declare the capability", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("job.started", {
        jobId: "j1",
        command: "bun run dev",
        startedAt: T0,
      }),
    ]);
    const detail = toThreadDetail({
      ...BASE,
      model,
      jobsCapable: false,
      listedJobs: [
        { jobId: "j0", command: "x", status: "running", startedAt: T0 },
      ],
    });
    expect(detail.jobs).toBeUndefined();
  });
});
