import type { ChatStatus } from "ai";
import type { ReactNode } from "react";
import { AccessPill } from "../chat/access-pill";
import {
  NotSentTray,
  QueuedTray,
  queuedItemText,
  ReconnectingLine,
  runningComposer,
  waitingComposer,
} from "../chat/agent-chat";
import { Composer } from "../chat/composer";
import { sessionChoice } from "../chat/model-picker";
import type { Employee } from "../types";
import type { ThreadFrameProps } from "./frame-props";

type ComposerProps = Pick<
  ThreadFrameProps,
  | "thread"
  | "running"
  | "steer"
  | "agentWorking"
  | "models"
  | "onModel"
  | "picker"
  | "defaultModel"
  | "defaultProvider"
  | "modelOpen"
  | "onModelOpen"
  | "mentionables"
  | "onSearchFiles"
  | "onSearchCommands"
  | "onCommand"
  | "onSend"
  | "onStop"
  | "draft"
  | "onDraftChange"
  | "lastSent"
  | "seedFiles"
  | "onSeededFiles"
  | "accept"
  | "maxFileSize"
  | "maxFiles"
  | "onAttachError"
  | "access"
  | "onAccess"
  | "pending"
  | "reconnecting"
  | "onRemovePending"
  | "onUnqueue"
  | "onSendQueued"
>;

/* The thread's one composer and the trays above it, for BOTH frames: the
   panel and the session view hand it the same props, so `@` mentions, the `/`
   menu, attachments, the model picker, Stop (⌘.) and the queued/not-sent trays
   are the same surface wherever the thread is open. A frame adds only what is
   its own: the line it shows when idle (`idleHint`), a reason the agent is
   paused (`paused`), and a tray of its own above the others (`above`). */
export function ThreadComposer({
  lead,
  idleHint,
  paused,
  above,
  ...p
}: ComposerProps & {
  /** The thread's employee, if known — the composer names whose work it is
      and the model picker starts from their model. */
  lead?: Employee;
  idleHint: string;
  /** Replaces the placeholder while something else holds the session (the
      human using its terminal). */
  paused?: string;
  /** A tray of the frame's own, above the queued and not-sent trays. */
  above?: ReactNode;
}) {
  const { thread, running, steer = false, agentWorking = false } = p;
  const leadName = lead?.name;
  const name = leadName ?? "Employee";
  /* #420 + #583 AC-1: a live reply parked on ANY open ask (question,
     approval, plan) is WAITING, not working — the placeholder says what it
     waits on. A question ask also parks the composer itself (Send, not Stop —
     Hermes FIX #515); an approval/plan-parked turn is still interruptible and
     steerable, so it keeps Stop (⌘.), steers and the running hint — only the
     placeholder names the wait. */
  const waitingReply = thread.replies.find(
    (r) => r.live && r.phase === "waiting",
  );
  const waiting = running && !!waitingReply;
  const parkedOnQuestion = waiting && waitingReply?.waitingOn === "question";
  const status: ChatStatus = running
    ? parkedOnQuestion
      ? "ready"
      : thread.replies.some((r) => r.live && r.phase === "submitted")
        ? "submitted"
        : "streaming"
    : "ready";
  const wait = waitingComposer(name, waitingReply?.waitingOn);
  const run = runningComposer(name, steer, agentWorking);
  const pending = p.pending ?? [];
  return (
    <Composer
      placeholder={
        paused ??
        (running
          ? waiting
            ? wait.placeholder
            : run.placeholder
          : `Message ${leadName ?? "the employee"}…`)
      }
      employees={p.mentionables ?? []}
      onSearchFiles={p.onSearchFiles}
      onSearchCommands={p.onSearchCommands}
      onCommand={p.onCommand}
      hint={running ? (parkedOnQuestion ? wait.hint : run.hint) : idleHint}
      onSend={p.onSend}
      draft={p.draft}
      onDraftChange={p.onDraftChange}
      seedFiles={p.seedFiles}
      onSeededFiles={p.onSeededFiles}
      status={status}
      lastSent={p.lastSent}
      accept={p.accept}
      maxFileSize={p.maxFileSize}
      maxFiles={p.maxFiles}
      onAttachError={p.onAttachError}
      onStop={p.onStop}
      models={p.models}
      onModel={p.onModel}
      picker={p.picker}
      modelOpen={p.modelOpen}
      onModelOpen={p.onModelOpen}
      choice={
        p.models?.length
          ? sessionChoice(
              thread,
              lead?.model,
              p.models,
              p.defaultModel,
              p.defaultProvider,
            )
          : undefined
      }
      tools={
        p.access !== undefined && p.onAccess ? (
          <AccessPill access={p.access} onAccess={p.onAccess} />
        ) : undefined
      }
      queued={
        <>
          {above}
          {p.reconnecting && <ReconnectingLine />}
          {/* Every mid-turn send waits here until the agent reads it — steer
              or not (issue #9). */}
          <QueuedTray
            items={pending}
            steer={steer}
            name={leadName}
            onRemove={p.onRemovePending}
            onEdit={
              p.onRemovePending && p.onDraftChange
                ? (i) => {
                    p.onDraftChange?.(
                      pending[i] ? queuedItemText(pending[i]) : "",
                    );
                    p.onRemovePending?.(i);
                  }
                : undefined
            }
          />
          <NotSentTray
            items={thread.queue ?? []}
            onSend={p.onSendQueued}
            onRemove={p.onUnqueue}
          />
        </>
      }
    />
  );
}
