/* D-#862 auto-settle sweep: three idle days parks a thread (reason
   `idle`); a merged PR settles at once, a closed PR only an idle thread
   (reason `pr`). Never settles a running turn, a stuck or needs-you
   thread, a parent waiting on D-#844 helpers, the CEO thread, or a
   thread with auto-settle off — and only Oscar's own message after the
   PR's terminal stamp rescues it from the PR path. Runs against the
   memory store; the PR probe is a stubbed `callHost`. engine-fake only. */
import type { Conversation } from "@lilos/contracts/app";
import type { ForgePrListItem } from "@lilos/contracts/host";
import { describe, expect, it } from "vitest";
import type { RelaySharedCtx } from "../src/session/ctx";
import { AUTO_SETTLE_IDLE_MS, autoSettleSweep } from "../src/sweep";
import { createMemoryStore, type RelayStore } from "./memory-store";

const NOW = 10_000_000_000; // fixed clock — arbitrary epoch ms
const DAY = 24 * 60 * 60 * 1000;

interface SweepRig {
  store: RelayStore;
  emitted: Conversation[];
  logs: string[];
  /** Set the PR rows the stub `callHost` answers `forge.prs` with. */
  prs: (rows: ForgePrListItem[]) => void;
  /** Drop the host — the sweep then skips the forge probe entirely. */
  noHost: () => void;
  ctx: () => RelaySharedCtx;
}

const newRig = (): SweepRig => {
  const store = createMemoryStore();
  const emitted: Conversation[] = [];
  const logs: string[] = [];
  let rows: ForgePrListItem[] = [];
  let host: object | null = { peer: true };
  return {
    store,
    emitted,
    logs,
    prs: (next) => {
      rows = next;
    },
    noHost: () => {
      host = null;
    },
    ctx: () =>
      ({
        store,
        now: () => NOW,
        host,
        callHost: async () => ({
          root: "/repo",
          branches: rows.map((r) => r.head),
          prs: rows,
        }),
        emitConversation: (_channelId: string, conv: unknown) =>
          emitted.push(conv as Conversation),
        log: (message: string) => logs.push(message),
      }) as unknown as RelaySharedCtx,
  };
};

/** A forge.prs row — the fields the sweep never reads get defaults. */
const prRow = (
  num: number,
  head: string,
  state: "open" | "merged" | "closed",
  extra: { mergedAt?: number; closedAt?: number } = {},
) => ({
  number: num,
  url: `https://github.com/acme/repo/pull/${num}`,
  repo: "acme/repo",
  title: head,
  state,
  draft: false,
  head,
  base: "main",
  openedAt: new Date(NOW - 5 * DAY).toISOString(),
  ...(extra.mergedAt
    ? { mergedAt: new Date(extra.mergedAt).toISOString() }
    : {}),
  ...(extra.closedAt
    ? { closedAt: new Date(extra.closedAt).toISOString() }
    : {}),
  checks: "none" as const,
});

/** A thread in the rig's channel; `ageDays` backdates its stamps. */
const thread = async (
  rig: SweepRig,
  opts: {
    ageDays?: number;
    workspace?: { repoPath: string; branch: string };
    userMsgAgeDays?: number;
    empMsgAgeDays?: number;
  } = {},
): Promise<Conversation> => {
  const employee = await rig.store.createEmployee({
    name: `Ada-${Math.random()}`,
    role: "eng",
    status: "online",
    profile: "default",
    model: "",
    now: "",
    instructions: "",
    respondTo: "me",
  });
  const { channel } = await rig.store.openDmChannel(employee.id);
  const { conversation } = await rig.store.openConversation({
    channelId: channel.id,
    text: "do the thing",
    title: "do the thing",
    authorId: "user",
    ...(opts.workspace
      ? {
          workspace: {
            mode: "existing" as const,
            repoPath: opts.workspace.repoPath,
            branch: opts.workspace.branch,
          },
        }
      : {}),
  });
  /* Backdate by mutating the live store objects (the memory store hands
     out references): the row's created_at and every message's stamp. */
  const msgs = await rig.store.listMessages(channel.id, {
    conversationId: conversation.id,
  });
  const at = NOW - (opts.ageDays ?? 0) * DAY;
  for (const m of msgs.messages) m.createdAt = at;
  const live = (await rig.store.getConversation(conversation.id))!;
  live.createdAt = at;
  const stampLast = async (ageDays: number) => {
    const after = await rig.store.listMessages(channel.id, {
      conversationId: conversation.id,
    });
    after.messages.at(-1)!.createdAt = NOW - ageDays * DAY;
  };
  if (opts.userMsgAgeDays !== undefined) {
    await rig.store.appendMessage({
      channelId: channel.id,
      conversationId: conversation.id,
      authorId: "user",
      authorKind: "user",
      text: "oscar again",
    });
    await stampLast(opts.userMsgAgeDays);
  }
  /* Recent agent activity — a thread still finishing work is not idle,
     but it is also not "resumed" (only Oscar's rows count). */
  if (opts.empMsgAgeDays !== undefined) {
    await rig.store.appendMessage({
      channelId: channel.id,
      conversationId: conversation.id,
      authorId: employee.id,
      authorKind: "employee",
      text: "still wrapping up",
    });
    await stampLast(opts.empMsgAgeDays);
  }
  return live;
};

