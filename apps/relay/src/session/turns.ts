import { TurnsInterruptParams } from "@lilos/contracts/app";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/**
 * Moved verbatim out of `../session.ts`'s handle() (#441) — case
 * bodies are byte-identical modulo re-indentation. Returns `false`
 * when `method` belongs to another namespace; `undefined` once handled.
 */
export async function handleTurns(c: RelayCtx): Promise<false | undefined> {
  const { method, peer, id, params, store, emit, respond } = c;
  switch (method) {
    case "turns.interrupt": {
      const parsed = TurnsInterruptParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const conversation = await store.getConversation(
        parsed.data.conversationId,
      );
      if (!conversation) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "conversation not found",
        );
      }
      /* #403: stamp the channel seq this interrupt logically follows —
         every send committed at or below it predates the Stop. Sends
         and bus events travel different paths to the host, so without
         the stamp a pre-Stop send whose row is still in transit can
         prompt a fresh turn after the drain. */
      const channel = await store.getChannel(conversation.channelId);
      emit(conversation.channelId, "turn.interruptRequested", {
        channelId: conversation.channelId,
        conversationId: conversation.id,
        afterSeq: channel?.lastSeq ?? 0,
      });
      respond(peer, id, { ok: true });
      return;
    }
    default:
      return false;
  }
}
