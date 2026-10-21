import type {
  AppChannel,
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
  CeoWakes,
  formatCeoWake,
} from "@lilos/contracts/harness";
import type { HarnessCtx, SessionBinding } from "./ctx";

/**
 * The CEO loop (D-#777). Wakes land in one standing thread for the whole
 * company, not one thread per goal and not a fresh thread per wake: a
 * coalesced wake can name a finish on one ticket and a stuck thread on
 * another, and that turn has to live in one place. The owner's own chat
 * with the CEO is a normal message; later heartbeats reuse this thread.
 *
 * A wake is a system note. The engine still reads the machine lines; the
 * thread shows the short "LilOS:" line. The title is the user's ("CEO"),
 * so the engine's auto-title cannot rename it.
 *
 * The CEO's own ticket writes carry `actorId` and are dropped. A stuck
 * thread of the CEO's own is skipped so the standing thread cannot wake
 * itself. With no CEO, the queue is cleared and nothing is delivered.
 * A holder change forgets the previous thread: a dedupe key is not used,
 * because a hit would return the old row and drop the wake.
 */

interface Loop {
  wakes: CeoWakes;
  timer?: ReturnType<typeof setTimeout>;
  threadId?: string;
  /** Channel of a standing thread being opened, before its id is known. */
  openingChannelId?: string;
  ceoId: string | null;
  /** Set once settings have named the holder, so a late load cannot
      overwrite a change that landed while the first read was in flight. */
  touched: boolean;
  sawActive: boolean;
  ready: Promise<void>;
  resolveReady: () => void;
}

const loops = new WeakMap<HarnessCtx, Loop>();

function loop(ctx: HarnessCtx): Loop {
  let found = loops.get(ctx);
  if (!found) {
    let resolveReady = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    found = {
      wakes: new CeoWakes(),
      ceoId: null,
      touched: false,
      sawActive: false,
      ready,
      resolveReady,
    };
    loops.set(ctx, found);
  }
  return found;
}

export function ceoLoopReady(ctx: HarnessCtx): Promise<void> {
  return loop(ctx).ready;
}

export function wireCeoLoop(ctx: HarnessCtx): void {
  const state = loop(ctx);
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
  const state = loops.get(ctx);
  if (!state?.timer) return;
  clearTimeout(state.timer);
  state.timer = undefined;
}

function dropTimer(state: Loop): void {
  if (!state.timer) return;
  clearTimeout(state.timer);
  state.timer = undefined;
}

function forgetStanding(state: Loop): void {
  state.threadId = undefined;
  state.openingChannelId = undefined;
  state.sawActive = false;
}

export function ceoOnSettings(
  ctx: HarnessCtx,
  params: { key?: unknown; value?: unknown },
): void {
  if (params.key !== CEO_SETTING_KEY) return;
  const state = loop(ctx);
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
  const state = loop(ctx);
  await state.ready;
  const outcome = state.wakes.note(
    { ...event, at: event.at ?? Date.now() },
    state.ceoId,
  );
  if (outcome !== "queued") return;
  arm(ctx);
}

function arm(ctx: HarnessCtx): void {
  const state = loop(ctx);
  if (state.wakes.isRunning || state.timer) return;
  const wait = state.wakes.remaining(Date.now());
  const timer = setTimeout(() => {
    state.timer = undefined;
    void flush(ctx);
  }, wait);
  if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
  state.timer = timer;
}

/** Busy means a send now would join a turn already going: the row is
    active, a prompt is in flight, or the binding still holds a queue.
    Not only a turn this loop started — the owner's own message counts. */
function ceoBusy(ctx: HarnessCtx, state: Loop): boolean {
  if (state.openingChannelId) return true;
  const id = state.threadId;
  if (!id) return false;
  if ((ctx.inFlightDeliveries.get(id) ?? 0) > 0) return true;
  const binding = ctx.bindings.get(id);
  if (
    binding &&
    (binding.runningTurnId ||
      binding.queue.length > 0 ||
      binding.inflightPrompts.size > 0)
  ) {
    return true;
  }
  return ctx.conversationFromAtom(id)?.state === "active";
}

