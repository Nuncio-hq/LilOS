import { shouldClearPending, threadStatus } from "@lilos/client-runtime";
import type { Conversation } from "@lilos/contracts/app";
import { draftKey, useDraft } from "@lilos/ui";
import type { Channel, Msg, Thread, Work } from "@lilos/ui/types";
import { useEffect, useState } from "react";
import {
  clearPending,
  describeActionError,
  hasCapability,
  interruptSession,
  pendingStart,
  setConversationAccess,
  setConversationModel,
  toastOnFail,
} from "../lib/actions";
import { ensureAttachments, toAttachedFiles } from "../lib/attachments";
import { loadDiscovered } from "../lib/folders";
import { useAtom } from "../lib/hooks";
import { hostOsOpen } from "../lib/host";
import { clock, sessionLabel, threadUsage, toUiEmployee } from "../lib/mapping";
import { osFullName, osHome, profile } from "../lib/me";
import {
  engine,
  relay,
  sessionSignals,
  workbenchRequests,
} from "../lib/runtime";
import { sayError } from "../lib/toast";
import { V3_STATUS } from "../v3/threads";
import { EMPTY_FEED, NO_ASKS } from "./empties";
import { fileSearch, sessionCommands } from "./searchers";
import {
  compactConversation,
  continueInNewSession,
  retryConversation,
  startFreshFrom,
} from "./thread-actions";
import type { ThreadData } from "./thread-data";
import {
  resolvedReceipts,
  rewindWarningFor,
  threadRoot,
  transcriptNoteFor,
} from "./thread-model";
import { threadSendHandlers } from "./thread-send";
import {
  buildUiJobs,
  removeMessage,
  sendQueuedMessage,
  stopBackgroundJob,
} from "./thread-tray";
import type { ConvFolds } from "./use-conv-folds";
import { useEmployeeLookup } from "./use-employee-lookup";
import { useEngineStatus } from "./use-engine-status";
import { useModelCatalog } from "./use-model-catalog";
import { useThreadAux } from "./use-thread-aux";
import { useThreadRewind } from "./use-thread-rewind";

/**
 * One conversation's whole per-thread computation: the fold, the header
 * model, the composer's draft/send, the trays, rewind, the pickers, the
 * Workbench's jobs/PR/editors. Pure derivation from the runtime atoms —
 * routing is the caller's: nothing here navigates.
 *
 * `folds` is the caller's fold pass (`useConvFolds`) so a surface that also
 * lists conversations (a thread list) folds each one once.
 */
