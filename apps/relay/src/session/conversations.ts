import {
  ConversationsListParams,
  type ConversationsMoveFolderHostParams,
  type ConversationsMoveFolderHostResult,
  ConversationsMoveFolderParams,
  ConversationsOpenParams,
  ConversationsPrsParams,
  type ConversationsRewindHostParams,
  type ConversationsRewindHostResult,
  ConversationsRewindParams,
  ConversationsSetAccessParams,
  ConversationsSetModelParams,
  ConversationsSummariesParams,
  ConversationsUpdateParams,
} from "@lilos/contracts/app";
import {
  ConversationAccess,
  type ConversationAccess as ConversationAccessT,
} from "@lilos/contracts/engine";
import type { ForgePrsResult } from "@lilos/contracts/host";
import type { ConversationPatch } from "../store";
import { noFolderDedupeKey } from "../store";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/**
 * Moved verbatim out of `../session.ts`'s handle() (#441) — case
 * bodies are byte-identical modulo re-indentation. Returns `false`
 * when `method` belongs to another namespace; `undefined` once handled.
 */
export async function handleConversations(
  c: RelayCtx,
): Promise<false | undefined> {
  const {
    method,
    peer,
    id,
    params,
    store,
    storeAttachments,
    dropAttachments,
    emit,
    emitMessage,
    emitConversation,
    isHost,
    callHost,
    respond,
  } = c;
  switch (method) {
    case "conversations.list": {
      const parsed = ConversationsListParams.safeParse(params ?? {});
      if (!parsed.success) throw badParams(parsed.error.issues);
      respond(peer, id, {
        conversations: await store.listConversations({
          channelId: parsed.data.channelId,
          includeArchived: parsed.data.includeArchived,
        }),
      });
      return;
    }
    case "conversations.summaries": {
      const parsed = ConversationsSummariesParams.safeParse(params ?? {});
      if (!parsed.success) throw badParams(parsed.error.issues);
      respond(peer, id, {
        summaries: await store.listConversationSummaries({
          channelId: parsed.data.channelId,
          conversationId: parsed.data.conversationId,
          includeArchived: parsed.data.includeArchived,
        }),
      });
      return;
    }
    case "conversations.open": {
      const parsed = ConversationsOpenParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      if (!(await store.getChannel(parsed.data.channelId))) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "channel not found",
        );
      }
      const attachments = await storeAttachments(parsed.data.attachments);
      /* #106 AC-3: the pill's level lands on the row — an explicit
         `access` param wins; otherwise Settings' `defaultAccess`, else
         Ask. Stored values pass through the enum guard so a corrupt
         setting can't mint a third level. */
      const storedDefault = ConversationAccess.safeParse(
        await store.getSetting("defaultAccess"),
      );
      const access: ConversationAccessT =
        parsed.data.access ??
        (storedDefault.success ? storedDefault.data : "ask");
      try {
        const { conversation, rootMessage, created } =
          await store.openConversation({
            ...parsed.data,
            access,
            attachments,
            /* #137: a title given at open is user-chosen from a client,
               engine-owned ("auto") from the host; empty → placeholder. */
            titleSource: isHost(peer) ? "auto" : "user",
          });
        /* #552: a dedupe hit answers the stored thread and announces
           nothing again — the retry's attachment blobs are dropped
           unreferenced, like a deduped messages.post. Same for a retired
           no-folder key: stored but never emitted. */
        if (created && !noFolderDedupeKey(parsed.data.dedupeKey)) {
          emitMessage(conversation.channelId, rootMessage);
          emitConversation(conversation.channelId, conversation);
        } else {
          dropAttachments(attachments);
        }
        respond(peer, id, { conversation, rootMessage });
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
    case "conversations.update": {
      const parsed = ConversationsUpdateParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      // engineRef/state/model(+provider/effort/fast)/deliveredSeq/
      // turnFailure are owned by the engine host (the pick lands once
      // the engine acks `session.setModel`); title/archive are
      // user-facing fields any client may set. Key presence (`in`) is
      // the write intent — an explicit `null` clear follows the same
      // host-only rule as a value.
      const HOST_KEYS = [
        "engineRef",
        "state",
        "model",
        "provider",
        "effort",
        "fast",
        "deliveredSeq",
        "life",
        "turnFailure",
        "cwd",
        "turnStopped",
        "bgJobs",
      ] as const;
      if (HOST_KEYS.some((k) => k in parsed.data) && !isHost(peer)) {
        throw new RpcError(
          JsonRpcCode.forbidden,
          "forbidden",
          "only the registered engine host may write engineRef/state/model/provider/effort/fast/deliveredSeq/life/turnFailure/cwd/turnStopped/bgJobs",
        );
      }
      const { conversationId, ...rest } = parsed.data;
      /* #137 AC-2: title provenance is caller identity — a host write is
         the engine titling its session ("auto", guarded: never over a
         user name); any other client's title is a rename ("user"). */
      const patch: ConversationPatch = {
        ...rest,
        ...("title" in rest
          ? {
              titleSource: isHost(peer) ? ("auto" as const) : ("user" as const),
            }
          : {}),
      };
      const conversation = await store.updateConversation(
        conversationId,
        patch,
      );
      if (!conversation) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "conversation not found",
        );
      }
      emitConversation(conversation.channelId, conversation);
      respond(peer, id, { conversation });
      return;
    }
    case "conversations.rewind": {
      const parsed = ConversationsRewindParams.safeParse(params);
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
      const target = await store.getMessage(parsed.data.messageId);
      if (!target || target.conversationId !== conversation.id) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "message not found",
        );
      }
      // The rewind point is a user turn's own message — an employee or
      // system line has no folder checkpoint of its own to return to.
      if (target.authorKind !== "user" || target.rewound) {
        throw new RpcError(
          JsonRpcCode.conflict,
          "conflict",
          target.rewound
            ? "message is already rewound"
            : "only a user message can be a rewind point",
        );
      }
      /* toTurn for the engine = the visible user turns that stay. */
      const before = await store.listMessages(conversation.channelId, {
        conversationId: conversation.id,
      });
      const toTurn = before.messages.filter(
        (m) => m.authorKind === "user" && m.seq < target.seq,
      ).length;
      /* The engine host owns the restore + engine-side rewind; on its
         success the relay marks the tail and tells subscribers. */
      const hostParams: ConversationsRewindHostParams = {
        conversationId: conversation.id,
        engineRef: conversation.engineRef,
        messageId: target.id,
        checkpoint: target.checkpoint ?? null,
        cwd: conversation.cwd ?? null,
        fromSeq: target.seq,
        toTurn,
      };
      const hostResult = (await callHost(
        "conversations.rewind",
        hostParams,
        /* A folder restore can touch thousands of files — well past the
           generic host-call timeout. */
        120_000,
      )) as ConversationsRewindHostResult | null;
      const engineRewound = hostResult?.engineRewound === true;
      const filesRestored = hostResult?.filesRestored === true;
      const marked = await store.markRewound(conversation.id, target.seq);
      const removedIds = marked.map((m) => m.id);
      emit(conversation.channelId, "conversation.rewound", {
        channelId: conversation.channelId,
        conversationId: conversation.id,
        fromSeq: target.seq,
        messageId: target.id,
        engineRewound,
        removedIds,
      });
      /* The plain note (AC-3) is a relay-owned system message: written
         AFTER the mark so it survives, no host round-trip needed. It says
         exactly what happened — a message can predate checkpoints or
         carry a failed stamp, so "files restored" is only claimed when
         the host actually restored them. */
      const parts = [
        `Rewound to before your message — ${marked.length} message${marked.length === 1 ? "" : "s"} dropped`,
      ];
      if (filesRestored) parts.push("files restored to the earlier checkpoint");
      else
        parts.push(
          "no file checkpoint was stored for it — the folder kept its current state",
        );
      if (!engineRewound)
        parts.push(
          "this session's transport can't rewind the agent's memory — it still remembers the later messages",
        );
      const note = `${parts.join("; ").replace(/^./, (c) => c.toUpperCase())}.`;
      const { message: noteMessage } = await store.appendMessage({
        channelId: conversation.channelId,
        conversationId: conversation.id,
        authorId: "system",
        authorKind: "system",
        text: note,
      });
      emitMessage(conversation.channelId, noteMessage);
      respond(peer, id, {
        message: target,
        engineRewound,
        filesRestored,
        removedCount: marked.length,
        removedIds,
      });
      return;
    }
    case "conversations.moveFolder": {
      /* Move a thread's working folder (#581): the engine host owns the
         path boundary + the session re-home (session.moveWorkspace) and
         writes the landed `cwd` back through conversations.update — same
         callHost pattern as conversations.rewind. */
      const parsed = ConversationsMoveFolderParams.safeParse(params);
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
      const hostParams: ConversationsMoveFolderHostParams = {
        conversationId: conversation.id,
        engineRef: conversation.engineRef,
        path: parsed.data.path,
      };
      const hostResult = (await callHost(
        "conversations.moveFolder",
        hostParams,
        /* The engine re-home crosses a backend call — a touch wider
           than the generic timeout. */
        60_000,
      )) as ConversationsMoveFolderHostResult | null;
      /* The host's conversations.update {cwd} write re-emitted the row;
         re-read so the response carries the landed folder, not the
         caller's string. */
      const moved = await store.getConversation(conversation.id);
      if (!moved) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "conversation not found",
        );
      }
      /* A plain note (like rewind's): what the thread's folder is now and
         whether the running session followed — the user reads it as proof
         the move really happened, not just a label change. */
      const note = hostResult?.engineMoved
        ? `Moved this thread to \`${moved.cwd}\` — the running session moved too; same thread, same memory.`
        : `Moved this thread to \`${moved.cwd}\` — the next turn works there.`;
      const { message: noteMessage } = await store.appendMessage({
        channelId: conversation.channelId,
        conversationId: conversation.id,
        authorId: "system",
        authorKind: "system",
        text: note,
      });
      emitMessage(conversation.channelId, noteMessage);
      respond(peer, id, { conversation: moved });
      return;
    }
    case "conversations.setModel": {
      const parsed = ConversationsSetModelParams.safeParse(params);
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
      // The pick lands via the engine host (session.setModel ack → the
      // host writes conversation.model/provider/effort/fast), so the
      // relay only notifies — the whole pick rides the event (#92).
      emit(conversation.channelId, "conversation.modelRequested", {
        channelId: conversation.channelId,
        conversationId: conversation.id,
        model: parsed.data.model,
        ...(parsed.data.provider !== undefined
          ? { provider: parsed.data.provider }
          : {}),
        ...(parsed.data.effort !== undefined
          ? { effort: parsed.data.effort }
          : {}),
        ...(parsed.data.fast !== undefined ? { fast: parsed.data.fast } : {}),
      });
      respond(peer, id, { ok: true });
      return;
    }
    case "conversations.setAccess": {
      const parsed = ConversationsSetAccessParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      /* #106: the composer pill's switch is LilOS data — the row writes
         here and `conversation.updated` carries it; the host sees the
         next approval request route on the fresh value. */
      const conversation = await store.updateConversation(
        parsed.data.conversationId,
        { access: parsed.data.access },
      );
      if (!conversation) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "conversation not found",
        );
      }
      emitConversation(conversation.channelId, conversation);
      respond(peer, id, { conversation });
      return;
    }
    case "conversations.prs": {
      /* A thread's pull requests (#159): conversationId-scoped like
         `session.events` — the conversation's folder + branch(es)
         resolve here so a device peer can never name a host path it
         picked itself. A just-chat thread (no folder) answers an empty
         list without a host call; host failures (not a repo, `gh`
         missing/signed out) surface as errors the app treats as "no
         PRs" (AC-4). */
      const parsed = ConversationsPrsParams.safeParse(params);
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
      const path = conversation.cwd ?? conversation.workspace?.repoPath;
      if (!path) {
        respond(peer, id, { prs: [] });
        return;
      }
      const result = (await callHost("forge.prs", {
        path,
        ...(conversation.workspace?.branch
          ? { branches: [conversation.workspace.branch] }
          : {}),
      })) as ForgePrsResult | null;
      respond(peer, id, { prs: result?.prs ?? [] });
      return;
    }
    default:
      return false;
  }
}
