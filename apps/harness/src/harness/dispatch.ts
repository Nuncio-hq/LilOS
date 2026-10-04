import type { AppMessage, AttachmentsGetResult } from "@lilos/contracts/app";
import type { ContentBlock } from "@lilos/contracts/engine";
import { engineErrorCode, SESSION_NOT_FOUND } from "../engine/client";
import type { HarnessCtx, SessionBinding } from "./ctx";
import { BACKEND_DOWN, INVALID_STATE } from "./rpc";

/**
 * One queued send onto the wire: prompt gates, dispatch error
 * taxonomy, folder checkpoints, and the claim/watermark bookkeeping (was
 * the tail of the `message -> engine` section of `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — bodies byte-identical except each signature gained
 * `export function` + a `this: HarnessCtx` first parameter — `this` is
 * still the Harness: these functions sit on `Harness.prototype` via the
 * `Object.assign` at the bottom of `../harness.ts`.
 */

export async function sendPrompt(
  this: HarnessCtx,
  binding: SessionBinding,
  message: AppMessage,
) {
  /* #274: interrupts (and rewinds) gate on every in-flight send for this
     binding until its `prompt` frame is on the wire — a Stop fired while
     this send is still in its pre-prompt awaits (attachment fetch, folder
     checkpoint) then lands BEHIND the prompt on the in-order conn and
     interrupts the turn it meant to stop, instead of being acked
     `interrupted:false` and lost. Released on dispatch or any bail. */
  binding.inflightPrompts.add(message.id);
  /* #377: claim the row the moment the lane commits it — while the send
     is still in its pre-prompt awaits it would otherwise sit "pending"
     in the waiting tray alongside truly queued sends, and a Remove
     click could hit it (retracting a send the user meant to keep, then
     running the queued one in its place). Claimed rows leave the tray
     and render as their own bubble; the engine never sees a row the
     user removed. */
  this.relayWrite(`claim ${message.id}`, () =>
    this.opts.relay.request("messages.claim", { messageId: message.id }),
  );
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => (releaseGate = resolve));
  binding.promptGates.add(gate);
  let requeued = false;
  try {
    requeued = await this.dispatchPrompt(binding, message, releaseGate);
  } finally {
    binding.inflightPrompts.delete(message.id);
    releaseGate();
    binding.promptGates.delete(gate);
    /* The lane just freed: sends queued behind this dispatch (or behind
       the turn it minted) advance now — waiting on the next turn.completed
       alone would strand a send whose dispatch bailed (#377). A dispatch
       that put its message BACK on the queue must not drain, though:
       re-queue means the engine is busy or gone, and turn.completed or
       the rebind already re-fires the drain — an immediate one would
       hot-loop the same prompt (#377 OOM in the loaded suite). */
    if (!requeued) this.drainQueue(binding);
  }
}

/** True when the message went back on the queue and awaits an external
    drain (turn.completed / rebind); false when it settled for good. */
