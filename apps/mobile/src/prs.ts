import type { AppClient } from "@lilos/client-runtime";
import type { Conversation, EngineEventEvent } from "@lilos/contracts/app";
import type { ForgePrListItem } from "@lilos/contracts/host";
import type { PullRequestRef } from "@lilos/ui-native";
import { atom } from "nanostores";

/* A thread's pull requests (#159): fetched per conversation through
   `conversations.prs` (relay -> harness `forge.prs` -> `gh pr list`),
   keyed by conversationId. Refreshes only on a surface opening and on
   `turn.completed` — no idle polling (AC-5). */

export const $prs = atom<Record<string, PullRequestRef[]>>({});

/** gh list row -> the badge view model: a draft is its own status (gray,
   not green "open"), and a PR with no checks shows no CI dot. */
export function toPullRequestRef(item: ForgePrListItem): PullRequestRef {
  return {
    number: item.number,
    title: item.title,
    // A closed/merged draft is still closed/merged — draft only wins over open.
    status: item.state === "open" && item.draft ? "draft" : item.state,
    ...(item.checks !== "none" ? { checks: item.checks } : {}),
  };
}

const inFlight = new WeakMap<AppClient, Set<string>>();

/** One `conversations.prs` call -> the atom. Failures — no host, not a
   repo, `gh` missing or signed out — are the AC-4 "nothing shown" path:
   they never clobber a list that already landed. */
export async function refreshConversationPrs(
  client: AppClient,
  conversationId: string,
): Promise<void> {
  let flights = inFlight.get(client);
  if (!flights) {
    flights = new Set();
    inFlight.set(client, flights);
  }
  if (flights.has(conversationId)) return; // one fetch per conversation at a time
  flights.add(conversationId);
  try {
    const res = await client.request<{ prs: ForgePrListItem[] }>(
      "conversations.prs",
      { conversationId },
    );
    $prs.set({
      ...$prs.get(),
      [conversationId]: res.prs.map(toPullRequestRef),
    });
  } catch {
    // AC-4: render nothing, keep whatever was already known.
  } finally {
    flights.delete(conversationId);
  }
}

/** Refresh each conversation's PRs (a DM list opening). Bounded by the
   thread count the employee has; in-flight calls dedupe themselves. */
export function refreshPrsFor(
  client: AppClient,
  conversations: readonly Conversation[],
): void {
  for (const c of conversations) void refreshConversationPrs(client, c.id);
}

const watched = new WeakSet<AppClient>();

/** Event-driven refresh (AC-5): a finished turn re-lists its
   conversation's PRs — that is when a PR the agent opened (or GitHub
   merged) lands on the row without a reload. Runs once per client; no
   timer anywhere. */
export function watchPrs(client: AppClient): void {
  if (watched.has(client)) return;
  watched.add(client);
  client.onEvent((method, params) => {
    if (method !== "engine.event") return;
    const p = params as EngineEventEvent | undefined;
    if (p?.event.type !== "turn.completed") return;
    void refreshConversationPrs(client, p.conversationId);
  });
}

/** Clear every PR the last client knew (demo exit / re-pair). */
export function resetPrs(): void {
  $prs.set({});
}
