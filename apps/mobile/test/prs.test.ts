import { reduceSessionEvents } from "@lilos/client-runtime";
import type {
  AppMessage,
  Ask,
  Conversation,
  ConversationSummary,
} from "@lilos/contracts/app";
import type { EngineEvent } from "@lilos/contracts/engine";
import type { ForgePrListItem } from "@lilos/contracts/host";
import type { PullRequestRef } from "@lilos/ui-native";
import { describe, expect, it } from "vitest";
import { toSessionTurns } from "../src/dm-model";
import {
  $prs,
  refreshConversationPrs,
  toPullRequestRef,
  watchPrs,
} from "../src/prs";
import { mergeThreadEntries, toThreadDetail } from "../src/thread-model";

/* #159: the gh list row -> PullRequestRef mapping, the per-conversation
   $prs store the screens read, and the DM/thread models carrying prs onto
   the view model (PrLine on the row, header headline + Session sheet on the
   thread). AC-2's several-per-thread ordering lives in host mapPrList
   (packages/host/test/forge.test.ts); AC-5's refresh triggers are wired in
   screens (watchPrs' turn.completed + open effects). */

const T0 = Date.parse("2026-09-29T12:00:00Z");

const item = (over: Partial<ForgePrListItem> = {}): ForgePrListItem => ({
  number: 96,
  url: "https://github.com/acme/widgets/pull/96",
  repo: "acme/widgets",
  title: "Fix the badge",
  state: "open",
  draft: false,
  head: "ws/fix-7",
  base: "main",
  openedAt: "2026-09-24T08:00:00Z",
  checks: "none",
  ...over,
});

describe("#159 AC-2 toPullRequestRef — gh row -> badge view model", () => {
  it("an open draft is 'draft' (gray), a closed draft stays 'closed'", () => {
    expect(toPullRequestRef(item({ draft: true })).status).toBe("draft");
    expect(
      toPullRequestRef(item({ draft: true, state: "closed" })).status,
    ).toBe("closed");
    expect(toPullRequestRef(item({ state: "merged" })).status).toBe("merged");
  });

  it("checks 'none' drops the CI dot; the rest pass through", () => {
    expect(toPullRequestRef(item({ checks: "none" })).checks).toBeUndefined();
    expect(toPullRequestRef(item({ checks: "failing" })).checks).toBe(
      "failing",
    );
    expect(toPullRequestRef(item({ checks: "pending" })).checks).toBe(
      "pending",
    );
  });
});

const msg = (over: Partial<AppMessage> = {}): AppMessage => ({
  id: "m1",
  channelId: "ch-dm",
  authorId: "user",
  conversationId: "conv-1",
  authorKind: "user",
  text: "ship it",
  seq: 1,
  createdAt: T0,
  rewound: false,
  dropped: false,
  removed: false,
  ...over,
});

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: "conv-1",
  channelId: "ch-dm",
  rootMessageId: "m1",
  engineRef: "sess-1",
  state: "idle",
  title: "ship it",
  titleSource: "auto",
  access: "ask",
  archived: false,
  deliveredSeq: 1,
  createdAt: T0 - 60_000,
  ...over,
});

const summary = (): ConversationSummary => ({
  conversation: conv(),
  root: msg(),
  last: msg({ authorKind: "employee", authorId: "builder" }),
  messageCount: 2,
});

const PRS: PullRequestRef[] = [
  { number: 96, title: "Fix the badge", status: "draft", checks: "failing" },
  { number: 91, title: "Landed", status: "merged" },
];

describe("#159 AC-3 view models carry the thread's PRs", () => {
  it("toSessionTurns puts the conversation's PRs on its row", () => {
    const turns = toSessionTurns([summary()], {
      channelId: "ch-dm",
      employee: { id: "builder", name: "Builder", tone: "blue" },
      openAsks: [] as Ask[],
      pending: new Map(),
      prs: { "conv-1": PRS },
      now: T0,
    });
    expect(turns[0]?.prs).toEqual(PRS);
  });

  it("no PRs for the conversation leaves prs unset (AC-4 nothing shown)", () => {
    const turns = toSessionTurns([summary()], {
      channelId: "ch-dm",
      employee: { id: "builder", name: "Builder", tone: "blue" },
      openAsks: [] as Ask[],
      pending: new Map(),
      prs: { "conv-other": PRS },
      now: T0,
    });
    expect(turns[0]?.prs).toBeUndefined();
  });

  it("toThreadDetail carries prs to the header + Session sheet", () => {
    const detail = toThreadDetail({
      conversation: conv(),
      messages: [msg()],
      asks: [],
      pending: new Set(),
      now: T0,
      prs: PRS,
    });
    expect(detail.prs).toEqual(PRS);
    const bare = toThreadDetail({
      conversation: conv(),
      messages: [msg()],
      asks: [],
      pending: new Set(),
      now: T0,
    });
    expect(bare.prs).toBeUndefined();
  });
});

