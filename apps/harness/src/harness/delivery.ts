import type { AppMessage } from "@lilos/contracts/app";
import type { HarnessCtx, SessionBinding } from "./ctx";
import { noteTaskWake } from "./task-wake";

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

/** The owner's sends start turns. A CEO wake does too, by the `ceoWake`
    flag: the text is what the model reads, and the flag is what delivers
    it (D-#777). A task wake is the same delivery for a child finish
    (D-#844). */
function promptsEngine(message: AppMessage): boolean {
  return (
    message.authorKind === "user" ||
    message.ceoWake === true ||
    message.taskWake === true
  );
}

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
  if (!convId || !promptsEngine(message)) return Promise.resolve();
  return this.ordered(convId, () => this.deliverOrdered(message));
}

export async function deliverOrdered(
  this: HarnessCtx,
  message: AppMessage,
): Promise<void> {
  if (!promptsEngine(message)) return;
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
    let binding: SessionBinding | undefined;
    try {
      binding = await this.bindingFor(conv, message.channelId);
    } catch (error) {
      /* A bind failure (a session.start timeout, an engine hiccup) is
         transient like an unattached engine — but the `delivered` claim
         is already made, so the send must land in a tracked resting
         place with a retry or it is silently eaten: every later delivery
         path dedupes on the claim and no turn ever runs. `early` holds
         it (the reaper reads it as turn-pending) while a bounded flush
         re-attempts the bind; past the cap the send surfaces as an
         engine error like a failed prompt. */
      this.opts.log.warn("bind failed; message held for retry", {
        conversationId: conv.id,
        messageId: message.id,
        error: String(error),
      });
      const waiting = this.early.get(conv.id) ?? [];
      waiting.push(message);
      this.early.set(conv.id, waiting);
      if (isRedeliver) this.redeliver.add(message.id);
      this.scheduleEarlyFlush(conv.id);
      return;
    }
    if (!binding) {
      const waiting = this.early.get(conv.id) ?? [];
      waiting.push(message);
      this.early.set(conv.id, waiting);
      // The watermark already claimed this send — keep the claim alive so
      // the post-attach flush can't swallow it.
      if (isRedeliver) this.redeliver.add(message.id);
      /* D-#761 review: the conv's runtime already reached a terminal
         `failed` — parking it behind a dead engine would sit forever
         (nothing re-drives a flush on a runtime that never connects).
         Surface it now, same as a failed prompt. */
      if (await this.runtimeFailedFor(conv)) {
        void this.dropEarlyWithError(conv.id).catch(() => {});
        return;
      }
      /* D-#866 r5: a conn that attached between the bind's conn-check and
         this park already swept `early` — and this park has no flush
         timer, so the send would sit forever. Re-check once; a conn that
         landed mid-await drives the flush now instead. */
      const runtime = await this.runtimeForConversation(conv);
      if (this.connForRuntime(runtime)) {
        void this.flushEarly(conv.id).catch((error) =>
          this.opts.log.warn("early message flush failed", {
            conversationId: conv.id,
            error: String(error),
          }),
        );
        return;
      }
      // Engine still starting/restarting: hold the message; attachEngine
      // flushes this queue once a connection exists (the dedupe set above
      // would otherwise drop it forever). If the start then fails the
      // `failed` state change drops the park with an error surface.
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

/** Retries for a send parked in `early` on a bind failure — short enough
    that a transient session.start stall costs one poll, capped so a
    dead engine surfaces the send as an engine error instead of parking
    it forever. */
const EARLY_FLUSH_RETRY_MS = 1_500;
const EARLY_FLUSH_RETRY_MAX = 5;

/** The stall shape that earns the macOS folder-consent hint: the ACP
    `session/new` bound specifically (the engine-acp timeout text), on
    an `acp:*` runtime. Narrowed in r6 — the r5 regex also matched the
    generic "could not be bound", so a Hermes drop carried Desktop-folder
    advice it could not use. Exported for the unit tests. */
export const acpStallShape = (detail: string, runtime: string): boolean =>
  runtime.startsWith("acp") && /did not answer session\/new/i.test(detail);

/**
 * Bounded re-attempt of the `early` flush for a send whose bind threw.
 * `attachEngine` already flushes on (re)connect; this covers the engine
 * staying attached while one bind RPC failed — a case nothing else
 * re-arms. At the cap the parked batch is dropped with the same surface
 * a failed prompt gets (system note + turnFailure → Retry), so the send
 * is never silent. */
export function scheduleEarlyFlush(this: HarnessCtx, convId: string): void {
  if (this.earlyFlushTimers.has(convId)) return;
  const attempts = (this.earlyFlushAttempts.get(convId) ?? 0) + 1;
  this.earlyFlushAttempts.set(convId, attempts);
  const timer = setTimeout(() => {
    this.earlyFlushTimers.delete(convId);
    void this.flushEarly(convId)
      .then(() => {
        /* Drained (or the conv went away): reset the budget. Still
           parked — decide whether more waiting can help. The conv
           gone (the employee was removed — D-#761 review) drops
           silently; its runtime terminally failed drops with the
           engine-error surface, no further polls; anything else is a
           transient start/restart — keep the bounded park. */
        if (!this.early.get(convId)?.length) {
          this.earlyFlushAttempts.delete(convId);
          return;
        }
        void (async () => {
          const conv = await this.findConversation(convId);
          if (!conv) {
            this.early.delete(convId);
            this.earlyFlushAttempts.delete(convId);
            await this.releaseIdleFailedRuntimes();
            return;
          }
          if (await this.runtimeFailedFor(conv)) {
            await this.dropEarlyWithError(convId).catch(() => {});
          } else this.scheduleEarlyFlush(convId);
        })().catch(() => {});
      })
      .catch((error) => {
        this.opts.log.warn("early flush retry failed", {
          conversationId: convId,
          attempt: attempts,
          error: String(error),
        });
        if (attempts >= EARLY_FLUSH_RETRY_MAX) {
          void this.dropEarlyWithError(convId).catch(() => {});
          return;
        }
        this.scheduleEarlyFlush(convId);
      });
  }, EARLY_FLUSH_RETRY_MS);
  this.earlyFlushTimers.set(convId, timer);
}

/** Retry budget spent — or the conv's runtime reached a terminal
    `failed` (D-#761 review): surface the parked batch as an engine
    error and stop holding it (the send keeps its `delivered` claim —
    it is settled like a failed prompt, not owed a later redelivery).
    A task child reports the failure to its parent as a failed task
    wake so the hand-off is not left waiting forever. */
export async function dropEarlyWithError(
  this: HarnessCtx,
  convId: string,
): Promise<void> {
  const waiting = this.early.get(convId);
  if (!waiting?.length) return;
  this.early.delete(convId);
  this.earlyFlushAttempts.delete(convId);
  const message = waiting[0];
  /* `findConversation`, not the atom: a just-hired child's row can lag
     the atom, and losing it here would lose the parent's failed wake. */
  /* D-#866 (r4): every step below must land independently — a throw in
     one used to be swallowed whole by the callers' `.catch(() => {})`,
     leaving the thread `idle` with no error surface. Each surface write
     gets its own catch + loud warn instead. */
  const conv = await this.findConversation(convId).catch((error) => {
    this.opts.log.warn("drop: conversation lookup failed", {
      conversationId: convId,
      error: String(error),
    });
    return undefined;
  });
  /* The reason the send died, most truthful first: a terminal runtime
     verdict, else the verbatim bind rejection, else the generic line. */
  let detail = "session could not be bound after several attempts";
  try {
    detail =
      (await this.runtimeFailureDetail(conv)) ??
      this.lastBindError.get(convId) ??
      detail;
  } catch (error) {
    this.opts.log.warn("drop: runtime failure detail lookup failed", {
      conversationId: convId,
      error: String(error),
    });
  }
  /* D-#866 r5/r6: a start-stall under the packaged app is most often
     macOS folder consent (TCC) parking the agent's child reads — the
     parked sends deserve the actionable line, not a bare "timed out".
     Likely cause, not a certainty: the real reason stays in the
     message. */
  {
    let label = "The agent";
    let runtime = "";
    try {
      runtime = conv ? await this.runtimeForConversation(conv) : "";
      label = this.runtimes?.get(runtime)?.spec.label || label;
    } catch {
      /* label lookup is cosmetic — keep the generic lead */
    }
    if (acpStallShape(detail, runtime)) {
      detail =
        `${label} didn't start in time — ${detail}. ` +
        `If macOS asked LilOS for access to a folder (Desktop, Documents), ` +
        `allow it in System Settings → Privacy & Security → Files and ` +
        `Folders, then send again.`;
    }
  }
  this.opts.log.error("dropping held messages: engine could not start", {
    conversationId: convId,
    count: waiting.length,
    detail,
  });
  await this.postSystem(
    { channelId: message.channelId, conversationId: convId },
    `Engine error: ${detail}`,
    `sys:${convId}:${message.id}:engine-error`,
  ).catch((error) =>
    this.opts.log.warn("drop: system error post failed", {
      conversationId: convId,
      error: String(error),
    }),
  );
  await this.updateConversation(convId, {
    turnFailure: { kind: "generic", text: `Engine error: ${detail}` },
  }).catch((error) =>
    this.opts.log.warn("drop: failed-turn surface write failed", {
      conversationId: convId,
      error: String(error),
    }),
  );
  /* A hand-off child whose engine never started still owes its parent
     a wake — otherwise the ticket waits on a turn that can never run. */
  if (conv?.parentId && conv.ticketId) {
    try {
      noteTaskWake(this, {
        taskId: conv.ticketId,
        turnId: `bind:${convId}:${message.id}`,
        outcome: "failed",
        result: `Engine error: ${detail}`,
      });
    } catch (error) {
      this.opts.log.warn("drop: parent wake failed", {
        conversationId: convId,
        error: String(error),
      });
    }
  }
  /* The drop may have been this runtime's last demand — idle its
     failed row instead of supervising a dead engine forever. */
  await this.releaseIdleFailedRuntimes().catch((error) =>
    this.opts.log.warn("drop: failed-runtime release failed", {
      conversationId: convId,
      error: String(error),
    }),
  );
}