describe("D-#862 auto-settle sweep", () => {
  it("settles a 3-day-idle thread (reason idle) and announces it", async () => {
    const rig = newRig();
    const conv = await thread(rig, { ageDays: 4 });
    await autoSettleSweep(rig.ctx());
    const settled = await rig.store.getConversation(conv.id);
    expect(settled?.settledAt).toBe(NOW);
    expect(settled?.settledReason).toBe("idle");
    expect(settled?.archived).toBe(true);
    expect(rig.emitted.map((c) => c.id)).toContain(conv.id);
  });

  it("leaves fresh, running, needs-you, stuck, helper-waiting, ceo and opted-out threads", async () => {
    const rig = newRig();
    const fresh = await thread(rig, { ageDays: 0 });
    const running = await thread(rig, { ageDays: 4 });
    await rig.store.updateConversation(running.id, { state: "active" });
    const stuck = await thread(rig, { ageDays: 4 });
    await rig.store.updateConversation(stuck.id, {
      stuck: { reason: "same search" },
    });
    const needsYou = await thread(rig, { ageDays: 4 });
    await rig.store.createAsk({
      channelId: needsYou.channelId,
      conversationId: needsYou.id,
      turnId: "turn-1",
      requestId: "req-1",
      request: { kind: "question", question: "?" },
    });
    const waiting = await thread(rig, { ageDays: 4 });
    const project = await rig.store.ensureProject({ folder: "/repo" });
    const ticket = await rig.store.createTicket({
      projectId: project.project.id,
      projectKey: project.project.key,
      title: "helper task",
    });
    const liveTicket = (await rig.store.getTicket(ticket.id))!;
    liveTicket.task = {
      parentConversationId: waiting.id,
      childConversationId: "conv_child",
      childChannelId: "ch_child",
    };
    const ceo = await thread(rig, { ageDays: 4 });
    (await rig.store.getConversation(ceo.id))!.ceoThread = true;
    const optedOut = await thread(rig, { ageDays: 4 });
    await rig.store.updateConversation(optedOut.id, { autoSettle: false });

    await autoSettleSweep(rig.ctx());
    for (const conv of [
      fresh,
      running,
      stuck,
      needsYou,
      waiting,
      ceo,
      optedOut,
    ]) {
      const after = await rig.store.getConversation(conv.id);
      expect(after?.settledAt, `${conv.id} should stay live`).toBeUndefined();
    }
    expect(rig.emitted).toHaveLength(0);
  });

  it("a merged PR settles its thread at once — even one that is not idle", async () => {
    const rig = newRig();
    /* Agent still finishing up (recent employee row) — not idle, but
       Oscar never wrote since the merge, so the PR path settles it. */
    const conv = await thread(rig, {
      ageDays: 4,
      workspace: { repoPath: "/repo", branch: "feat/x" },
      empMsgAgeDays: 0,
    });
    rig.prs([prRow(42, "feat/x", "merged", { mergedAt: NOW - DAY })]);
    await autoSettleSweep(rig.ctx());
    const settled = await rig.store.getConversation(conv.id);
    expect(settled?.settledReason).toBe("pr");
    expect(settled?.settledPr).toEqual({ num: 42, state: "merged" });
  });

  it("a closed PR settles only an idle thread; an open PR never does", async () => {
    const rig = newRig();
    const idleConv = await thread(rig, {
      ageDays: 4,
      workspace: { repoPath: "/repo", branch: "feat/old" },
    });
    const busyConv = await thread(rig, {
      ageDays: 0,
      workspace: { repoPath: "/repo", branch: "feat/new" },
    });
    /* The stub answers every probe with the union of both branches' rows —
       the sweep's own `p.head === branch` filter picks each thread's PR. */
    rig.prs([
      prRow(7, "feat/old", "closed", { closedAt: NOW - 2 * DAY }),
      prRow(9, "feat/new", "open"),
    ]);
    await autoSettleSweep(rig.ctx());
    const idle = await rig.store.getConversation(idleConv.id);
    expect(idle?.settledReason).toBe("pr");
    expect(idle?.settledPr).toEqual({ num: 7, state: "closed" });
    expect(
      (await rig.store.getConversation(busyConv.id))?.settledAt,
    ).toBeUndefined();
  });

  it("Oscar's message after the PR's terminal stamp rescues the thread", async () => {
    const rig = newRig();
    /* Idle before the merge, but Oscar posted AFTER it — resumed. */
    const conv = await thread(rig, {
      ageDays: 4,
      workspace: { repoPath: "/repo", branch: "feat/x" },
      userMsgAgeDays: 1,
    });
    rig.prs([prRow(42, "feat/x", "merged", { mergedAt: NOW - 2 * DAY })]);
    await autoSettleSweep(rig.ctx());
    /* Resumed: the PR path is blocked, and his 1-day-old message means
       the thread isn't idle either — it stays live. */
    const after = await rig.store.getConversation(conv.id);
    expect(after?.settledAt).toBeUndefined();
  });

  it("an employee message after the merge does NOT count as resuming", async () => {
    const rig = newRig();
    const conv = await thread(rig, {
      ageDays: 4,
      workspace: { repoPath: "/repo", branch: "feat/x" },
    });
    /* A fresh agent reply after the merge — not Oscar. */
    await rig.store.appendMessage({
      channelId: conv.channelId,
      conversationId: conv.id,
      authorId: "emp",
      authorKind: "employee",
      text: "done",
    });
    rig.prs([prRow(42, "feat/x", "merged", { mergedAt: NOW - 2 * DAY })]);
    await autoSettleSweep(rig.ctx());
    expect((await rig.store.getConversation(conv.id))?.settledReason).toBe(
      "pr",
    );
  });

  it("no host means no probe — the thread still sweeps by idle alone", async () => {
    const rig = newRig();
    const conv = await thread(rig, {
      ageDays: 4,
      workspace: { repoPath: "/repo", branch: "feat/x" },
    });
    rig.noHost();
    await autoSettleSweep(rig.ctx());
    expect((await rig.store.getConversation(conv.id))?.settledReason).toBe(
      "idle",
    );
  });
});
