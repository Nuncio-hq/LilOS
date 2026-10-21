import type {
  Ask,
  Conversation,
  ScheduledTask,
  SettingsGetResult,
  Ticket,
} from "@lilos/contracts/app";
import { CEO_SETTING_KEY, CEO_THREAD_KEY } from "@lilos/contracts/app";
import {
  CEO_WAKE_COALESCE_MS,
  type CeoWakeEvent,
} from "@lilos/contracts/harness";
import { deliverCeoWake } from "./ceo-deliver";
import {
  ceoBusy,
  ceoLoop,
  ceoLoopOf,
  dropTimer,
  forgetStanding,
} from "./ceo-state";
import type { HarnessCtx, SessionBinding } from "./ctx";

/**
 * The CEO loop (D-#777). Wakes land in one standing thread for the whole
 * company, not one thread per goal and not a fresh thread per wake: a
 * coalesced wake can name a finish on one ticket and a stuck thread on
 * another, and that turn has to live in one place. The owner's own chat
 * with the CEO is a normal message; later heartbeats reuse this thread.
 *
 * This file decides when a wake is queued and when it may leave.
 * Posting it is `ceo-deliver.ts`.
 *
 * The CEO's own ticket writes carry `actorId` and are dropped. A stuck
 * thread of the CEO's own is skipped so the standing thread cannot wake
 * itself. With no CEO, the queue is cleared and nothing is delivered.
 * A holder change forgets the previous thread: a dedupe key is not used,
 * because a hit would return the old row and drop the wake.
 */

export function ceoLoopReady(ctx: HarnessCtx): Promise<void> {
  return ceoLoop(ctx).ready;
}

export function wireCeoLoop(ctx: HarnessCtx): void {
  const state = ceoLoop(ctx);
  void (async () => {
    try {
      const ceo = await ctx.opts.relay.request<SettingsGetResult>(
        "settings.get",
        { key: CEO_SETTING_KEY },
      );
      const thread = await ctx.opts.relay.request<SettingsGetResult>(
        "settings.get",
        { key: CEO_THREAD_KEY },
      );
      if (state.touched) return;
      state.ceoId =
        typeof ceo.value === "string" && ceo.value ? ceo.value : null;
      if (typeof thread.value === "string" && thread.value)
        state.threadId = thread.value;
      state.touched = true;
    } catch (error) {
      ctx.opts.log.warn("ceo loop settings failed", { error: String(error) });
    } finally {
      state.resolveReady();
    }
  })();
}

/** Drop the timer. `Harness.stop` calls this so a quiet wake cannot fire
    after the process has closed the relay. */
export function stopCeoLoop(ctx: HarnessCtx): void {
  const state = ceoLoopOf(ctx);
  if (!state) return;
  dropTimer(state);
}

export function ceoOnSettings(
  ctx: HarnessCtx,
  params: { key?: unknown; value?: unknown },
): void {
  if (params.key !== CEO_SETTING_KEY) return;
  const state = ceoLoop(ctx);
  const next =
    typeof params.value === "string" && params.value ? params.value : null;
  state.resolveReady();
  state.touched = true;
  if (next === state.ceoId) return;
  const had = state.ceoId;
  state.ceoId = next;
  /* The first holder is not a change: the load may still be writing the
     standing thread. A later holder, or a cleared seat, starts clean. */
  if (had === null) return;
  forgetStanding(state);
  dropTimer(state);
  state.wakes.clear();
  state.wakes.fail();
  void ctx.opts.relay
    .request("settings.set", { key: CEO_THREAD_KEY, value: null })
    .catch((error) =>
      ctx.opts.log.warn("ceo thread clear failed", { error: String(error) }),
    );
}

export async function noteCeoWake(
  ctx: HarnessCtx,
  event: Omit<CeoWakeEvent, "at"> & { at?: number },
): Promise<void> {
  const state = ceoLoop(ctx);
  await state.ready;
  const outcome = state.wakes.note(
    { ...event, at: event.at ?? Date.now() },
    state.ceoId,
  );
  if (outcome !== "queued") return;
  arm(ctx);
}

