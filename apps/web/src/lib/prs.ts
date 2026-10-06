import type { ForgePrListItem } from "@lilos/contracts/host";
import type { PullRequest } from "@lilos/ui/types";
import { atom } from "nanostores";
import { relay } from "./runtime";

/* A thread's pull requests (#579 AC-1): fetched per conversation through
   `conversations.prs` (relay -> harness `forge.prs` -> `gh pr list`),
   keyed by conversationId — the same seam apps/mobile/src/prs.ts fills
   `PullRequestRef` from. Refreshes only on a conversation opening and on
   `turn.completed` — no idle polling. */

export const $prs = atom<Record<string, PullRequest[]>>({});

/** gh list row -> the thread's `pr` view model: a draft is its own state
   (gray, not green "open"), and the checks rollup becomes one synthetic
   CheckRun so `prPending` reads it like a detail read. */
export function toPullRequest(item: ForgePrListItem): PullRequest {
  return {
    number: item.number,
    repo: item.repo,
    title: item.title,
    body: "",
    status: item.state,
    url: item.url,
    ...(item.state === "open" && item.draft ? { draft: true } : {}),
    author: "",
    base: item.base,
    head: item.head,
    opened: item.openedAt,
    checks:
      item.checks === "none"
        ? []
        : [
            {
              name: "checks",
              status:
                item.checks === "pending"
                  ? "pending"
                  : item.checks === "passing"
                    ? "passed"
                    : "failed",
            },
          ],
    comments: [],
  };
}

const inFlight = new Set<string>();

/** One `conversations.prs` call -> the atom. Failures — no host, not a
   repo, `gh` missing or signed out — are the "nothing shown" path: they
   never clobber a list that already landed. */
export async function refreshConversationPrs(
  conversationId: string,
): Promise<void> {
  if (inFlight.has(conversationId)) return; // one fetch per conversation
  inFlight.add(conversationId);
  try {
    const res = await relay.request<{ prs: ForgePrListItem[] }>(
      "conversations.prs",
      { conversationId },
    );
    $prs.set({
      ...$prs.get(),
      [conversationId]: res.prs.map(toPullRequest),
    });
  } catch {
    // render nothing, keep whatever was already known.
  } finally {
    inFlight.delete(conversationId);
  }
}

let watched = false;

/** Event-driven refresh: a finished turn re-lists its conversation's PRs —
   that is when a PR the agent opened (or GitHub merged) lands on the
   header chip without a reload. Runs once per app; no timer anywhere. */
export function watchPrs(): void {
  if (watched) return;
  watched = true;
  relay.onEvent((method, params) => {
    if (method !== "engine.event") return;
    const p = params as
      | { conversationId?: string; event?: { type?: string } }
      | undefined;
    if (p?.event?.type !== "turn.completed" || !p.conversationId) return;
    void refreshConversationPrs(p.conversationId);
  });
}
