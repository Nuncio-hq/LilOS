import type { ConversationPatch } from "../store";
import type { RelaySharedCtx } from "./ctx";

/**
 * D-#862: a snoozed thread wakes early — a new ask, a failed turn, or
 * Oscar's own message. The whole wake is clearing `snoozedUntil` and
 * announcing the row on `conversation.updated`; every list's Snoozed
 * filter reads the stamp, so there is nothing else to flip. A call on an
 * awake or settled thread is a no-op — cheap to fire from every trigger.
 */
export async function wakeSnoozed(
  c: RelaySharedCtx,
  conversationId: string | null | undefined,
): Promise<void> {
  if (!conversationId) return;
  const conversation = await c.store.getConversation(conversationId);
  if (!conversation?.snoozedUntil) return;
  const woken = await c.store.updateConversation(conversationId, {
    snoozedUntil: null,
  });
  if (woken) c.emitConversation(woken.channelId, woken);
}

/**
 * D-#862: Oscar typing into a parked thread is resuming it (the issue's
 * "only Oscar's own messages count as resuming"). Snoozed → wakes now;
 * settled → back on the live list — and practically, his send could
 * never reach the engine while `archived` still filters the thread out
 * of `listPendingTurns`. Employee/system lines never resume the shelf.
 */
export async function resumeParked(
  c: RelaySharedCtx,
  conversationId: string | null | undefined,
): Promise<void> {
  if (!conversationId) return;
  const conversation = await c.store.getConversation(conversationId);
  if (!conversation) return;
  const patch: ConversationPatch = {};
  if (conversation.snoozedUntil) patch.snoozedUntil = null;
  if (conversation.settledAt !== undefined) patch.settledAt = null;
  if (!Object.keys(patch).length) return;
  const resumed = await c.store.updateConversation(conversationId, patch);
  if (resumed) c.emitConversation(resumed.channelId, resumed);
}