function arm(ctx: HarnessCtx): void {
  const state = ceoLoop(ctx);
  if (state.wakes.isRunning || state.timer) return;
  const wait = state.wakes.remaining(Date.now());
  const timer = setTimeout(() => {
    state.timer = undefined;
    void flush(ctx);
  }, wait);
  if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
  state.timer = timer;
}

async function flush(ctx: HarnessCtx): Promise<void> {
  const state = ceoLoop(ctx);
  await state.ready;
  if (!state.ceoId) {
    dropTimer(state);
    state.wakes.clear();
    state.wakes.fail();
    return;
  }
  /* Leave the batch pending. The idle edge is what polls it. */
  if (ceoBusy(ctx, state)) return;
  const batch = state.wakes.poll(Date.now());
  if (!batch) {
    if (state.wakes.hasPending && !state.wakes.isRunning) arm(ctx);
    return;
  }
  if (ceoBusy(ctx, state)) {
    state.wakes.hold(batch, Date.now());
    return;
  }
  await runDeliver(ctx, batch);
}

async function runDeliver(
  ctx: HarnessCtx,
  batch: CeoWakeEvent[],
): Promise<void> {
  const state = ceoLoop(ctx);
  try {
    await deliverCeoWake(ctx, batch);
  } catch (error) {
    state.wakes.restore(batch, Date.now());
    ctx.opts.log.warn("ceo wake failed", { error: String(error) });
    if (state.wakes.hasPending) arm(ctx);
  }
}

/** A worker's turn just finished and the ticket is still open because
    this turn never called `ticket_update`. One wake per that edge, not
    for the CEO's own threads. Coalesced with everything else (D-#777). */
function noteWorkerFinished(ctx: HarnessCtx, conv: Conversation): void {
  const prev = ctx.conversationFromAtom(conv.id);
  if (prev?.state !== "active" || conv.state !== "idle") return;
  if (!conv.ticketId || conv.ceoThread) return;
  const state = ceoLoop(ctx);
  if (state.threadId && conv.id === state.threadId) return;
  const binding = ctx.bindings.get(conv.id);
  const touched = binding?.ticketTouched === true;
  if (binding) binding.ticketTouched = false;
  if (touched) return;
  const employeeId = binding?.employeeId ?? ctx.employeeIdFor(conv);
  if (state.ceoId && employeeId === state.ceoId) return;
  const ticket = ctx.opts.relay.tickets
    .get()
    .find((t) => t.id === conv.ticketId);
  if (!ticket || ticket.status === "done" || ticket.status === "failed") return;
  void noteCeoWake(ctx, { reason: "open", ticketId: conv.ticketId });
}

export function ceoOnConversation(ctx: HarnessCtx, conv: Conversation): void {
  noteWorkerFinished(ctx, conv);
  const state = ceoLoop(ctx);
  const opening =
    state.openingChannelId !== undefined &&
    conv.channelId === state.openingChannelId &&
    conv.title === "CEO";
  if (state.threadId) {
    if (conv.id !== state.threadId) return;
  } else if (opening) {
    state.threadId = conv.id;
  } else {
    return;
  }
  if (conv.state === "active") {
    state.sawActive = true;
    return;
  }
  if (conv.state !== "idle" && conv.state !== "closed") return;
  /* The prompt failed before `turn.started`, so this thread never went
     active. The queue still has to leave `running` (D-#777). */
  if (
    state.wakes.isRunning &&
    !state.sawActive &&
    conv.turnFailure &&
    conv.turnFailure.text !== state.failureAtDeliver
  ) {
    state.failureAtDeliver = conv.turnFailure.text;
    const next = state.wakes.settled();
    if (next) void runDeliver(ctx, next);
    return;
  }
  if (state.sawActive && state.wakes.isRunning) {
    state.sawActive = false;
    const next = state.wakes.settled();
    if (next) void runDeliver(ctx, next);
    return;
  }
  /* A wake that arrived while this thread was already running waits
     here, not on the coalesce timer. */
  if (state.wakes.hasPending && !state.wakes.isRunning) void flush(ctx);
}