export async function dispatchPrompt(
  this: HarnessCtx,
  binding: SessionBinding,
  message: AppMessage,
  promptOnWire: () => void,
): Promise<boolean> {
  const conn = this.engine;
  if (!conn) {
    this.opts.log.warn("prompt requeue: no conn", { messageId: message.id });
    const live = this.liveBinding(binding);
    live.consumed.delete(message.id);
    /* #403: resting in the queue is waiting again — the tray owns the
       row until the lane re-claims it. */
    this.unclaimMessage(message);
    /* #487: the binding may have been rebound while this dispatch was in
       its pre-conn awaits — the live binding owns the re-queue. */
    if (live !== binding) {
      this.enqueueOrPrompt(live, message);
      return true;
    }
    this.insertQueued(binding, message);
    return true;
  }
  // A pick held while the last turn ran lands now, before this prompt —
  // the session is idle so setModel applies straight away (#92).
  await this.applyHeldPick(binding);
  // Attachment bytes never ride the message row — the harness fetches each
  // ref via `attachments.get` and sends ACP-shaped image blocks (issue #31).
  const images: ContentBlock[] = [];
  for (const ref of message.attachments ?? []) {
    try {
      const stored = await this.opts.relay.request<AttachmentsGetResult>(
        "attachments.get",
        { id: ref.id },
      );
      images.push({
        type: "image",
        data: stored.dataBase64,
        mimeType: stored.attachment.mimeType,
      });
    } catch (error) {
      this.opts.log.error("attachment fetch failed", {
        attachmentId: ref.id,
        error: String(error),
      });
      await this.postSystem(
        binding,
        `Attachment "${ref.name || ref.id}" could not be loaded — sending the message without it.`,
      );
    }
  }
  // Text block only when there is text — an image-only message prompts
  // with just image blocks rather than an empty text block (#112).
  const content: ContentBlock[] = message.text
    ? [{ type: "text", text: message.text }, ...images]
    : images;
  if (!content.length) {
    // Every attachment failed to load and no text was typed — nothing to
    // send; the postSystem notes above already told the user.
    this.markDelivered(binding, message);
    return false;
  }
  /* #134: snapshot the session folder BEFORE the turn so a later
     "Rewind to here" on this message can restore it. */
  await this.stampCheckpoint(binding, message);
  /* #377: the pre-prompt awaits (held pick, attachment fetch, checkpoint)
     give a Remove/drop the whole window to land — the `message.changed`
     splice only reaches rows still sitting in `binding.queue`, so an
     in-flight send must re-check before its frame hits the wire. */
  if (
    this.dismissed.has(message.id) ||
    message.removed ||
    message.dropped ||
    message.rewound
  ) {
    binding.consumed.delete(message.id);
    return false;
  }
  /* #487: the pre-prompt awaits (held pick, attachment fetch, checkpoint)
     give a rebind the whole window — this frame must leave on the session
     the map actually serves, not a replaced one. A send aimed at the dead
     sessionId re-enters the live lane instead of round-tripping a
     SESSION_NOT_FOUND. */
  const current = this.liveBinding(binding);
  if (current !== binding) {
    current.consumed.delete(message.id);
    this.unclaimMessage(message);
    this.enqueueOrPrompt(current, message);
    return true;
  }
  try {
    // Turn lifecycle (`turn.started`/`turn.completed`) arrives as events
    // before the prompt call resolves — they alone own runningTurnId.
    // No RPC timeout: a turn can run for minutes; completion is an event,
    // and a socket drop still rejects this call.
    const turn = conn.request<{ turnId: string }>(
      "prompt",
      {
        sessionId: binding.sessionId,
        content,
        // The relay message id rides to the engine and back on
        // `turn.started` — that's what makes a replayed turn prove which
        // user message it consumed, and what its answer dedupes under.
        ref: message.id,
      },
      0,
    );
    // The prompt frame is on the wire — a gated interrupt/rewind may go.
    promptOnWire();
    await turn;
    this.markDelivered(binding, message);
  } catch (error) {
    /* #377: a row that died mid-dispatch (removed while the prompt raced
       in, or parked by a Stop that landed meanwhile) never re-enters the
       queue — the splice window for it already closed. */
    if (
      this.dismissed.has(message.id) ||
      message.removed ||
      message.dropped ||
      message.rewound
    ) {
      binding.consumed.delete(message.id);
      return false;
    }
    if (
      binding.stopRequested ||
      /* #403: a pre-Stop send whose prompt failed parks like everything
         else the Stop caught — re-queueing it would run it past the
         Stop even after `stopRequested` cleared. */
      this.stopOwns(binding.conversationId, message)
    ) {
      this.dropStopped(binding, message);
      return false;
    }
    // Going back on the queue releases the in-flight claim — a rebind
    // drains the queue through enqueueOrPrompt, which dedupes on it.
    if (engineErrorCode(error) === undefined) {
      /* #377: a `turn.started` already consumed this message — the socket
         dropped after the prompt landed, so the turn ran anyway.
         Re-queuing would mint a duplicate turn on the next drain; it's
         delivered, not pending. */
      if ([...binding.turnSource.values()].includes(message.id)) return false;
      this.opts.log.warn("prompt requeue: transport", {
        messageId: message.id,
        error: String(error),
      });
      // Transport failure (socket dropped / engine died mid-prompt): the
      // engine may still have taken the turn — its replayed
      // `turn.started.ref` reclaims the message on resync, and the answer
      // dedupes on the same key either way.
      const live = this.liveBinding(binding);
      live.consumed.delete(message.id);
      /* #487: a socket that drops during a rebind lands this re-queue
         AFTER the rebind's queue splice — the splice's successor owns
         it, or the send sits on the replaced binding's queue forever. */
      if (live !== binding) {
        this.unclaimMessage(message);
        this.enqueueOrPrompt(live, message);
        return true;
      }
      this.insertQueued(binding, message);
      this.unclaimMessage(message);
      return true;
    }
    if (engineErrorCode(error) === INVALID_STATE) {
      this.opts.log.warn("prompt requeue: invalid_state", {
        messageId: message.id,
        error: String(error),
      });
      const live = this.liveBinding(binding);
      live.consumed.delete(message.id);
      /* #487: rebound mid-dispatch — the fresh session is live's; this
         send re-enters through the live lane rather than re-binding a
         session that was already replaced. */
      if (live !== binding) {
        this.unclaimMessage(message);
        this.enqueueOrPrompt(live, message);
        return true;
      }
      /* #346 AC-2: a turn running makes the requeue right — it drains
         on turn.completed. With none, the session is closed for good
         (a suspended session resumes inside `prompt` and never lands
         here): requeueing was the parent's infinite INVALID_STATE
         loop, so rebind — session.start, then the queue drains on the
         fresh session. #377: requeues insert in send order. */
      if (binding.runningTurnId) {
        this.insertQueued(binding, message);
        return true;
      }
      this.insertQueued(binding, message);
      this.unclaimMessage(message);
      await this.rebindConversation(binding);
      return true;
    }
    if (engineErrorCode(error) === SESSION_NOT_FOUND) {
      this.opts.log.warn("prompt requeue: session_not_found", {
        messageId: message.id,
      });
      const live = this.liveBinding(binding);
      live.consumed.delete(message.id);
      /* #487: the dead session's binding may already be replaced — a
         re-queue + rebind on the captured copy would strand the send
         after the splice and mint a third session for nothing. */
      if (live !== binding) {
        this.unclaimMessage(message);
        this.enqueueOrPrompt(live, message);
        return true;
      }
      this.insertQueued(binding, message);
      this.unclaimMessage(message);
      await this.rebindConversation(binding);
      return true;
    }
    if (engineErrorCode(error) === BACKEND_DOWN) {
      /* #521: the backend died under this prompt — restart surface, not
         a generic Engine error. turn.completed lands on the same dedupe
         key (source = the prompting message id), so one note either way. */
      this.opts.log.warn("prompt interrupted: backend down", {
        conversationId: binding.conversationId,
        error: String(error),
      });
      await this.surfaceBackendDown(binding, message.id);
      return false;
    }
    this.opts.log.error("prompt failed", {
      conversationId: binding.conversationId,
      error: String(error),
    });
    const detail = error instanceof Error ? error.message : String(error);
    await this.postSystem(
      binding,
      `Engine error: ${detail}`,
      `sys:${binding.conversationId}:${message.id}:engine-error`,
    );
    /* #419: the prompt never made a turn — the DM card carries the
       failure so the thread isn't silent + Retry has a surface. */
    await this.updateConversation(binding.conversationId, {
      turnFailure: { kind: "generic", text: `Engine error: ${detail}` },
    });
  }
  return false;
}

