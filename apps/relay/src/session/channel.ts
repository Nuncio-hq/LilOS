import {
  ChannelSubscribeParams,
  ChannelUnsubscribeParams,
} from "@lilos/contracts/app";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/**
 * Moved verbatim out of `../session.ts`'s handle() (#441) — case
 * bodies are byte-identical modulo re-indentation. Returns `false`
 * when `method` belongs to another namespace; `undefined` once handled.
 */
export async function handleChannel(c: RelayCtx): Promise<false | undefined> {
  const {
    method,
    peer,
    state,
    id,
    params,
    store,
    subscribers,
    maxReplay,
    snapshotLimit,
    respond,
  } = c;
  switch (method) {
    case "channel.subscribe": {
      const parsed = ChannelSubscribeParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const { channelId, afterSeq } = parsed.data;
      const channel = await store.getChannel(channelId);
      if (!channel) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "channel not found",
        );
      }
      // Register for live frames first so nothing lands between the read
      // below and the subscribe going live — seq dedupe absorbs the overlap.
      let peers = subscribers.get(channelId);
      if (!peers) {
        peers = new Set();
        subscribers.set(channelId, peers);
      }
      peers.add(peer);
      state.subscriptions.add(channelId);
      try {
        const gapTooLarge =
          afterSeq !== undefined &&
          (afterSeq > channel.lastSeq ||
            channel.lastSeq - afterSeq > maxReplay);
        if (afterSeq === undefined || gapTooLarge) {
          const page = await store.listMessages(channelId, {
            limit: snapshotLimit,
          });
          peer.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "channel.snapshot",
              params: {
                channelId,
                messages: page.messages,
                lastSeq: page.lastSeq,
              },
            }),
          );
        } else {
          const page = await store.listMessages(channelId, { afterSeq });
          for (const message of page.messages) {
            peer.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "message.created",
                params: { channelId, message },
              }),
            );
          }
        }
        // Asks carry no seq watermark: an ask that opened between the
        // client's seed read and this subscribe would otherwise be lost
        // for good (issue #148). Replay the channel's current set — live
        // ask events dedupe by id on the client, same as messages.
        for (const ask of await store.listAsks({ channelId })) {
          peer.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: ask.state === "resolved" ? "ask.resolved" : "ask.opened",
              params: { channelId, ask },
            }),
          );
        }
        peer.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "channel.synced",
            params: { channelId, lastSeq: channel.lastSeq },
          }),
        );
        respond(peer, id, { channel });
      } catch (error) {
        peers.delete(peer);
        state.subscriptions.delete(channelId);
        throw error;
      }
      return;
    }
    case "channel.unsubscribe": {
      const parsed = ChannelUnsubscribeParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const { channelId } = parsed.data;
      subscribers.get(channelId)?.delete(peer);
      state.subscriptions.delete(channelId);
      respond(peer, id, { channelId });
      return;
    }
    default:
      return false;
  }
}