export function useThreadWith(
  conv: Conversation | undefined,
  folds: ConvFolds,
): ThreadData | undefined {
  const employees = useAtom(relay.employees);
  const channels = useAtom(relay.channels);
  /* #118: the human's name/avatar re-render live on a settings change. */
  useAtom(profile);
  useAtom(osFullName);
  const home = useAtom(osHome);
  const pendingMap = useAtom(pendingStart);
  const engineState = useAtom(engine.state);
  /* #557: the socket dropped and the client is redialing — the composer
     shows the thin "Reconnecting…" line so a send made in the window reads
     as waiting, not lost. */
  const reconnecting = useAtom(relay.state) === "reconnecting";
  const signals = useAtom(sessionSignals);
  const wbSpots = useAtom(workbenchRequests);
  const { engineDown } = useEngineStatus();
  const { empFn, mentionables } = useEmployeeLookup(employees, engineDown);
  const { catalog, defaultModel, defaultProvider, picker } = useModelCatalog();

  const sid = conv?.engineRef ?? undefined;
  const feed = useAtom(sid ? engine.sessionFeed(sid) : EMPTY_FEED);
  const model = sid ? folds.models[sid] : undefined;
  const channel = channels.find((c) => c.id === conv?.channelId);
  const employee = employees.find((e) => e.id === channel?.employeeId);

  /* Unsent drafts live outside the composer: one key per conversation
     (issue #103). Switching sessions — or reloading — swaps in the stored
     text instead of throwing it away. */
  const [draft, setDraft] = useDraft(
    conv ? draftKey.thread(conv.id) : undefined,
  );
  const rewind = useThreadRewind(conv?.id, folds.pool, draft, setDraft);
  const aux = useThreadAux(conv, feed.synced, model);
  /* A summary root is the header fallback when the pool lacks the root. */
  const summaryRoot = conv ? folds.summaryOf(conv)?.root : undefined;
  useEffect(() => {
    ensureAttachments(summaryRoot?.attachments ?? []);
  }, [summaryRoot]);
  /* Which conversation's model picker `/model` opened — routed commands
     claim the send, they never reach the engine. */
  const [modelOpenFor, setModelOpenFor] = useState<string | null>(null);
  const [moveFolderFor, setMoveFolderFor] = useState<string | null>(null);

  /* "submitted" marker clears once the engine turn is actually running.
     #645: `shouldClearPending` is the observed-turn rule — clearing only on
     `live` latched the marker forever after a folded replay (composer stuck
     on "…is working. Enter steers this turn…"); clearing on a stale
     terminal turn would drop `running` in the send→`turn.started` gap and
     lift the #606 pick-hold early. */
  useEffect(() => {
    if (conv && shouldClearPending(model)) clearPending(conv.id);
  }, [conv, model]);

  if (!conv || !employee || !channel) return undefined;
  const employeeId = employee.id;
  const uiEmp = toUiEmployee(employee, engineDown);
  const uiChannel: Channel = {
    id: channel.id,
    name: uiEmp.name,
    dm: true,
    employees: [employeeId],
  };

  const summary = folds.summaryOf(conv);
  const root = threadRoot(
    conv,
    folds.pool,
    summary?.root,
    folds.drops[conv.id],
  );
  const asksHere = folds.asks.get(conv.id) ?? NO_ASKS;
  /* AC-6 (D-#19): plan surfaces only exist when the engine declares `plan`. */
  const planCap = hasCapability("plan");
  /* #315: waiting items (and parked/removed rows) leave the reply pool —
     they render in the trays above the composer, not as bubbles. #427: the
     fold rides the same per-conv cache as the feed. */
  const folded = folds.cache.thread(folds.inputs(conv), {
    rootId: root?.id,
    planCap,
  });
  const waiting = folded.feed.waiting.waiting;
  const notSent = folded.thread.notSent;
  const convWs = folded.feed.ws;
  const uiJobs = buildUiJobs(
    model,
    sid ? aux.listedJobs[sid] : undefined,
    aux.jobsCapable,
  );

  const thread: Thread = {
    /* #586: the tag is display-only (the session row resolves on the full
       engineRef) — the TAIL is the unique part of a Hermes ref. */
    session: sessionLabel(sid ?? conv.id),
    title: conv.title || undefined,
    archived: conv.archived,
    replies: folded.thread.replies,
    /* #315: the not-sent tray reads ONLY ■-stopped parked sends. */
    queue: notSent.map((m) => m.text),
    /* #300: live turn usage first, the persisted conv.usage for sessions
       the engine forgot (legacy engineRefs degrade to an empty replay). */
    usage: threadUsage(model, conv),
    // The session's pick: the pinned conversation fields win; the session
    // snapshot fills what a bare `model` pin (pre-#92 rows) never set.
    model: conv.model ?? model?.model,
    provider: conv.provider ?? model?.provider,
    effort: conv.effort ?? model?.effort,
    fast: conv.fast ?? model?.fast,
    ...(convWs ? { ws: convWs } : {}),
    /* #179 AC-4/AC-5: the Background tab reads this list only when the
       engine declared `background_jobs` (uiJobs is empty otherwise — and
       the tab hides itself when it is). */
    ...(uiJobs.length ? { jobs: uiJobs } : {}),
    /* #579 AC-1: the header's "PR #N" chip — the Workbench probe's live
       read wins once it reports; the conversations.prs list fills in before
       it does (undefined probe = not answered yet). */
    ...(aux.probePr !== undefined
      ? aux.probePr
        ? { pr: aux.probePr }
        : {}
      : aux.listedPr
        ? { pr: aux.listedPr }
        : {}),
  };
  const rootMsg: Extract<Msg, { kind: "msg" }> = root
    ? {
        kind: "msg",
        id: root.id,
        from: root.authorId,
        time: clock(root.createdAt),
        text: root.text,
        attachments: toAttachedFiles(root.attachments),
        thread,
      }
    : { kind: "msg", id: conv.id, from: "user", time: "", text: "", thread };

  const { onPlan, send } = threadSendHandlers({
    conv,
    employeeId,
    asks: asksHere,
    setDraft,
  });
  const running = !!model?.live || pendingMap[conv.id] === true;
  /* ↑ recall in the open session: the user's last sent message in it — the
     root counts too (#104 AC-5). */
  const lastSent = folds.pool.reduce<(typeof folds.pool)[number] | undefined>(
    (last, m) =>
      m.authorKind === "user" && (!last || m.seq > last.seq) ? m : last,
    undefined,
  )?.text;
  /* The session's real folder for the session view (issue #113/114):
     absent when the session was started without one — no Workbench folder
     tabs then (D-#19). */
  const work: Work | null = conv.cwd
    ? {
        ticket: "",
        title: conv.title ?? "",
        path: conv.cwd,
        ...(convWs?.branch ? { branch: convWs.branch } : {}),
      }
    : null;
  const compactCap = hasCapability("compact");
  const jobsCapable = aux.jobsCapable;
  const cwd = conv.cwd;

  return {
    conv,
    employeeId,
    employee,
    uiEmp,
    uiChannel,
    empFn,
    mentionables,
    rootMsg,
    status:
      V3_STATUS[threadStatus(conv, model, sid ? signals[sid] : undefined)],
    thread,
    resolved: resolvedReceipts(asksHere),
    running,
    steer: hasCapability("steer"),
    agentWorking: !!model?.live?.agentInitiated,
    reconnecting,
    planCap,
    jobsCapable,
    transcriptNote: transcriptNoteFor(conv, feed, engineState),
    pending: folded.thread.pendingItems,
    draft,
    setDraft,
    lastSent,
    send,
    onPlan,
    onStop: running
      ? () => toastOnFail("Couldn't stop the turn", interruptSession(conv.id))
      : undefined,
    onRetry: () =>
      retryConversation(conv, employeeId, folds.pool, summary?.root?.text),
    onCompact: compactCap && sid ? () => compactConversation(conv) : undefined,
    onContinue: () =>
      void continueInNewSession(conv, employeeId, employee.name),
    models: catalog.length ? catalog : undefined,
    defaultModel,
    defaultProvider,
    picker,
    modelOpen: modelOpenFor === conv.id,
    setModelOpen: (o) => setModelOpenFor(o ? conv.id : null),
    onModel: (c) =>
      toastOnFail(
        "Couldn't switch the model",
        setConversationModel(conv.id, c),
      ),
    onAccess: (a) =>
      toastOnFail(
        "Couldn't change the access level",
        setConversationAccess(conv.id, a),
      ),
    /* The host-owned commands (issue #109): `/model` opens the picker the
       surface already owns; `/rewind`/`/undo` rewind the last user message.
       Everything else returns false — the send posts and the engine runs it
       (compact rides the engine's own handler until its surface lands). */
    onCommand: (name) => {
      if (name === "model") {
        if (!catalog.length) return false;
        setModelOpenFor(conv.id);
        return true;
      }
      if (name === "rewind" || name === "undo") {
        if (!sid) return false;
        const last = folds.pool
          .filter(
            (m) => m.conversationId === conv.id && m.authorKind === "user",
          )
          .at(-1);
        if (!last) return false;
        rewind.rewindTo(conv, last.id);
        return true;
      }
      return false;
    },
    searchFiles: fileSearch(cwd),
    searchCommands: sessionCommands(sid),
    onRewind: sid ? (id) => rewind.rewindTo(conv, id) : undefined,
    rewindWarning: rewindWarningFor(conv, folds.summaries, home),
    seedFiles: rewind.seedFiles,
    clearSeed: rewind.clearSeed,
    filesOnly:
      rewind.filesOnly?.conversationId === conv.id ? rewind.filesOnly : null,
    startFresh: (target) =>
      startFreshFrom(conv, target, {
        pool: folds.pool,
        employeeId,
        agentName: employee.name,
        draft,
        seedFiles: rewind.seedFiles,
      }),
    onRemovePending: (i) => removeMessage(waiting[i]?.message),
    onUnqueue: (i) => removeMessage(notSent[i]),
    onSendQueued: (i) => sendQueuedMessage(notSent[i]),
    editors: aux.editors,
    openPath:
      cwd && aux.editors !== null
        ? (path, app, line) => {
            void hostOsOpen(cwd, path, app, line).catch((e) =>
              sayError(describeActionError("Couldn't open the file", e)),
            );
          }
        : undefined,
    /* #581 AC-2: a folder-less thread gets "Add a folder" — the pick moves
       the session there (same thread, same memory). The gate is the
       conversation's cwd itself. */
    moveFolderOpen: moveFolderFor === conv.id,
    setMoveFolderOpen: (o) => {
      setMoveFolderFor(o ? conv.id : null);
      if (o) toastOnFail("Couldn't scan for repos", loadDiscovered());
    },
    work,
    onStopJob: jobsCapable ? (id) => stopBackgroundJob(conv, id) : undefined,
    wbSpot: wbSpots[conv.id],
    onPr: aux.setProbePr,
    /* #584: Suggest rides `session.ask` — a side request that adds nothing
       to the transcript. Only where the engine declares it. */
    onSuggest:
      hasCapability("side_prompt") && sid
        ? (files) =>
            relay
              .request<{ answer: string }>("session.ask", {
                sessionId: sid,
                text: `Write a one-line git commit message for these changed files: ${
                  files.join(", ") || "the listed files"
                }`,
              })
              .then((r) => r.answer)
        : undefined,
    caps: {
      plan: planCap,
      subagents: hasCapability("subagents"),
      background: jobsCapable,
    },
    historyFailed: folds.historyFailed,
    retryHistory: folds.retryHistory,
    /* AC-3: a subagent row for another employee opens their own session in
       its thread (D-#25) — resolve the engine sessionRef to its conversation. */
    resolveSession: (empRef, sessionRef) => {
      const target = folds.summaries.find(
        (s) => s.conversation.engineRef === sessionRef,
      )?.conversation;
      return target
        ? {
            conversationId: target.id,
            employeeId:
              channels.find((c) => c.id === target.channelId)?.employeeId ??
              empRef,
          }
        : { employeeId: empRef };
    },
  };
}
