import type { AppMessage } from "@lilos/contracts/app";
import type { HarnessCtx, SessionBinding } from "./ctx";

/**
 * The #403 Stop causal line: seq stamps, re-Send exemptions,
 * parked sends, and the interrupt handler (was the stop cluster of
 * `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — bodies byte-identical except each signature gained
 * `export function` + a `this: HarnessCtx` first parameter — `this` is
 * still the Harness: these functions sit on `Harness.prototype` via the
 * `Object.assign` at the bottom of `../harness.ts`.
 */

/** Whether a re-Sent row still escapes the CURRENT Stop (#403): the
   exemption lives only for the interrupt generation the Send was made
   under, so the next Stop — same seq stamp or newer — owns the send
   like any other row. */
export function exemptFromCurrentStop(
  this: HarnessCtx,
  conversationId: string,
  messageId: string,
): boolean {
  const at = this.stopExempt.get(messageId);
  return (
    at !== undefined &&
    at.conversationId === conversationId &&
    at.generation === this.stopGenerations.get(conversationId)
  );
}

/** Whether a send falls inside the Stop's causal scope (#403). */
export function stopOwns(
  this: HarnessCtx,
  conversationId: string,
  message: AppMessage,
): boolean {
  const stopSeq = this.stopSeqs.get(conversationId);
  return (
    stopSeq !== undefined &&
    message.seq <= stopSeq &&
    !this.exemptFromCurrentStop(conversationId, message.id) &&
    /* A parked interrupt owns its send's first turn (#400/#402): it fires
       at `turn.started`, which needs the send to prompt — dropping it
       here would starve the very turn the Stop waits on. Only once the
       park has fired (or was cleared) does the seq gate apply. */
    !this.pendingInterrupts.has(conversationId)
  );
}

/** Park a stopped send in the not-sent tray — same as the Stop sweep:
   the id joins `dismissed` so a stale copy can't re-prompt it; Send
   clears both (#377). */
export function dropStopped(
  this: HarnessCtx,
  binding: SessionBinding,
  message: AppMessage,
) {
  binding.consumed.delete(message.id);
  this.dismissed.add(message.id);
  this.relayWrite(`drop stopped ${message.id}`, () =>
    this.opts.relay.request("messages.drop", { messageId: message.id }),
  );
}

/** Channel seq of a relay message — the row the store last delivered. */
export function seqOfMessage(
  this: HarnessCtx,
  channelId: string,
  messageId: string,
): number | undefined {
  return this.opts.relay
    .channelMessages(channelId)
    .get()
    .messages.find((m) => m.id === messageId)?.seq;
}

export async function onInterruptRequested(
  this: HarnessCtx,
  conversationId: string,
  afterSeq?: number,
) {
  /* #403: a new Stop is a new scope even when the seq stamp doesn't
     move — bump the generation so Send exemptions taken under the
     previous Stop lapse (a re-Sent send belongs to this Stop), and
     prune the dead entries. */
  const generation = (this.stopGenerations.get(conversationId) ?? 0) + 1;
  this.stopGenerations.set(conversationId, generation);
  for (const [id, at] of this.stopExempt)
    if (at.conversationId === conversationId && at.generation !== generation)
      this.stopExempt.delete(id);
  /* #403: arm the Stop's causal line before the park/fire decision —
     whichever path it takes, sends at or below `afterSeq` park wherever
     they surface. */
  if (afterSeq !== undefined) {
    const prev = this.stopSeqs.get(conversationId) ?? 0;
    if (afterSeq > prev) this.stopSeqs.set(conversationId, afterSeq);
  }
  const binding = this.bindings.get(conversationId);
  if (
    !binding ||
    (!binding.runningTurnId && this.sendCanProduceTurn(conversationId))
  ) {
    /* #400/#402: the UI already reads Running off the send-pending
       marker, so a Stop here is real, not stray — whether the send's
       row hasn't reached the `channelMessages` subscription yet, the
       relay's bus event beating the store path (#402), its first bind
       still mid-flight (#400), or it bound but its prompt hasn't become
       a turn on the engine — an interrupt dispatched in that last
       stretch overtakes `prompt` only to ack `interrupted:false` and
       die. Park on the conversation instead; the send's first
       `turn.started` fires it, when the engine provably has a turn to
       cancel. (A bound-and-idle conv has nothing pending: the Stop
       falls through and the engine acks `interrupted:false`, as
       before.) */
    if (binding) binding.stopRequested = true;
    this.pendingInterrupts.add(conversationId);
    this.opts.log.info("interrupt parked", { conversationId });
    return;
  }
  this.opts.log.info("interrupt requested", { conversationId });
  /* #315 AC-5: park everything still waiting while the stop propagates —
     even a queue item behind a sendPrompt gate must drop rather than
     prompt once the turn clears. */
  binding.stopRequested = true;
  /* #274: a sendPrompt still in its pre-dispatch awaits hasn't put
     `prompt` on the wire — an interrupt sent now overtakes it and the
     engine acks interrupted:false (no live turn), silently swallowing
     the Stop. Wait for in-flight sends to dispatch; the in-order conn
     then lands prompt → interrupt, so the engine has a turn to stop. */
  await Promise.all(binding.promptGates);
  const conn = this.engine;
  // A rebind may have swapped the binding while the gates were held.
  const live = this.bindings.get(conversationId);
  if (!conn || !live) return;
  try {
    await conn.request("interrupt", { sessionId: live.sessionId });
  } catch (error) {
    this.opts.log.warn("interrupt failed", { error: String(error) });
  }
}
