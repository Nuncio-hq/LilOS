import type { AppChannel, Conversation } from "@lilos/contracts/app";
import { CEO_THREAD_KEY } from "@lilos/contracts/app";
import { type CeoWakeEvent, formatCeoWake } from "@lilos/contracts/harness";
import type { CeoLoop } from "./ceo-state";
import { ceoLoop, forgetStanding } from "./ceo-state";
import type { HarnessCtx } from "./ctx";

/**
 * Posting one coalesced wake onto the standing CEO thread (D-#777).
 * The message is a system note. The title is the user's, "CEO", so the
 * engine's auto-title cannot rename it. No dedupe key: a hit would
 * return the old thread and drop this wake.
 *
 * A schedule's `lastFiredAt` is written here, after the post. A restart
 * before that still fires it. `lastRun` stays unset so the standing
 * thread being active cannot skip a later slot.
 */

function standingThread(
  ctx: HarnessCtx,
  state: CeoLoop,
  ceoId: string,
): Conversation | undefined {
  if (!state.threadId) return undefined;
  const current = ctx.conversationFromAtom(state.threadId);
  if (!current || current.archived) return undefined;
  /* A holder change must not post into the previous CEO's thread. */
  if (ctx.employeeIdFor(current) !== ceoId) return undefined;
  return current;
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

export async function deliverCeoWake(
  ctx: HarnessCtx,
  events: CeoWakeEvent[],
): Promise<void> {
  const state = ceoLoop(ctx);
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
    if (next) await deliverCeoWake(ctx, next);
  }
}
