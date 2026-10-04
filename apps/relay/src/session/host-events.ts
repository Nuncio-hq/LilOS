import {
  EngineEventParams,
  SessionEventsParams,
  WorkbenchOpenParams,
} from "@lilos/contracts/app";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/**
 * Moved verbatim out of `../session.ts`'s handle() (#441) — case
 * bodies are byte-identical modulo re-indentation. Returns `false`
 * when `method` belongs to another namespace; `undefined` once handled.
 */
export async function handleHostEvents(
  c: RelayCtx,
): Promise<false | undefined> {
  const {
    method,
    peer,
    id,
    params,
    options,
    store,
    log,
    emit,
    requireHost,
    forwardToHost,
    respond,
  } = c;
  switch (method) {
    case "session.events": {
      /* Engine-event replay scoped to one conversation (#157): the phone
         (device scope) replays the turn stream through the relay — the
         conversation's `engineRef` maps the call onto the host's
         `events.since`. No engine session bound yet = nothing to
         replay; the client treats `not_found` as an empty feed. */
      const parsed = SessionEventsParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const conversation = await store.getConversation(
        parsed.data.conversationId,
      );
      if (!conversation?.engineRef) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "no engine session bound to this conversation",
        );
      }
      forwardToHost(peer, id, "events.since", {
        sessionId: conversation.engineRef,
        after: parsed.data.after,
      });
      return;
    }
    case "engine.event": {
      /* Host-only (#157): every engine event of a conversation-bound
         session is re-published here so channel subscribers — the
         phone — see the live turn. Unknown conversations drop silently:
         a push can land before its `conversation.updated` bind did. */
      requireHost(peer);
      const parsed = EngineEventParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const conversation = await store.getConversation(
        parsed.data.conversationId,
      );
      if (conversation) {
        const { host } = c;
        emit(
          conversation.channelId,
          "engine.event",
          {
            channelId: conversation.channelId,
            conversationId: conversation.id,
            sessionId: parsed.data.sessionId,
            event: parsed.data.event,
          },
          // The host pushed it — no need to send its own stream back.
          host?.peer,
        );
        /* #300: the context meter's usage lives on the row, not the
           stream — persist each turn.completed's usage so it survives
           replay failure entirely. Best-effort like the push fan-out:
           a persist hiccup must not drop the event's ack. */
        const usage =
          parsed.data.event.type === "turn.completed"
            ? parsed.data.event.payload.usage
            : undefined;
        if (usage) {
          store
            .recordTurnUsage({
              conversationId: conversation.id,
              sessionId: parsed.data.sessionId,
              seq: parsed.data.event.seq,
              usage,
            })
            .catch((error) => log(`usage persist failed: ${error}`));
        }
        /* #161: turn.completed / session.state-error transitions push;
           the fan-out's seq watermark drops replays. */
        options.push
          ?.engineEvent(conversation, parsed.data.sessionId, parsed.data.event)
          .catch((error) => log(`push fan-out failed: ${error}`));
      }
      respond(peer, id, { ok: true });
      return;
    }
    /* ---------------- workbench open (#340) ---------------- */
    case "workbench.open": {
      /* The agent's `workbench_open` tool: show the user a file/diff/PR/
         url inside the app's Workbench. Host-only (the agent's voice),
         fan-out as a channel event — never a synthesized EngineEvent,
         whose seq would poison `events.since` replay + push watermarks. */
      requireHost(peer);
      const parsed = WorkbenchOpenParams.safeParse(params);
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
      const { host } = c;
      emit(
        conversation.channelId,
        "workbench.opened",
        {
          channelId: conversation.channelId,
          conversationId: conversation.id,
          target: parsed.data.target,
        },
        host?.peer,
      );
      respond(peer, id, { ok: true });
      return;
    }
    default:
      return false;
  }
}
