import type { AppMessage } from "@lilos/contracts/app";
import type { HarnessCtx } from "./ctx";

/**
 * message -> engine, in arrival order: per-conversation
 * delivery chains and the held-for-engine `early` queue (was the first
 * half of the `message -> engine` section of `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — bodies byte-identical except each signature gained
 * `export function` + a `this: HarnessCtx` first parameter — `this` is
 * still the Harness: these functions sit on `Harness.prototype` via the
 * `Object.assign` at the bottom of `../harness.ts`.
 */

/** Run `fn` after the conversation's earlier delivery work, in arrival order. */
export function ordered<T>(
  this: HarnessCtx,
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = this.deliveryChains.get(conversationId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tracked: Promise<void> = next.then(
    () => {},
    () => {},
  );
  this.deliveryChains.set(conversationId, tracked);
  void tracked.finally(() => {
    if (this.deliveryChains.get(conversationId) === tracked)
      this.deliveryChains.delete(conversationId);
  });
  return next;
}

export function deliver(this: HarnessCtx, message: AppMessage): Promise<void> {
  /* #377: sends for one conversation enqueue strictly in arrival order —
     without the chain, two sends' interleaved awaits can reach
     enqueueOrPrompt reversed and the later send prompts first. */
  const convId = message.conversationId;
  if (!convId || message.authorKind !== "user") return Promise.resolve();
  return this.ordered(convId, () => this.deliverOrdered(message));
}

export async function deliverOrdered(
  this: HarnessCtx,
  message: AppMessage,
): Promise<void> {
  if (message.authorKind !== "user") return;
  if (!message.conversationId) return;
  /* #315: a user-removed row must never reach the engine — not even via
     a replayed frame that predates the `message.changed` it carried.
     The row's own flags are checked too: they are the durable truth when
     a flag-flip frame never arrived on this socket (#377). */
  if (message.removed || message.dropped || message.rewound) return;
  if (this.dismissed.has(message.id)) return;
  if (this.delivered.has(message.id)) return;

  this.opts.log.info("user message", {
    conversationId: message.conversationId,
    messageId: message.id,
  });
  this.opts.onNeedEngine?.();
  const conv = await this.findConversation(message.conversationId);
  // Lookup failed (relay flapped mid-RPC): leave `delivered` unset so the
  // register-time pending list can redeliver the message later.
  if (!conv) return;
  if (conv.archived || conv.state === "closed") {
    this.opts.log.warn("dropping message for unknown/closed conversation", {
      conversationId: message.conversationId,
    });
    this.dropParkedInterruptIfOrphaned(conv.id);
    return;
  }
  this.delivered.add(message.id);
  /* Until the send lands in a tracked resting place (early/queue/
     consumed/steerPending) the in-flight marker is all that proves a
     turn is coming — `onInterruptRequested` and the orphan clear both
     read it. Released once, wherever the send ends up. */
  let inFlight = true;
  const releaseInFlight = () => {
    if (!inFlight) return;
    inFlight = false;
    const n = (this.inFlightDeliveries.get(conv.id) ?? 0) - 1;
    if (n > 0) this.inFlightDeliveries.set(conv.id, n);
    else this.inFlightDeliveries.delete(conv.id);
  };
  this.inFlightDeliveries.set(
    conv.id,
    (this.inFlightDeliveries.get(conv.id) ?? 0) + 1,
  );
  try {
    /* #288: the watermark applies before ANY binding work — a restart's
       channel replay re-delivers every already-delivered user message while
       the engine is down; binding for one would start a fresh session (or
       reattach) only to drop the message, and the held batch would re-prompt
       on that new session when the engine attaches. Nothing owed → no bind,
       no session.start, no prompt. */
    /* #315: the `redeliver` claim is one-shot — read it once for both
       watermark checks below, or the second guard swallows a Send. */
    const isRedeliver = this.redeliver.delete(message.id);
    const cur = this.conversationFromAtom(conv.id) ?? conv;
    if (message.seq <= cur.deliveredSeq && !isRedeliver) {
      releaseInFlight();
      this.dropParkedInterruptIfOrphaned(conv.id);
      return;
    }
    const binding = await this.bindingFor(conv, message.channelId);
    if (!binding) {
      // Engine still starting/restarting: hold the message; attachEngine
      // flushes this queue once a connection exists (the dedupe set above
      // would otherwise drop it forever).
      const waiting = this.early.get(conv.id) ?? [];
      waiting.push(message);
      this.early.set(conv.id, waiting);
      // The watermark already claimed this send — keep the claim alive so
      // the post-attach flush can't swallow it.
      if (isRedeliver) this.redeliver.add(message.id);
      this.opts.log.debug("message held for engine", {
        conversationId: conv.id,
        waiting: waiting.length,
      });
      return;
    }
    // Watermark guard: a redelivery (register pending list, channel replay)
    // of a message the engine already took must not prompt it again. The
    // `dismissed` head-check ran before the bind await — a rewind could have
    // killed the row in between, so it is checked again here.
    const fresh = this.conversationFromAtom(conv.id) ?? conv;
    if (
      (message.seq <= fresh.deliveredSeq && !isRedeliver) ||
      this.dismissed.has(message.id) ||
      binding.consumed.has(message.id)
    ) {
      releaseInFlight();
      this.dropParkedInterruptIfOrphaned(conv.id);
      return;
    }
    this.enqueueOrPrompt(binding, message);
  } finally {
    releaseInFlight();
  }
}

export async function flushEarly(
  this: HarnessCtx,
  convId: string,
): Promise<void> {
  /* Enqueues must still join the conversation's delivery order — a send
     that arrived while the engine was down lands ahead of anything sent
     since (#377). */
  await this.ordered(convId, () => this.flushEarlyOrdered(convId));
}

export async function flushEarlyOrdered(
  this: HarnessCtx,
  convId: string,
): Promise<void> {
  const waiting = this.early.get(convId);
  if (!waiting?.length) return;
  const conv = await this.findConversation(convId);
  if (!conv || conv.archived || conv.state === "closed") {
    this.early.delete(convId);
    return;
  }
  const binding = await this.bindingFor(conv, waiting[0]?.channelId ?? "");
  if (!binding) return; // engine went away again; next attach retries
  this.early.delete(convId);
  const fresh = this.conversationFromAtom(conv.id) ?? conv;
  for (const message of waiting) {
    /* #288: deliver()'s watermark guard, replayed for the held batch — a
       held message can sit at/below deliveredSeq (delivered on a previous
       engine attachment or via the register-time pending list while this
       one was queued). Never prompt it a second time. */
    if (
      this.dismissed.has(message.id) ||
      (message.seq <= fresh.deliveredSeq &&
        !this.redeliver.delete(message.id)) ||
      binding.consumed.has(message.id)
    )
      continue;
    this.enqueueOrPrompt(binding, message);
  }
}