describe("#159 AC-1 refreshConversationPrs — one conversations.prs call fills $prs", () => {
  it("stores the mapped refs under the conversation id", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const client = {
      request: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return { prs: [item({ checks: "failing", draft: true })] };
      },
      onEvent: () => () => {},
    };
    await refreshConversationPrs(client as never, "conv-1");
    expect(calls).toEqual([
      { method: "conversations.prs", params: { conversationId: "conv-1" } },
    ]);
    expect($prs.get()["conv-1"]).toEqual([
      {
        number: 96,
        title: "Fix the badge",
        status: "draft",
        checks: "failing",
      },
    ]);
  });

  it("AC-4 a failed call never clobbers a list that already landed", async () => {
    const ok = {
      request: async () => ({ prs: [item()] }),
      onEvent: () => () => {},
    };
    await refreshConversationPrs(ok as never, "conv-ok");
    expect($prs.get()["conv-ok"]).toHaveLength(1);

    const failing = {
      request: async () => {
        throw new Error("engine_unavailable");
      },
      onEvent: () => () => {},
    };
    await refreshConversationPrs(failing as never, "conv-ok");
    expect($prs.get()["conv-ok"]).toHaveLength(1); // unchanged
    await refreshConversationPrs(failing as never, "conv-nope");
    expect($prs.get()["conv-nope"]).toBeUndefined();
  });
});

describe("#159 AC-5 watchPrs — a finished turn re-lists that thread's PRs", () => {
  const fakeClient = (answer: { prs: ForgePrListItem[] }) => {
    const calls: { method: string; params: unknown }[] = [];
    let handler: (method: string, params: unknown) => void = () => {};
    const client = {
      request: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return answer;
      },
      onEvent: (fn: (method: string, params: unknown) => void) => {
        handler = fn;
        return () => {};
      },
      emit: (method: string, params: unknown) => handler(method, params),
    };
    return { client, calls };
  };

  it("turn.completed on a conversation triggers conversations.prs for it", async () => {
    const { client, calls } = fakeClient({ prs: [item({ number: 99 })] });
    watchPrs(client as never);
    client.emit("engine.event", {
      conversationId: "conv-1",
      event: { type: "turn.completed" },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([
      { method: "conversations.prs", params: { conversationId: "conv-1" } },
    ]);
    expect($prs.get()["conv-1"]?.[0]?.number).toBe(99);
  });

  it("other engine events and methods do not refresh; watchPrs subscribes once", async () => {
    const { client, calls } = fakeClient({ prs: [item()] });
    watchPrs(client as never);
    watchPrs(client as never); // WeakSet: second call is a no-op
    client.emit("engine.event", {
      conversationId: "conv-1",
      event: { type: "turn.started" },
    });
    client.emit("messages.posted", { conversationId: "conv-1" });
    client.emit("engine.event", {
      conversationId: "conv-1",
      event: { type: "turn.completed" },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1); // only the turn.completed fired, once
  });
});

describe("#159 AC-3 the reply's PR card (web: PrCard under the turn)", () => {
  let seq = 0;
  const ev = (type: string, payload: Record<string, unknown>): EngineEvent =>
    ({ seq: ++seq, sessionId: "sess-1", type, payload }) as EngineEvent;
  const OPTS = {
    conversationId: "conv-1",
    asks: [] as Ask[],
    employeeId: "builder",
    employeeName: "Builder",
    sessionId: "sess-1",
    prs: PRS,
    now: T0,
  };

  it("a finished turn that ran `gh pr create` carries the PR onto its card", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("tool.started", {
        turnId: "t1",
        toolCallId: "c1",
        tool: "terminal",
        input: { command: "gh pr create --fill" },
      }),
      ev("tool.completed", {
        turnId: "t1",
        toolCallId: "c1",
        output: "https://github.com/acme/widgets/pull/96",
      }),
      ev("turn.delta", {
        turnId: "t1",
        stream: "text",
        delta: "Opened PR #96 — status is live on the card below.",
      }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    const detail = toThreadDetail({
      conversation: conv(),
      messages: [],
      model,
      asks: [],
      pending: new Set(),
      now: T0,
      prs: PRS,
    });
    const entry = detail.entries.at(-1);
    if (entry?.kind !== "agent") throw new Error("expected agent entry");
    expect(entry.pr).toEqual(PRS[0]);
  });

  it("the card names the PR the step's output URL points at, not just prs[0]", () => {
    const model = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1", model: "fake-small" }),
      ev("tool.started", {
        turnId: "t1",
        toolCallId: "c1",
        tool: "terminal",
        input: { command: "gh pr create --fill" },
      }),
      ev("tool.completed", {
        turnId: "t1",
        toolCallId: "c1",
        output: "https://github.com/acme/widgets/pull/91",
      }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    const done = mergeThreadEntries([], model, OPTS);
    const entry = done.at(-1);
    if (entry?.kind !== "agent") throw new Error("expected agent entry");
    // PRS[0] is #96 (open first); the step created #91 — the card shows #91.
    expect(entry.pr).toEqual(PRS[1]);
  });

  it("no `gh pr create` step or a still-live turn: no card", () => {
    const noPr = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t1" }),
      ev("tool.started", {
        turnId: "t1",
        toolCallId: "c1",
        tool: "terminal",
        input: { command: "bun test" },
      }),
      ev("turn.completed", { turnId: "t1", stopReason: "end_turn" }),
    ]);
    const done = mergeThreadEntries([], noPr, OPTS);
    const doneEntry = done.at(-1);
    if (doneEntry?.kind !== "agent") throw new Error("expected agent entry");
    expect(doneEntry.pr).toBeUndefined();

    const liveModel = reduceSessionEvents("sess-1", [
      ev("turn.started", { turnId: "t2" }),
      ev("tool.started", {
        turnId: "t2",
        toolCallId: "c2",
        tool: "terminal",
        input: { command: "gh pr create --fill" },
      }),
    ]);
    const live = mergeThreadEntries([], liveModel, OPTS);
    const liveEntry = live.at(-1);
    if (liveEntry?.kind !== "agent") throw new Error("expected agent entry");
    expect(liveEntry.pr).toBeUndefined();
  });
});
