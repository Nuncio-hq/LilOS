import {
  AttachmentsGetParams,
  MessagesClaimParams,
  MessagesDropParams,
  MessagesListParams,
  MessagesPostParams,
  MessagesRemoveParams,
  MessagesSearchParams,
  MessagesSendParams,
  MessagesSetCheckpointParams,
} from "@lilos/contracts/app";
import { noFolderDedupeKey } from "../store";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/**
 * Moved verbatim out of `../session.ts`'s handle() (#441) — case
 * bodies are byte-identical modulo re-indentation. Returns `false`
 * when `method` belongs to another namespace; `undefined` once handled.
 */
export async function handleMessages(c: RelayCtx): Promise<false | undefined> {
  const {
    method,
    peer,
    id,
    params,
    store,
    attachmentStore,
    storeAttachments,
    dropAttachments,
    emitMessage,
    emitMessageChanged,
    isHost,
    requireHost,
    respond,
  } = c;
  switch (method) {
    case "messages.setCheckpoint": {
      const parsed = MessagesSetCheckpointParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      requireHost(peer);
      const message = await store.setMessageCheckpoint(
        parsed.data.messageId,
        parsed.data.checkpoint,
      );
      if (!message || message.channelId !== parsed.data.channelId) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "message not found",
        );
      }
      respond(peer, id, { message });
      return;
    }
    case "messages.list": {
      const parsed = MessagesListParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      try {
        const page = await store.listMessages(parsed.data.channelId, {
          conversationId: parsed.data.conversationId,
          afterSeq: parsed.data.afterSeq,
          limit: parsed.data.limit,
          includeRewound: parsed.data.includeRewound,
          includeDropped: parsed.data.includeDropped,
        });
        respond(peer, id, page);
      } catch {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "channel not found",
        );
      }
      return;
    }
    case "messages.post": {
      const parsed = MessagesPostParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      // Employee/system utterances are produced by the engine host only.
      if (parsed.data.authorKind !== "user" && !isHost(peer)) {
        throw new RpcError(
          JsonRpcCode.forbidden,
          "forbidden",
          "only the registered engine host may post non-user messages",
        );
      }
      const attachments = await storeAttachments(parsed.data.attachments);
      try {
        const { message, created } = await store.appendMessage({
          ...parsed.data,
          attachments,
        });
        // A dedupe hit is a no-op retry: answer with the stored message,
        // don't re-emit `message.created` to subscribers (the blobs
        // stored above for this retry are unreferenced — drop them).
        // The retired no-folder note is hidden from subscribers too.
        if (created && !noFolderDedupeKey(parsed.data.dedupeKey))
          emitMessage(message.channelId, message);
        else dropAttachments(attachments);
        respond(peer, id, { message });
      } catch (error) {
        dropAttachments(attachments);
        if (error instanceof RpcError) throw error;
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "channel or conversation not found",
        );
      }
      return;
    }
    /* #315 waiting-tray actions. All three broadcast `message.changed`
       so every subscribed surface (and the host's own queue) sees the
       flag flip — no `message.created`, the seq is unchanged. */
    case "messages.remove": {
      const parsed = MessagesRemoveParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const message = await store.getMessage(parsed.data.messageId);
      if (message?.authorKind !== "user") {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "message not found",
        );
      }
      if (message.removed) {
        respond(peer, id, { message });
        return;
      }
      const conversation = message.conversationId
        ? await store.getConversation(message.conversationId)
        : null;
      const deliveredSeq = conversation?.deliveredSeq ?? 0;
      /* Only a message the engine can't already have is removable: still
         past the delivered watermark, or parked in the not-sent tray. */
      if (!message.dropped && message.seq <= deliveredSeq) {
        throw new RpcError(
          JsonRpcCode.conflict,
          "conflict",
          "already delivered to the engine",
        );
      }
      const removed = await store.setMessageFlags(message.id, {
        removed: true,
        dropped: false,
        /* #403: a Remove beats the claim — clear it so the row can't
           resurface as "committed" if it is ever un-removed. */
        claimed: false,
      });
      emitMessageChanged(message.channelId, removed ?? message, [
        "removed",
        "dropped",
        "claimed",
      ]);
      respond(peer, id, { message: removed ?? message });
      return;
    }
    case "messages.drop": {
      const parsed = MessagesDropParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      /* The harness parks queued messages on Stop; a device never drops. */
      requireHost(peer);
      const message = await store.getMessage(parsed.data.messageId);
      if (message?.authorKind !== "user" || message.removed) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "message not found",
        );
      }
      if (message.dropped) {
        respond(peer, id, { message });
        return;
      }
      const dropped = await store.setMessageFlags(message.id, {
        dropped: true,
      });
      emitMessageChanged(message.channelId, dropped ?? message, ["dropped"]);
      respond(peer, id, { message: dropped ?? message });
      return;
    }
    case "messages.claim": {
      const parsed = MessagesClaimParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      /* Host-only (#377): the harness marks a send once its prompt
         commits to dispatch — the row leaves the waiting tray before
         `deliveredSeq` can cover it, so Remove is only ever offered
         on truly queued sends. `claimed: false` (#403) puts a send
         back when it comes to rest short of the wire (queued behind
         a turn, accepted as a pending steer, re-queued) so the tray
         owns it again. Idempotent in both directions. */
      requireHost(peer);
      const message = await store.getMessage(parsed.data.messageId);
      if (message?.authorKind !== "user" || message.removed) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "message not found",
        );
      }
      if (message.claimed === parsed.data.claimed) {
        respond(peer, id, { message });
        return;
      }
      const claimed = await store.setMessageFlags(message.id, {
        claimed: parsed.data.claimed,
      });
      emitMessageChanged(message.channelId, claimed ?? message, ["claimed"]);
      respond(peer, id, { message: claimed ?? message });
      return;
    }
    case "messages.send": {
      const parsed = MessagesSendParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const message = await store.getMessage(parsed.data.messageId);
      if (!message?.dropped || message.removed) {
        throw new RpcError(
          JsonRpcCode.conflict,
          "conflict",
          "message is not parked",
        );
      }
      /* Un-parking resets the row to a fresh send: `claimed` clears too
         (#403) — the row is waiting/removable again until the lane
         re-claims it. */
      const sent = await store.setMessageFlags(message.id, {
        dropped: false,
        claimed: false,
      });
      emitMessageChanged(message.channelId, sent ?? message, [
        "dropped",
        "claimed",
      ]);
      respond(peer, id, { message: sent ?? message });
      return;
    }
    case "messages.search": {
      const parsed = MessagesSearchParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      respond(peer, id, {
        hits: await store.searchMessages(parsed.data),
      });
      return;
    }
    case "attachments.get": {
      const parsed = AttachmentsGetParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const stored = await attachmentStore.get(parsed.data.id);
      if (!stored) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "attachment not found",
        );
      }
      respond(peer, id, stored);
      return;
    }
    default:
      return false;
  }
}