function standingThread(
  ctx: HarnessCtx,
  state: Loop,
  ceoId: string,
): Conversation | undefined {
  if (!state.threadId) return undefined;
  const current = ctx.conversationFromAtom(state.threadId);
  if (!current || current.archived) return undefined;
  /* A holder change must not post into the previous CEO's thread. */
  if (ctx.employeeIdFor(current) !== ceoId) return undefined;
  return current;
}

async function flush(ctx: HarnessCtx): Promise<void> {
  const state = loop(ctx);
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
  const state = loop(ctx);
  try {
    await deliver(ctx, batch);
  } catch (error) {
    state.wakes.restore(batch, Date.now());
    ctx.opts.log.warn("ceo wake failed", { error: String(error) });
    if (state.wakes.hasPending) arm(ctx);
  }
}

async function stampFired(
  ctx: HarnessCtx,
  events: readonly CeoWakeEvent[],
): Promise<void> {
  const at = Date.now();
  for (const event of events) {
    if (event.reason !== "schedule" || !event.taskId) continue;
    await ctx.opts.relay.request("schedules.update", {
      id: event.taskId,
      lastFiredAt: at,
      skippedAt: null,
    });
  }
}

async function deliver(ctx: HarnessCtx, events: CeoWakeEvent[]): Promise<void> {
  const state = loop(ctx);
  const ceoId = state.ceoId;
  if (!ceoId) {
    state.wakes.fail();
    return;
  }
  const text = formatCeoWake(events);
  const current = standingThread(ctx, state, ceoId);
  if (!current && state.threadId) forgetStanding(state);
  if (current) {
    state.sawActive = false;
    await ctx.opts.relay.request("messages.post", {
      channelId: current.channelId,
      conversationId: current.id,
      text,
      authorId: "system",
      authorKind: "system",
    });
    await stampFired(ctx, events);
    return;
  }
  let channel = ctx.opts.relay.channels
    .get()
    .find((c: AppChannel) => c.kind === "dm" && c.employeeId === ceoId);
  if (!channel) {
    const opened = await ctx.opts.relay.request<{ channel: AppChannel }>(
      "channels.openDm",
      { employeeId: ceoId },
    );
    channel = opened.channel;
  }
  /* Events for this open can arrive before the request returns. Match
     them on the channel until the id is known, and don't treat the
     row's first idle as the turn ending. No dedupe key: a hit returns
     the stored thread and does not post this wake, which wedges the
     queue (D-#777). */
  state.sawActive = false;
  state.openingChannelId = channel.id;
  const opened = await ctx.opts.relay.request<{ conversation: Conversation }>(
    "conversations.open",
    {
      channelId: channel.id,
      text,
      title: "CEO",
      titleSource: "user",
      authorId: "system",
      authorKind: "system",
    },
  );
  state.openingChannelId = undefined;
  state.threadId = opened.conversation.id;
  await ctx.opts.relay.request("settings.set", {
    key: CEO_THREAD_KEY,
    value: opened.conversation.id,
  });
  await stampFired(ctx, events);
  /* A turn that finished before this returned already went idle. The
     event landed first and sawActive is set; release the queue here. */
  const fresh = ctx.conversationFromAtom(opened.conversation.id);
  if (
    fresh &&
    (fresh.state === "idle" || fresh.state === "closed") &&
    state.sawActive &&
    state.wakes.isRunning
  ) {
    state.sawActive = false;
    const next = state.wakes.settled();
    if (next) await deliver(ctx, next);
  }
}

export function ceoOnConversation(ctx: HarnessCtx, conv: Conversation): void {
  const state = loop(ctx);
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
    wake says so. */
export async function ceoOnStuck(
  ctx: HarnessCtx,
  binding: SessionBinding,
): Promise<void> {
  const state = loop(ctx);
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
  await noteCeoWake(ctx, {
    reason: "stuck",
    ticketId: conv.ticketId,
    handTo,
    ...(lastResort ? { lastResort: true } : {}),
  });
}

export function ceoOnAsk(ctx: HarnessCtx, ask: Ask): void {
  /* A cancelled ask is not news. The CEO's own thread is not either:
     that would wake the standing thread from itself. */
  if (ask.outcome === "cancel") return;
  const state = loop(ctx);
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
  const state = loop(ctx);
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
