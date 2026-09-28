import { draftKey, dropDrafts } from "@lilos/ui";
import { relay } from "./runtime";

/* Issue #103 AC-6 — prune stored composer drafts when their owner goes away.
   onEvent fires before the client's own dispatch, so `channel.removed` still
   sees the channel and its conversations in the atoms. */
export function watchDraftPruning(): void {
  relay.onEvent((method, params) => {
    if (method === "channel.removed") {
      const { channelId } = params as { channelId?: string };
      if (!channelId) return;
      const channel = relay.channels.get().find((c) => c.id === channelId);
      const convKeys = relay.conversations
        .get()
        .filter((c) => c.channelId === channelId)
        .map((c) => draftKey.thread(c.id));
      dropDrafts([
        ...convKeys,
        ...(channel?.employeeId ? [draftKey.dm(channel.employeeId)] : []),
      ]);
      return;
    }
    if (method === "employee.removed") {
      const { employeeId } = params as { employeeId?: string };
      if (employeeId) dropDrafts([draftKey.dm(employeeId)]);
      return;
    }
    if (method === "conversation.updated") {
      const { conversation } = params as {
        conversation?: { id?: string; archived?: boolean };
      };
      if (conversation?.id && conversation.archived) {
        dropDrafts([draftKey.thread(conversation.id)]);
      }
    }
  });
}
