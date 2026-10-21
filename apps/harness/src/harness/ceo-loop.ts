import type {
  AppChannel,
  Ask,
  Conversation,
  ScheduledTask,
  SettingsGetResult,
  Ticket,
} from "@lilos/contracts/app";
import { CEO_SETTING_KEY } from "@lilos/contracts/app";
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
 * The CEO's own ticket writes carry `actorId` and are dropped. A stuck
 * thread of the CEO's own is skipped so the standing thread cannot wake
 * itself. With no CEO, the queue is cleared and nothing is delivered.
 */

const CEO_THREAD_KEY = "ceoThreadId";

interface Loop {
  wakes: CeoWakes;
  timer?: ReturnType<typeof setTimeout>;
  threadId?: string;
  /** Channel of a standing thread being opened, before its id is known. */
  openingChannelId?: string;
  ceoId: string | null;
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
      sawActive: false,
      ready,
      resolveReady,
    };
    loops.set(ctx, found);
  }
  return found;
}

export function wireCeoLoop(ctx: HarnessCtx): void {
  const state = loop(ctx);
  void (async () => {
    try {
      const ceo = await ctx.opts.relay.request<SettingsGetResult>(
        "settings.get",
        { key: CEO_SETTING_KEY },
      );
      state.ceoId =
        typeof ceo.value === "string" && ceo.value ? ceo.value : null;
      const thread = await ctx.opts.relay.request<SettingsGetResult>(
        "settings.get",
        { key: CEO_THREAD_KEY },
      );
      if (typeof thread.value === "string" && thread.value)
        state.threadId = thread.value;
    } catch (error) {
      ctx.opts.log.warn("ceo loop settings failed", { error: String(error) });
    } finally {
      state.resolveReady();
    }
  })();
}

export function ceoOnSettings(
  ctx: HarnessCtx,
  params: { key?: unknown; value?: unknown },
): void {
  if (params.key !== CEO_SETTING_KEY) return;
  const state = loop(ctx);
  state.ceoId =
    typeof params.value === "string" && params.value ? params.value : null;
  state.resolveReady();
  if (!state.ceoId) state.wakes.clear();
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

async function flush(ctx: HarnessCtx): Promise<void> {
  const state = loop(ctx);
  await state.ready;
  if (!state.ceoId) {
    state.wakes.clear();
    return;
  }
  const batch = state.wakes.poll(Date.now());
  if (!batch) {
    if (state.wakes.hasPending && !state.wakes.isRunning) arm(ctx);
    return;
  }
  try {
    await deliver(ctx, batch);
  } catch (error) {
    state.wakes.fail();
    ctx.opts.log.warn("ceo wake failed", { error: String(error) });
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
  const current = state.threadId
    ? ctx.conversationFromAtom(state.threadId)
    : undefined;
  if (current && !current.archived) {
    state.sawActive = false;
    await ctx.opts.relay.request("messages.post", {
      channelId: current.channelId,
      conversationId: current.id,
      text,
      authorId: "user",
      authorKind: "user",
    });
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
     row's first idle as the turn ending. */
  state.sawActive = false;
  state.openingChannelId = channel.id;
  const opened = await ctx.opts.relay.request<{ conversation: Conversation }>(
    "conversations.open",
    {
      channelId: channel.id,
      text,
      title: "CEO",
      authorId: "user",
      /* A fresh thread after the old one was archived must not reuse the
         key and land back on the archived row. */
      ...(current?.archived ? {} : { dedupeKey: "ceo-loop" }),
    },
  );
  state.openingChannelId = undefined;
  state.threadId = opened.conversation.id;
  await ctx.opts.relay.request("settings.set", {
    key: CEO_THREAD_KEY,
    value: opened.conversation.id,
  });
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
  if (
    (conv.state === "idle" || conv.state === "closed") &&
    state.sawActive &&
    state.wakes.isRunning
  ) {
    state.sawActive = false;
    const next = state.wakes.settled();
    if (!next) return;
    void deliver(ctx, next).catch((error) => {
      loop(ctx).wakes.fail();
      ctx.opts.log.warn("ceo wake failed", { error: String(error) });
    });
  }
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

/** A stuck thread that is not the CEO's own. `handTo` is another employee
    the wake names; the CEO assigns, the harness does not. */
export async function ceoOnStuck(
  ctx: HarnessCtx,
  binding: SessionBinding,
): Promise<void> {
  const state = loop(ctx);
  await state.ready;
  const conv = ctx.conversationFromAtom(binding.conversationId);
  const employeeId = binding.employeeId ?? ctx.employeeIdFor(conv);
  if (!conv?.ticketId || !employeeId) return;
  if (state.ceoId && employeeId === state.ceoId) return;
  const handTo = ctx.opts.relay.employees
    .get()
    .find((e) => e.id !== employeeId)?.id;
  if (!handTo) return;
  await noteCeoWake(ctx, {
    reason: "stuck",
    ticketId: conv.ticketId,
    handTo,
  });
}

export function ceoOnAsk(ctx: HarnessCtx, ask: Ask): void {
  const conv = ctx.conversationFromAtom(ask.conversationId);
  if (!conv?.ticketId) return;
  void noteCeoWake(ctx, { reason: "ask", ticketId: conv.ticketId });
}

/**
 * A schedule whose employee holds the CEO seat becomes a wake, not a
 * second thread. Returns true when the slot was consumed that way.
 * `lastRun` stays unset: pointing it at the standing thread would make
 * the scheduler skip later slots whenever that thread is active.
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
  await ctx.opts.relay.request("schedules.update", {
    id: task.id,
    lastFiredAt: Date.now(),
    skippedAt: null,
  });
  return true;
}

export { CEO_WAKE_COALESCE_MS };
