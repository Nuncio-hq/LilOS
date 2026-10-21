import { MAX_ATTACHMENT_BYTES } from "@lilos/contracts/app";
import {
  archiveConversation,
  renameConversation,
  respondToRequest,
  toastOnFail,
} from "../lib/actions";
import { humanFor } from "../lib/me";
import { sayError } from "../lib/toast";
import { outcomeFromLabel } from "./outcome";
import type { ThreadData } from "./thread-data";

/* The props ThreadView (the panel) and FocusView (the session view) take
   identically — one place, so the two frames can't drift. Frame-only props
   (and the few that differ, like `onModel`/`onOpenPath`) stay in each pane. */
export function sharedViewProps(d: ThreadData) {
  return {
    root: d.rootMsg,
    thread: d.thread,
    threadStatus: d.status,
    channel: d.uiChannel,
    emp: d.empFn,
    human: humanFor,
    resolved: d.resolved,
    /* Reply cards report {askId: label}; map label -> outcome. */
    setResolved: (r: Record<string, string>) => {
      const diff = Object.entries(r).find(([k, v]) => d.resolved[k] !== v);
      if (diff)
        void respondToRequest(diff[0], outcomeFromLabel(diff[1])).catch(
          () => {},
        );
    },
    /* #553: the shared question card answers the ask — the option sends its
       wire id, typed text the text itself; Skip cancels. The
       engine-resolved write lands the receipt. */
    onAnswer: (q: { id: string }, a: { value: string }) =>
      void respondToRequest(q.id, "answer", a.value).catch(() => {}),
    onCancel: (q: { id: string }) =>
      void respondToRequest(q.id, "cancel").catch(() => {}),
    running: d.running,
    steer: d.steer,
    agentWorking: d.agentWorking,
    transcriptNote: d.transcriptNote,
    models: d.models,
    picker: d.picker,
    defaultModel: d.defaultModel,
    defaultProvider: d.defaultProvider,
    onCommand: d.onCommand,
    modelOpen: d.modelOpen,
    onModelOpen: d.setModelOpen,
    access: d.conv.access,
    onAccess: d.onAccess,
    /* The header's ⋯ menu: rename in place, archive/unarchive. */
    onRename: (title: string) =>
      toastOnFail(
        "Couldn't rename the thread",
        renameConversation(d.conv.id, title),
      ),
    onArchive: (archived: boolean) =>
      toastOnFail(
        archived
          ? "Couldn't archive the thread"
          : "Couldn't unarchive the thread",
        archiveConversation(d.conv.id, archived),
      ),
    onSend: d.send,
    onPlan: d.planCap ? d.onPlan : undefined,
    onCompact: d.onCompact,
    onContinue: d.onContinue,
    pending: d.pending,
    reconnecting: d.reconnecting,
    onRemovePending: d.onRemovePending,
    onUnqueue: d.onUnqueue,
    onSendQueued: d.onSendQueued,
    draft: d.draft,
    onDraftChange: d.setDraft,
    accept: "*/*",
    maxFileSize: MAX_ATTACHMENT_BYTES,
    onAttachError: sayError,
    onStop: d.onStop,
    lastSent: d.lastSent,
    /* #419: hover Retry on the last turn re-sends the last user message
       into this same session. */
    onRetry: d.onRetry,
    onRewind: d.onRewind,
    rewindWarning: d.rewindWarning,
    seedFiles: d.seedFiles,
    onSeededFiles: d.clearSeed,
    editors: d.editors ?? undefined,
  };
}
