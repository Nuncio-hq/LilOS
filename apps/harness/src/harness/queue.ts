import type { AppMessage } from "@lilos/contracts/app";
import type { HarnessCtx, SessionBinding } from "./ctx";

/**
 * The per-binding send lane: consume-or-queue, steer-or-queue,
 * and the FIFO drain (was the middle of the `message -> engine` section
 * of `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — bodies byte-identical except each signature gained
 * `export function` + a `this: HarnessCtx` first parameter — `this` is
 * still the Harness: these functions sit on `Harness.prototype` via the
 * `Object.assign` at the bottom of `../harness.ts`.
 */

export function enqueueOrPrompt(
  this: HarnessCtx,
  binding: SessionBinding,
  message: AppMessage,
) {
  /* #487: entries can arrive on a captured copy (a dispatch's re-queue
     path) — always serve the live binding's lane. */
  binding = this.liveBinding(binding);
  // In-flight guard: replayed `turn.started` refs populate `consumed`, and
  // claiming the id here means a message can't be prompted twice even when
  // two delivery paths (register pending + channel replay) race before the
  // first turn.started lands. The queue-drain path bypasses this by design:
  // entries here failed or steered out, so a fresh send is the point.
  if (binding.consumed.has(message.id)) return;
  /* Dead rows never enter the queue or the wire: `dismissed` is the
     event-fed kill-set, the row flags are the durable truth when a
     `message.changed` frame never arrived (#377). */
  if (
    this.dismissed.has(message.id) ||
    message.removed ||
    message.dropped ||
    message.rewound
  )
    return;
  /* #403: a send the Stop stamped parks wherever it surfaces — even one
     whose `channelMessages` row landed after the drain already ran and
     `stopRequested` has long cleared. */
  if (this.stopOwns(binding.conversationId, message)) {
    this.dropStopped(binding, message);
    return;
  }
  binding.consumed.add(message.id);
  if (binding.runningTurnId) {
    // Capability `steer` (#9): a mid-turn user message steers the running
    // turn; without it the message queues as the next prompt.
    // `session.steer` carries text only — a mid-turn message with
    // attachments queues so its image blocks go out through sendPrompt
    // instead of being silently dropped (#112). So does a message while a
    // pick is held: the pick applies before the next prompt, so the
    // message runs as that next prompt on the new model instead of
    // steering the old turn (#92).
    const conn = this.engine;
    if (
      conn &&
      this.hasCapability("steer") &&
      !message.attachments?.length &&
      !binding.heldPick
    ) {
      void this.stampCheckpoint(binding, message)
        .then(() =>
          conn.request<{ status: "steered" | "not_running" }>("session.steer", {
            sessionId: binding.sessionId,
            text: message.text,
            /* Same link as `prompt.ref` — a steer that outlives its turn
                 pumps as the next one, and its turn.started must still name
                 the relay message (#134 rewind filtering keys off it). */
            ref: message.id,
          }),
        )
        .then((res) => {
          /* Removed while the steer RPC was in flight: the engine took it,
             but the row is `removed` — don't advance deliveredSeq over it
             (a restart would re-owe it anyway: pending turns skip removed
             rows) and don't track it as a droppable steer. */
          if (this.dismissed.has(message.id)) return;
          /* #487: a rebind during the steer RPC swapped the binding — this
             ack belongs to a session that no longer exists. A "steered" the
             live lane never saw is really a `not_running`: the send
             re-prompts on the rebound session rather than marking
             delivered + steerPending into the void. */
          const live = this.liveBinding(binding);
          if (live !== binding) {
            live.consumed.delete(message.id);
            this.promptOrQueue(live, message);
            return;
          }
          /* #550: the landing outran this ack — `turn.steered` recorded
             the text in `steerLanded` before the response resolved, so a
             matched steer is already inside the turn: delivered, never a
             wait the Stop-drop below can park. */
          const landedIdx = binding.steerLanded.findIndex(
            (t) => t === message.text,
          );
          if (landedIdx >= 0) {
            binding.steerLanded.splice(landedIdx, 1);
            this.markDelivered(binding, message);
            return;
          }
          /* #377: a steer resolving after its turn's Stop — even after the
             park sweep ran (`stopParked`) — parks in the tray like the
             sends the sweep caught; delivering or re-prompting it would
             slip a sent-before-Stop message past the tray. Send clears
             `dismissed` and re-delivers it. */
          if (
            binding.stopRequested ||
            binding.stopParked ||
            /* #403: the stamp reaches sends `stopRequested` can no longer
               see — the flag cleared at the next `turn.started` while a
               pre-Stop send's steer ack was still in flight. */
            this.stopOwns(binding.conversationId, message)
          ) {
            binding.consumed.delete(message.id);
            this.dismissed.add(message.id);
            this.relayWrite(`drop steer ${message.id}`, () =>
              this.opts.relay.request("messages.drop", {
                messageId: message.id,
              }),
            );
            return;
          }
          if (res.status === "steered") {
            this.markDelivered(binding, message);
            /* Tracked until `turn.steered` lands or a Stop drops it —
               engines discard pending steers on interrupt (#315 AC-5). */
            binding.steerPending.push({
              messageId: message.id,
              text: message.text,
              seq: message.seq,
            });
            /* The steer can resolve after its turn ended: nothing will
               land it now — start the stranded-steer reconcile (#315). */
            if (!binding.runningTurnId) this.scheduleSteerReconcile(binding);
          } else {
            // not_running: the turn ended between our check and the steer
            // (e.g. a Stop just landed). The engine consumed nothing — send
            // it as the next prompt now, or queue it if a new turn already
            // started. Queuing alone stranded it: the queue only drains on
            // turn.completed, and no turn was running.
            binding.consumed.delete(message.id);
            this.promptOrQueue(binding, message);
          }
        })
        .catch((error) => {
          this.opts.log.warn("steer failed; queued instead", {
            error: String(error),
          });
          /* #487: same rebind window as the ack — the failure fallback
             re-prompts on the live lane. */
          const live = this.liveBinding(binding);
          /* #550: a landing that outran the failed ack (the conn died
             after `turn.steered` but before the response) means the
             engine already applied it — deliver, don't re-prompt. */
          if (live === binding) {
            const landedIdx = binding.steerLanded.findIndex(
              (t) => t === message.text,
            );
            if (landedIdx >= 0) {
              binding.steerLanded.splice(landedIdx, 1);
              this.markDelivered(binding, message);
              return;
            }
          }
          live.consumed.delete(message.id);
          this.promptOrQueue(live, message);
        });
      return;
    }
    binding.consumed.delete(message.id);
    this.insertQueued(binding, message);
    this.opts.log.debug("queued behind running turn", {
      conversationId: binding.conversationId,
      queued: binding.queue.length,
    });
    return;
  }
  /* #377: the send lanes through the same queue — a `sendPrompt` already
     dispatching (turn.started not yet seen) must reach the wire before
     the next prompt leaves, or the two race and the loser comes back
     INVALID_STATE, re-queued out of order. drainQueue fires it when the
     lane is free. */
  binding.consumed.delete(message.id);
  this.insertQueued(binding, message);
  this.drainQueue(binding);
}

