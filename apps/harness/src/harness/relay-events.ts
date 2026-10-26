import {
  type AppMessage,
  AskResolvedEvent,
  ChannelCreatedEvent,
  ChannelRemovedEvent,
  ConversationModelRequestedEvent,
  ConversationRewoundEvent,
  ConversationUpdatedEvent,
  EmployeeRemovedEvent,
  MessageChangedEvent,
  ScheduleRemovedEvent,
  ScheduleUpsertedEvent,
  TicketUpsertedEvent,
  TurnInterruptRequestedEvent,
} from "@lilos/contracts/app";
import { CONNECT_APPROVAL_KEY } from "../connect";
import {
  ceoOnAsk,
  ceoOnConversation,
  ceoOnSettings,
  ceoOnTicket,
} from "./ceo-loop";
import type { HarnessCtx } from "./ctx";

/**
 * relay -> engine: the `onRelayEvent` switch — channel
 * lifecycle, ask resolves, message flag changes, interrupts, model
 * picks (was the notification half of the `relay -> engine` section of
 * `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — bodies byte-identical except each signature gained
 * `export function` + a `this: HarnessCtx` first parameter — `this` is
 * still the Harness: these functions sit on `Harness.prototype` via the
 * `Object.assign` at the bottom of `../harness.ts`.
 */

