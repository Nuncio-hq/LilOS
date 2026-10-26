import type { Conversation } from "@lilos/contracts/app";
import type { ForgePrsResult } from "@lilos/contracts/host";
import type { RelaySharedCtx } from "./session/ctx";

/**
 * D-#862 auto-settle (T3 Code's sidebar rules, docs/user/thread-sidebar.md):
 * no message for three days parks the thread (reason `idle`); a merged PR
 * settles its thread at once, a closed PR settles only an idle thread
 * (reason `pr`). Never settles a running turn, a thread stuck mid-turn or
 * waiting on an open ask, a parent whose D-#844 helpers still owe a wake,
 * the standing CEO thread, or a thread whose auto-settle is off. Only
 * the user's own messages count as resuming: a user row newer than the PR's
 * terminal stamp blocks the PR path (agent activity never does).
 *
 * `state === "active"` is the stored running flag — the relay's proxy for
 * a turn in flight; a settled helper child keeps its own row invisible
 * (D-#847) either way, so children sweep like any thread. `bgJobs` does
 * not block: a dev server left running is not work the agent waits on
 * (the issue's own carve-out), and nothing resumes from a job exit.
 */

/** The idle fence — three days without a message. Exported for tests. */
export const AUTO_SETTLE_IDLE_MS = 3 * 24 * 60 * 60 * 1000;

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
      .map((t) => t.task!.parentConversationId),
  );
  const settle = async (
    conversation: Conversation,
    reason: "idle" | "pr",
    settledPr?: { num: number; state: "merged" | "closed" },
  ) => {
    const settled = await c.store.updateConversation(conversation.id, {
      settledAt: now,
      settledReason: reason,
      ...(settledPr ? { settledPr } : {}),
    });
    if (settled) c.emitConversation(settled.channelId, settled);
  };
  for (const { conversation, last } of summaries) {
    if (conversation.autoSettle === false) continue;
    if (conversation.ceoThread) continue;
    if (conversation.state === "active") continue;
    if (conversation.stuck) continue;
    if (needsYou.has(conversation.id)) continue;
    if (waitingOnHelpers.has(conversation.id)) continue;
    /* An empty thread's inactivity counts from when it was created (the
       issue's rule); `last` is the summary's newest message, always set. */
    const idle =
      now - Math.max(last.createdAt, conversation.createdAt) >=
      AUTO_SETTLE_IDLE_MS;
    let prSettle: { num: number; state: "merged" | "closed" } | undefined;
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
        const pr = result?.prs.find(
          (p) =>
            p.head === branch && (p.state === "merged" || p.state === "closed"),
        );
        if (pr) {
          const terminal = Date.parse(pr.mergedAt ?? pr.closedAt ?? "");
          const resumedAt = await c.store.lastUserMessageAt(conversation.id);
          /* Resumed after the close: only a user message newer than the
             terminal stamp rescues it — a finished background turn does
             not (T3's resume rule). A pre-#862 host that sends no stamp
             can't prove a resume, so the guard can't fire. */
          const resumed =
            !Number.isNaN(terminal) &&
            resumedAt !== undefined &&
            resumedAt > terminal;
          if (
            !resumed &&
            (pr.state === "merged" || (pr.state === "closed" && idle))
          ) {
            prSettle = { num: pr.number, state: pr.state };
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