/** A ticket that just became done. Waiters still in the atom (the event
    lands before the store updates) are the next hand. */
export function ceoOnTicket(
  ctx: HarnessCtx,
  ticket: Ticket,
  actorId?: string,
): void {
  const prev = ctx.opts.relay.tickets.get().find((t) => t.id === ticket.id);
  if (ticket.status !== "done" || prev?.status === "done") return;
  const next = ctx.opts.relay.tickets
    .get()
    .filter(
      (t) =>
        t.id !== ticket.id &&
        t.waitingOn?.kind === "ticket" &&
        t.waitingOn.ticketId === ticket.id &&
        t.ownerId !== undefined &&
        t.status !== "done",
    )
    .map((t) => ({ ticketId: t.id, ownerId: t.ownerId as string }));
  void noteCeoWake(ctx, {
    reason: "done",
    ticketId: ticket.id,
    ...(ticket.goalId ? { goalId: ticket.goalId } : {}),
    ...(actorId ? { actorId } : {}),
    ...(next.length > 0 ? { next } : {}),
  });
}

/** A stuck thread that is not the CEO's own. Prefer a worker who is
    neither the CEO nor the owner. The CEO is the last resort, and the
    wake says so (D-#777). */
export async function ceoOnStuck(
  ctx: HarnessCtx,
  binding: SessionBinding,
): Promise<void> {
  const state = ceoLoop(ctx);
  await state.ready;
  const conv = ctx.conversationFromAtom(binding.conversationId);
  const employeeId = binding.employeeId ?? ctx.employeeIdFor(conv);
  if (!conv?.ticketId || !employeeId) return;
  if (state.threadId && conv.id === state.threadId) return;
  if (state.ceoId && employeeId === state.ceoId) return;
  const employees = ctx.opts.relay.employees.get();
  const other = employees.find(
    (e) => e.id !== employeeId && e.id !== state.ceoId,
  );
  const lastResort = !other && !!state.ceoId && state.ceoId !== employeeId;
  const handTo = other?.id ?? (lastResort ? state.ceoId : undefined);
  if (!handTo) return;
  const handName = other?.name?.replace(/\s+/g, " ").trim();
  await noteCeoWake(ctx, {
    reason: "stuck",
    ticketId: conv.ticketId,
    handTo,
    ...(handName ? { handName } : {}),
    ...(lastResort ? { lastResort: true } : {}),
  });
}

export function ceoOnAsk(ctx: HarnessCtx, ask: Ask): void {
  /* A cancelled ask is not news. The CEO's own thread is not either:
     that would wake the standing thread from itself. */
  if (ask.outcome === "cancel") return;
  const state = ceoLoop(ctx);
  if (state.threadId && ask.conversationId === state.threadId) return;
  const conv = ctx.conversationFromAtom(ask.conversationId);
  if (!conv?.ticketId) return;
  const employeeId = ctx.employeeIdFor(conv);
  if (state.ceoId && employeeId === state.ceoId) return;
  void noteCeoWake(ctx, { reason: "ask", ticketId: conv.ticketId });
}

/**
 * A schedule whose employee holds the CEO seat becomes a wake, not a
 * second thread. Returns true when the slot was consumed that way.
 * `lastFiredAt` is written when that wake is delivered, not here: a
 * restart inside the coalesce window must still fire it. `lastRun`
 * stays unset — pointing it at the standing thread would make the
 * scheduler skip later slots whenever that thread is active.
 */
export async function routeCeoSchedule(
  ctx: HarnessCtx,
  task: ScheduledTask,
): Promise<boolean> {
  const state = ceoLoop(ctx);
  await state.ready;
  if (!state.ceoId || task.employeeId !== state.ceoId) return false;
  await noteCeoWake(ctx, {
    reason: "schedule",
    text: `${task.name}: ${task.prompt}`,
    taskId: task.id,
  });
  return true;
}

export { CEO_WAKE_COALESCE_MS };