/** Relay notifications that have no atom (asks, interrupts, channel lifecycle). */
export function onRelayEvent(
  this: HarnessCtx,
  method: string,
  params: Record<string, unknown>,
) {
  switch (method) {
    case "channel.created": {
      const parsed = ChannelCreatedEvent.safeParse(params);
      if (parsed.success) this.watchChannel(parsed.data.channel.id);
      break;
    }
    case "channel.removed": {
      const parsed = ChannelRemovedEvent.safeParse(params);
      if (parsed.success) void this.onChannelRemoved(parsed.data.channelId);
      break;
    }
    case "settings.changed": {
      // #339: the Connect step's one-time approval toggles the reconciler.
      if (params.key === CONNECT_APPROVAL_KEY)
        void this.opts.connect?.reconcile();
      ceoOnSettings(this, params);
      break;
    }
    case "employee.upserted": {
      // D-#817: one Connect approval covers a later hire. This reconcile
      // copies the shipped plugin (content hash, not plugin.yaml version).
      // A pass already running queues one follow-up instead of dropping
      // the hire; bind awaits reconcile before the first session.start.
      void this.opts.connect?.reconcile();
      break;
    }
    case "employee.removed": {
      // Disable the leaving employee's plugin — never delete the profile.
      const parsed = EmployeeRemovedEvent.safeParse(params);
      if (parsed.success) {
        this.opts.connect?.employeeRemoved(parsed.data.employeeId);
        /* The relay cascade-deleted the employee's tasks without per-task
           events — drop them here or they fire `channels.openDm` on a dead
           employee every tick until restart. */
        this.scheduler.removeEmployeeTasks(parsed.data.employeeId);
        for (const taskId of this.scheduledRunsInFlight.keys()) {
          if (this.scheduler.getTask(taskId) === undefined)
            this.scheduledRunsInFlight.delete(taskId);
        }
        void this.opts.connect?.reconcile();
      }
      break;
    }
    case "ask.resolved": {
      const parsed = AskResolvedEvent.safeParse(params);
      if (parsed.success) {
        ceoOnAsk(this, parsed.data.ask);
        void this.onAskResolved(parsed.data.ask).catch((error) =>
          this.opts.log.warn("ask respond forward failed", {
            askId: parsed.data.ask.id,
            error: String(error),
          }),
        );
      }
      break;
    }
    case "schedule.upserted": {
      const parsed = ScheduleUpsertedEvent.safeParse(params);
      if (parsed.success) void this.onScheduleUpserted(parsed.data.task);
      break;
    }
    case "schedule.removed": {
      const parsed = ScheduleRemovedEvent.safeParse(params);
      if (parsed.success) this.onScheduleRemoved(parsed.data.taskId);
      break;
    }
    case "ticket.upserted": {
      // D-#777: a ticket finishing (not by the CEO) wakes the standing thread.
      const parsed = TicketUpsertedEvent.safeParse(params);
      if (parsed.success)
        ceoOnTicket(this, parsed.data.ticket, parsed.data.actorId);
      break;
    }
    case "conversation.updated": {
      // User-initiated rename/archive (host writes only touch
      // engineRef/state/deliveredSeq): mirror onto the engine session when
      // it advertises `session_meta` (#28 AC-3).
      const parsed = ConversationUpdatedEvent.safeParse(params);
      if (!parsed.success) break;
      const conv = parsed.data.conversation;
      ceoOnConversation(this, conv);
      void this.onScheduledConversationUpdate(conv);
      const seen = this.metaSeen.get(conv.id);
      const binding = this.bindings.get(conv.id);
      /* #106 AC-1: a pill switch lands mid-turn — the very next
         request.opened routes on the fresh level, and the live session
         gets the hint when the engine declares approval_policy.
         D-#866 r3: the binding's access tracks what the ENGINE applied —
         it advances only when setAccess lands, so a failure keeps the
         stale value (the next conversation.updated retries the flip)
         and posts the reason into the thread: a session that could not
         be re-gated must never look like a successful ask flip. */
      if (binding && conv.access !== binding.access) {
        const conn = this.connFor(binding);
        if (conn && this.hasCapabilityFor(binding.runtime, "approval_policy")) {
          void conn
            .request("session.setAccess", {
              sessionId: binding.sessionId,
              access: conv.access,
            })
            .then(() => {
              binding.access = conv.access;
            })
            .catch(async (error) => {
              this.opts.log.warn("session.setAccess failed", {
                error: String(error),
              });
              const reason =
                error instanceof Error ? error.message : String(error);
              await this.postSystem(
                { channelId: binding.channelId, conversationId: conv.id },
                `Couldn't switch this thread to ${
                  conv.access === "ask" ? "Ask" : "Full"
                } access — ${reason}. The agent keeps its current level; ` +
                  `send again or flip the access pill once more to retry.`,
                `sys:${conv.id}:access-flip`,
              ).catch((e) =>
                this.opts.log.warn("access-flip error post failed", {
                  error: String(e),
                }),
              );
            });
        } else {
          binding.access = conv.access;
        }
      }
      if (!binding) {
        // No session yet — record the baseline so a later event diffs right.
        if (!seen) {
          this.metaSeen.set(conv.id, {
            title: conv.title,
            archived: conv.archived,
            titleSource: conv.titleSource,
          });
        }
        break;
      }
      if (
        seen &&
        seen.title === conv.title &&
        seen.archived === conv.archived &&
        seen.titleSource === conv.titleSource
      ) {
        break;
      }
      this.mirrorMeta(binding, conv);
      break;
    }
    case "message.changed": {
      /* #315: a tray action flipped `dropped`/`removed` on the relay.
         removed → the engine must never see it: splice it out of every
         in-memory hold and dismiss it permanently. dropped → park it
         out of the queue (re-Send re-delivers it fresh below). */
      const parsed = MessageChangedEvent.safeParse(params);
      if (!parsed.success) break;
      const message = parsed.data.message;
      const binding = message.conversationId
        ? this.bindings.get(message.conversationId)
        : undefined;
      const fromQueue = (list: AppMessage[]) =>
        list.filter((m) => m.id !== message.id);
      if (message.removed) {
        this.dismissed.add(message.id);
        this.delivered.delete(message.id);
        if (binding) {
          binding.queue = fromQueue(binding.queue);
          binding.steerPending = binding.steerPending.filter(
            (s) => s.messageId !== message.id,
          );
          binding.consumed.delete(message.id);
        }
        const early = this.early.get(message.conversationId ?? "");
        if (early?.length)
          this.early.set(message.conversationId ?? "", fromQueue(early));
        /* The send a parked interrupt waited on is gone — clear it
           instead of firing it on a later unrelated turn (#402). */
        this.dropParkedInterruptIfOrphaned(message.conversationId);
      } else if (message.dropped) {
        if (binding) {
          binding.queue = fromQueue(binding.queue);
          binding.steerPending = binding.steerPending.filter(
            (s) => s.messageId !== message.id,
          );
          binding.consumed.delete(message.id);
        }
        const early = this.early.get(message.conversationId ?? "");
        if (early?.length)
          this.early.set(message.conversationId ?? "", fromQueue(early));
        this.dropParkedInterruptIfOrphaned(message.conversationId);
        /* A later Send re-delivers: release the delivery claim AND let it
           past the deliveredSeq watermark (an accepted-then-parked steer
           sits under it). */
        this.delivered.delete(message.id);
        this.redeliver.add(message.id);
      } else if (
        /* #403: the frame itself says whether `dropped` flipped — a
           claimed-only change (our own `messages.claim`/unclaim, #377)
           is lane bookkeeping, never a Send, so it can't re-deliver
           even when `redeliver`/`dismissed` happen to hold the id. */
        (parsed.data.flags === undefined ||
          parsed.data.flags.includes("dropped")) &&
        (this.dismissed.has(message.id) || this.redeliver.has(message.id))
      ) {
        /* `dropped` cleared (Send): re-deliver like a fresh send. Only a
           row that was parked here (`dismissed`) or seen dropped
           (`redeliver`, primed in the branch above) can un-drop — other
           `message.changed` frames (e.g. our own `messages.claim`,
           #377) carry no drop to undo, and re-delivering them would
           queue the same send twice behind a re-queue. The `redeliver`
           claim was primed when the drop was parked; if the flag flip
           arrives without a local drop (another client undid it), arm
           it here so the watermark can't swallow the resend. */
        this.dismissed.delete(message.id);
        this.delivered.delete(message.id);
        this.redeliver.add(message.id);
        /* #403: a Send is new intent — exempt the row from the Stop
           generation that parked it or it would park right back. The
           next interrupt bumps the generation and the exemption
           lapses: that Stop owns the send like any other row. */
        if (message.conversationId) {
          this.stopExempt.set(message.id, {
            conversationId: message.conversationId,
            generation: this.stopGenerations.get(message.conversationId) ?? 0,
          });
        }
        void this.deliver(message).catch((error) =>
          this.opts.log.warn("message resend failed", {
            error: String(error),
          }),
        );
      }
      break;
    }
    case "conversation.rewound": {
      /* #400: the relay marks the rewound tail in one batch — no per-message
         `message.changed` fires — so fold its removedIds into the same
         kill-set those events feed. A `deliver` still in flight when the
         host-side handler pruned `early`/`queue` lands past the prune;
         every later gate (early flush, enqueue, register pending) consults
         `dismissed`, and re-splicing the holds here removes what slipped
         in between. */
      const parsed = ConversationRewoundEvent.safeParse(params);
      if (!parsed.success) break;
      const { conversationId, removedIds } = parsed.data;
      const binding = conversationId
        ? this.bindings.get(conversationId)
        : undefined;
      const holds = (list: AppMessage[]) =>
        list.filter((m) => !removedIds.includes(m.id));
      for (const removedId of removedIds) {
        this.dismissed.add(removedId);
        this.delivered.delete(removedId);
        if (binding) {
          binding.consumed.delete(removedId);
          binding.steerPending = binding.steerPending.filter(
            (s) => s.messageId !== removedId,
          );
        }
      }
      if (binding) binding.queue = holds(binding.queue);
      const early = this.early.get(conversationId ?? "");
      if (early?.length) this.early.set(conversationId ?? "", holds(early));
      this.dropParkedInterruptIfOrphaned(conversationId);
      break;
    }
    case "turn.interruptRequested": {
      const parsed = TurnInterruptRequestedEvent.safeParse(params);
      if (parsed.success) {
        void this.onInterruptRequested(
          parsed.data.conversationId,
          parsed.data.afterSeq,
        );
      }
      break;
    }
    case "conversation.modelRequested": {
      const parsed = ConversationModelRequestedEvent.safeParse(params);
      if (parsed.success) {
        const { conversationId } = parsed.data;
        // Serialize picks per conversation: a slow ack (confirm_required,
        // deferred-while-running) would otherwise let an earlier pick's
        // ack overwrite the last one — last-ack-wins must mean last-sent.
        const prev =
          this.modelPickQueue.get(conversationId) ?? Promise.resolve();
        const next = prev.then(() =>
          this.onModelRequested(conversationId, {
            model: parsed.data.model,
            provider: parsed.data.provider,
            effort: parsed.data.effort,
            fast: parsed.data.fast,
          }),
        );
        this.modelPickQueue.set(
          conversationId,
          next.catch(() => {}),
        );
        void next;
      }
      break;
    }
    default:
      break;
  }
}