/**
 * #134: snapshot the session folder into the shadow-git checkpoint store
 * and stamp the checkpoint id on the user message (the rewind target).
 * Best-effort: a failed snapshot logs and continues — the turn still runs,
 * its message just can't be a file rewind point.
 */
export async function stampCheckpoint(
  this: HarnessCtx,
  binding: SessionBinding,
  message: AppMessage,
): Promise<void> {
  const checkpoints = this.opts.checkpoints;
  /* #412: a folder-less session's cwd is the user's home — snapshotting
     it would `git add -A` the whole ~, and a later restore would delete
     user files. Folder checkpoints only exist for folder-bound sessions. */
  if (!checkpoints || !binding.hasFolder) return;
  try {
    const checkpoint = await checkpoints.snapshot(binding.cwd);
    await this.opts.relay.request("messages.setCheckpoint", {
      channelId: binding.channelId,
      messageId: message.id,
      checkpoint,
    });
  } catch (error) {
    this.opts.log.warn("folder checkpoint failed", {
      conversationId: binding.conversationId,
      messageId: message.id,
      error: String(error),
    });
  }
}

/**
 * Advance the conversation's delivery watermark: this user message reached
 * the engine, so a re-registering harness must not owe it again. Queued
 * messages stay under the watermark until they actually send.
 */
export function markDelivered(
  this: HarnessCtx,
  binding: SessionBinding,
  message: AppMessage,
): void {
  this.relayWrite(`deliveredSeq ${message.id}`, () =>
    this.opts.relay.request("conversations.update", {
      conversationId: binding.conversationId,
      deliveredSeq: message.seq,
    }),
  );
}

/** #403: the send fell back to a resting spot short of the wire — it is
   waiting again, and removable, so the tray takes it back. Fire-and-forget;
   a lost write only delays the tray row. */
export function unclaimMessage(this: HarnessCtx, message: AppMessage): void {
  this.relayWrite(`unclaim ${message.id}`, () =>
    this.opts.relay.request("messages.claim", {
      messageId: message.id,
      claimed: false,
    }),
  );
}
