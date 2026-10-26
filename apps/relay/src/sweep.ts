import type { Conversation } from "@lilos/contracts/app";
import type { ForgePrsResult } from "@lilos/contracts/host";
import type { RelaySharedCtx } from "./session/ctx";

/**
 * D-#862 auto-settle (T3 Code's sidebar rules, docs/user/thread-sidebar.md):
 * no message for three days parks the thread (reason `idle`); a merged PR
 * settles its thread at once, a closed PR settles only an idle thread
 * (reason `pr`). Never settles a running turn, a thread stuck mid-turn or
 * waiting on an open ask, a parent whose D-#844 helpers still owe a wake,
 * the standing CEO thread, or a thread whose auto-settle is off.
 *
 * Review round 1: owner park actions are activity. `lastParkActionAt`
 * rides the idle clock, so a thread the owner just un-parked doesn't
 * bounce back, and an un-settle newer than the PR's terminal stamp
 * rescues it from the PR path — only a user message or an owner park
 * action can. Pinned rows never auto-settle (a pin means "keep this at
 * the top"; only a manual Settle removes it). A live snooze shields the
 * row — settling would clear `snoozedUntil` and the thread could never
 * return. Task children (D-#844) never auto-settle: nothing but a
 * host-posted follow-up could wake them, and the owner can't un-settle
 * a row he can't see.
 *
 * `state === "active"` is the stored running flag — the relay's proxy for
 * a turn in flight. `bgJobs` does not block: a dev server left running is
 * not work the agent waits on (the issue's own carve-out), and nothing
 * resumes from a job exit.
 */

/** The idle fence — three days without activity. Exported for tests. */
export const AUTO_SETTLE_IDLE_MS = 3 * 24 * 60 * 60 * 1000;

/* A candidate's conversation-row gates — checked twice: once on the
   tick's snapshot, then again on the fresh re-read inside `settle`
   (a probe can take seconds and the row may have moved). */
const settleable = (conv: Conversation, now: number): boolean =>
  conv.autoSettle !== false &&
  !conv.ceoThread &&
  conv.parentId === undefined &&
  conv.pinnedAt === undefined &&
  (conv.snoozedUntil === undefined || conv.snoozedUntil <= now) &&
  conv.state !== "active" &&
  !conv.stuck;

/* Idle = no message AND no owner park action for the window — an
   un-settle, a pin, or a snooze the owner just did counts as touching
   the thread. */
const idleFor = (
  conv: Conversation,
  lastMessageAt: number,
  now: number,
): boolean =>
  now - Math.max(lastMessageAt, conv.createdAt, conv.lastParkActionAt ?? 0) >=
  AUTO_SETTLE_IDLE_MS;