/**
 * `channel.removed` (an employee was removed): stop the bound engine
 * session, drop bindings, queued early messages, asks and the watch.
 */
export async function onChannelRemoved(this: HarnessCtx, channelId: string) {
  this.channelWatch.get(channelId)?.();
  this.channelWatch.delete(channelId);
  this.channelSeen.delete(channelId);
  for (const binding of [...this.bindings.values()]) {
    if (binding.channelId !== channelId) continue;
    /* D-#761: the employee's sessions live on ITS runtime — stop them on
       the engine that owns them, not a global conn. */
    const conn = this.connFor(binding);
    this.unbind(binding);
    this.early.delete(binding.conversationId);
    this.pendingInterrupts.delete(binding.conversationId);
    this.stopSeqs.delete(binding.conversationId);
    this.stopGenerations.delete(binding.conversationId);
    for (const [id, at] of this.stopExempt)
      if (at.conversationId === binding.conversationId)
        this.stopExempt.delete(id);
    for (const key of [...this.askByRequest.keys()]) {
      if (
        key.startsWith(
          `${this.sessionKey(binding.runtime, binding.sessionId)}:`,
        )
      ) {
        const askId = this.askByRequest.get(key);
        this.askByRequest.delete(key);
        if (askId) this.requestByAsk.delete(askId);
      }
    }
    if (conn) {
      try {
        await conn.request("session.stop", { sessionId: binding.sessionId });
      } catch (error) {
        this.opts.log.warn("session.stop on removed channel failed", {
          sessionId: binding.sessionId,
          error: String(error),
        });
      }
    }
  }
}

export function watchChannel(this: HarnessCtx, channelId: string) {
  if (this.channelSeen.has(channelId)) return;
  this.channelSeen.set(channelId, 0);
  const store = this.opts.relay.channelMessages(channelId);
  const unsub = store.subscribe((state) => {
    const seen = this.channelSeen.get(channelId) ?? 0;
    const fresh = state.messages.filter((m) => m.seq > seen);
    if (fresh.length === 0) return;
    this.channelSeen.set(channelId, Math.max(...fresh.map((m) => m.seq)));
    for (const message of fresh) {
      void this.deliver(message).catch((error) =>
        this.opts.log.error("delivery failed", {
          messageId: message.id,
          error: String(error),
        }),
      );
    }
  });
  this.channelWatch.set(channelId, unsub);
  this.unsubs.push(unsub);
}
