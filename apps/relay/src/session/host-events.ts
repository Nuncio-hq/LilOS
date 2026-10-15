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
    emitConversation,
  } = c;
  switch (method) {
    case "session.events": {
      /* Engine-event replay scoped to one conversation (D-#157): the phone
         (device scope) replays the turn stream through the relay — the
         conversation's `engineRef` maps the call onto the host's
         `events.since`. No engine session bound yet = nothing to
         replay; the client treats `not_found` as an empty feed. Live
         frames arrive as `engine.event` below. Not: an engine socket on
         the phone, an `events.since` passthrough keyed by raw session id,
         or device access to raw host methods (same scoping as
         `folders.detail`, #156). */
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
      /* Host-only (D-#157): every engine event of a conversation-bound
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
        /* D-#300: the context meter's usage lives on the row, not the
           stream — persist each turn.completed's usage (+ contextWindow)
           so it survives replay failure entirely; `usage_session_id`/
           `usage_seq` fence stale replays (`store.recordTurnUsage`).
           Best-effort like the push fan-out: a persist hiccup must not
           drop the event's ack. Not: a meter rebuilt from replayed
           events only — a dead session took the meter with it. */
        const usage =
          parsed.data.event.type === "turn.completed" ||
          parsed.data.event.type === "session.compacted"
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
        /* #563: the "finished, not seen" stamp — a turn end bumps
           `finishedSeq` past every mark the relay has seen, so a thread
           the user never opened dots its card + the employee on every
           device. The store's (sessionId, eventSeq) fence drops replays
           the same way `usage` does. A cancelled turn doesn't stamp: the
           user stopped it themselves, so it was seen (the same exclusion
           push fan-out makes). Best-effort like the usage persist — a
           hiccup must not drop the event's ack. */
        const event = parsed.data.event;
        const finished =
          (event.type === "turn.completed" &&
            event.payload.stopReason !== "cancelled") ||
          (event.type === "session.state" && event.payload.state === "error");
        if (finished) {
          /* Snapshotted before the write: the compare below must see the
             pre-stamp value — stores that mutate in place would otherwise
             make "stamp landed" undetectable. */
          const before = conversation.finishedSeq;
          store
            .recordConversationFinish({
              conversationId: conversation.id,
              sessionId: parsed.data.sessionId,
              eventSeq: event.seq,
            })
            .then(() =>
              store.getConversation(conversation.id).then((stamped) => {
                /* Re-emit only when the stamp actually landed (the fence
                   may refuse a stale replay) — subscribers see the new
                   `finishedSeq` on the plain `conversation.updated` feed. */
                if (stamped && stamped.finishedSeq !== before)
                  emitConversation(conversation.channelId, stamped);
              }),
            )
            .catch((error) => log(`finish stamp failed: ${error}`));
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
      /* #543 AC-7: `file`/`diff`/`pr`/`url` targets need the session's
         folder — a folderless conversation (no cwd) accepts engine tabs
         only, and the error says which shape to send instead. */
      if (conversation.cwd == null && parsed.data.target.tab === undefined) {
        throw new RpcError(
          JsonRpcCode.conflict,
          "conflict",
          "this session has no folder — `file`, `diff`, `pr` and `url` targets need one; open an engine tab instead: {tab:'subagents'|'background'|'plan'}",
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