export async function autoSettleSweep(c: RelaySharedCtx): Promise<void> {
  const now = c.now();
  const [summaries, tickets, openAsks] = await Promise.all([
    c.store.listConversationSummaries({ includeArchived: false }),
    c.store.listTickets(),
    c.store.listAsks({ state: "open" }),
  ]);
  const needsYou = new Set(openAsks.map((a) => a.conversationId));
  /* A task ticket owes its parent a wake until a result (or a cancel)
     lands — the parent is waiting on helpers, not idle. */
  const waitingOnHelpers = new Set(
    tickets
      .filter((t) => t.task && !t.task.cancelledAt && !t.task.lastResult)
      .map((t) => t.task?.parentConversationId),
  );
  const settle = async (
    summary: Conversation,
    reason: "idle" | "pr",
    pr?: { num: number; state: "merged" | "closed"; terminal?: number },
  ) => {
    /* Re-read before writing — the tick's snapshot is minutes stale once
       earlier candidates sat inside slow forge.prs probes; a turn that
       started, a pin/snooze that landed, or a message that arrived
       mid-tick must win. */
    const conv = await c.store.getConversation(summary.id);
    if (!conv || conv.settledAt !== undefined || !settleable(conv, now)) return;
    const newest = (
      await c.store.listMessages(conv.channelId, {
        conversationId: conv.id,
        limit: 1,
      })
    ).messages.at(-1);
    if (reason === "idle" && !idleFor(conv, newest?.createdAt ?? 0, now))
      return;
    if (reason === "pr" && pr?.terminal !== undefined) {
      /* Re-check the rescue with fresh stamps — a user send or an owner
         park action mid-tick beats the terminal stamp too. */
      const resumedAt = Math.max(
        (await c.store.lastUserMessageAt(conv.id)) ?? 0,
        conv.lastParkActionAt ?? 0,
      );
      if (resumedAt > pr.terminal) return;
    }
    const settled = await c.store.updateConversation(conv.id, {
      settledAt: now,
      settledReason: reason,
      ...(pr ? { settledPr: { num: pr.num, state: pr.state } } : {}),
    });
    if (settled) c.emitConversation(settled.channelId, settled);
  };
  for (const { conversation, last } of summaries) {
    if (!settleable(conversation, now)) continue;
    if (needsYou.has(conversation.id)) continue;
    if (waitingOnHelpers.has(conversation.id)) continue;
    /* An empty thread's inactivity counts from when it was created (the
       issue's rule); `last` is the summary's newest message. */
    const idle = idleFor(conversation, last.createdAt, now);
    let prSettle:
      | { num: number; state: "merged" | "closed"; terminal?: number }
      | undefined;
    /* The PR link a thread already knows — its workstream branch; a
       just-chat thread has no link and skips the probe entirely (the
       issue's "no such link today" case). No host, no probe — a Mac
       with the harness down just tries again next tick. */
    const path = conversation.cwd ?? conversation.workspace?.repoPath;
    const branch = conversation.workspace?.branch;
    if (branch && path && c.host) {
      try {
        const result = (await c.callHost("forge.prs", {
          path,
          branches: [branch],
        })) as ForgePrsResult | null;
        const branchPrs = (result?.prs ?? []).filter((p) => p.head === branch);
        /* An open PR on the same branch means work is still going — a
           follow-up PR after a merge is the common case — so a terminal
           row only settles the thread when nothing open shadows it. */
        if (!branchPrs.some((p) => p.state === "open")) {
          const pr = branchPrs.find(
            (p) => p.state === "merged" || p.state === "closed",
          );
          if (pr) {
            const parsed = Date.parse(pr.mergedAt ?? pr.closedAt ?? "");
            const terminal = Number.isNaN(parsed) ? undefined : parsed;
            const resumedAt = Math.max(
              (await c.store.lastUserMessageAt(conversation.id)) ?? 0,
              conversation.lastParkActionAt ?? 0,
            );
            /* Resumed after the close: a user message or an owner park
               action newer than the terminal stamp rescues it — a
               finished background turn does not (T3's resume rule). A
               pre-#862 host that sends no stamp can't prove a resume,
               so the guard can't fire. */
            const resumed = terminal !== undefined && resumedAt > terminal;
            if (
              !resumed &&
              (pr.state === "merged" || (pr.state === "closed" && idle))
            ) {
              prSettle = { num: pr.number, state: pr.state, terminal };
            }
          }
        }
      } catch (error) {
        c.log(`auto-settle sweep: forge.prs ${conversation.id}: ${error}`);
      }
    }
    if (prSettle) await settle(conversation, "pr", prSettle);
    else if (idle) await settle(conversation, "idle");
  }
}

/**
 * The timer's handle: one tick in flight at a time. A tick can sit inside
 * a `forge.prs` probe for many seconds — a second interval firing on top
 * of it would re-decide on the same stale snapshot, so the next tick
 * yields until this one finishes.
 */
export function createAutoSettleSweep(c: RelaySharedCtx): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await autoSettleSweep(c);
    } finally {
      running = false;
    }
  };
}