/**
 * #487: callers that held `binding` across awaits (sendPrompt's dispatch,
 * the steer RPC) must not queue on it blind — a rebind swaps
 * `bindings[convId]` mid-flight and splices the queue, so a re-queue onto
 * the replaced copy lands after the splice with nothing left to drain it
 * (`consumed` cleared, `delivered` already claimed): the send orphans —
 * the ac-112 AC-5b mid-turn image that never rendered. Re-resolve the
 * binding the map actually serves.
 */
export function liveBinding(
  this: HarnessCtx,
  binding: SessionBinding,
): SessionBinding {
  return this.bindings.get(binding.conversationId) ?? binding;
}

/** FIFO is arrival order; the tray and the drain owe the user send
    order — insert by relay seq so a late re-queue can't invert it. */
export function insertQueued(
  this: HarnessCtx,
  binding: SessionBinding,
  message: AppMessage,
): void {
  if (binding.queue.some((m) => m.id === message.id))
    this.opts.log.warn("queue dup insert", {
      conversationId: binding.conversationId,
      messageId: message.id,
    });
  const at = binding.queue.findIndex((m) => m.seq > message.seq);
  if (at === -1) binding.queue.push(message);
  else binding.queue.splice(at, 0, message);
}

/** Queue it behind whatever occupies the lane; drain when it's free. */
export function promptOrQueue(
  this: HarnessCtx,
  binding: SessionBinding,
  message: AppMessage,
) {
  /* #487: the steer failure fallback reaches here across an RPC await —
     the captured binding may already be replaced. */
  binding = this.liveBinding(binding);
  /* #315 AC-5: while a Stop parks everything waiting, a send the engine
     never accepted (a `not_running` steer settling late) parks the same
     way instead of prompting a fresh turn past the stop. `dismissed`
     guards the stale-copy paths too; Send clears it (#377). #403: the
     stamp outlives `stopRequested` — the flag clears at the next
     `turn.started` while a pre-Stop send can still be in transit, so
     the causal line gates here too. */
  if (binding.stopRequested || this.stopOwns(binding.conversationId, message)) {
    this.dropStopped(binding, message);
    return;
  }
  this.insertQueued(binding, message);
  this.drainQueue(binding);
}

/**
 * #377: one `prompt` on the wire at a time per binding, in send order.
 * Fires only while the lane is free — no running turn, no dispatch in
 * flight. Rows already dead (removed/dropped/dismissed) skip straight out
 * of the queue instead of prompting.
 */
export function drainQueue(this: HarnessCtx, binding: SessionBinding): void {
  /* #487: a stale copy's drain would fire queued sends on the dead session
     — always serve the live binding's lane. */
  binding = this.liveBinding(binding);
  if (binding.runningTurnId || binding.inflightPrompts.size > 0) return;
  while (binding.queue.length) {
    const next = binding.queue.shift();
    if (!next) break;
    /* #377: already `consumed` means the engine took this send through
       another path — `turn.started.ref` claimed it while its re-queued
       copy still sat here (socket dropped after the prompt landed).
       Leave the claim in place; the copy just never re-prompts. */
    if (binding.consumed.has(next.id)) {
      this.opts.log.warn("drain skip: consumed", {
        messageId: next.id,
      });
      continue;
    }
    const dead =
      this.dismissed.has(next.id) ||
      next.removed ||
      next.dropped ||
      next.rewound;
    if (dead) {
      binding.consumed.delete(next.id);
      continue;
    }
    /* #403: a pre-Stop send that slipped into the queue still parks —
       the stamp decides, not arrival order. */
    if (this.stopOwns(binding.conversationId, next)) {
      this.dropStopped(binding, next);
      continue;
    }
    binding.consumed.add(next.id);
    void this.sendPrompt(binding, next);
    return;
  }
}
