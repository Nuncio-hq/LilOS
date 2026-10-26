import type { TaskWakeEvent } from "@lilos/contracts/app";
import type { EngineEvent } from "@lilos/contracts/engine";
import { TaskWakes } from "@lilos/contracts/harness";
import type { HarnessCtx, SessionBinding } from "./ctx";

/**
 * Parent wake on a child task's turn end (D-#844). The harness only
 * NOTICES finishes — `tasks.wake` on the relay posts the parent's
 * `taskWake` message and stamps the ticket's fence in one write, so a
 * replayed `turn.completed` (rebind replays from seq 0) can never wake
 * the parent twice. This file holds the noticing side: the coalescing
 * queue (`TaskWakes` — children finishing inside one burst post as a
 * single message), the timer, and the `tasks.wake` call.
 *
 * Unlike the CEO's standing thread (D-#777) there is no busy check and
 * no thread to find — the wake rides the parent conversation's own
 * delivery lane; a parent mid-turn drains it when that turn ends.
 */

interface TaskLoop {
  wakes: TaskWakes;
  timer?: ReturnType<typeof setTimeout>;
}

const loops = new WeakMap<HarnessCtx, TaskLoop>();

function taskLoop(ctx: HarnessCtx): TaskLoop {
  let found = loops.get(ctx);
  if (!found) {
    found = { wakes: new TaskWakes() };
    loops.set(ctx, found);
  }
  return found;
}

/** `stop` clears the quiet timer — a pending batch waits for the next
    register's `taskWakes` catch-up, since the relay's fence is durable. */
export function stopTaskLoop(ctx: HarnessCtx): void {
  const state = loops.get(ctx);
  if (state?.timer) clearTimeout(state.timer);
  if (state) state.timer = undefined;
}

/**
 * `finishTurn` hook: a turn that ended on a task child (parentId +
 * ticketId — `createTask` stamps both) notes one wake event. The result
 * is the turn's own text, sent whole — the ticket keeps it full and the
 * relay's `formatTaskWake` caps only the inlined line (D-#844). Turns on
 * plain conversations return early — no queue, no timer.
 */
export function noteTaskTurn(
  ctx: HarnessCtx,
  binding: SessionBinding,
  event: Extract<EngineEvent, { type: "turn.completed" }>,
  text: string,
): void {
  const conv = ctx.conversationFromAtom(binding.conversationId);
  if (!conv?.parentId || !conv.ticketId) return;
  const { turnId, stopReason, error } = event.payload;
  noteTaskWake(ctx, {
    taskId: conv.ticketId,
    turnId,
    outcome: error
      ? "failed"
      : stopReason === "cancelled"
        ? "stopped"
        : "finished",
    /* A failed or stopped turn still reports — the wake line carries the
       error text when the answer never posted. */
    ...(text.trim() || error
      ? { result: text.trim() || `Error: ${error}` }
      : {}),
  });
}

/** One noticed finish (or a register catch-up event) into the queue. */
export function noteTaskWake(ctx: HarnessCtx, event: TaskWakeEvent): void {
  const state = taskLoop(ctx);
  state.wakes.note(event, Date.now());
  scheduleTaskWake(ctx);
}

/** Arm the coalescing timer at the queue's own remaining window. */
export function scheduleTaskWake(ctx: HarnessCtx): void {
  const state = taskLoop(ctx);
  if (state.timer || state.wakes.isRunning) return;
  if (!state.wakes.hasPending) return;
  state.timer = setTimeout(
    () => {
      state.timer = undefined;
      void flushTaskWakes(ctx);
    },
    Math.max(1, state.wakes.remaining(Date.now())),
  );
}

/** Post the coalesced batch: `tasks.wake` writes the message and the
    fences atomically. A failed call restores the batch with a fresh
    window so the retry does not spin on hot errors. */
export async function flushTaskWakes(ctx: HarnessCtx): Promise<void> {
  const state = taskLoop(ctx);
  const batch = state.wakes.poll(Date.now());
  if (!batch) {
    /* #873: the timer's monotonic clock can land a millisecond or two
       ahead of `Date.now()` — poll then declines a batch whose window is
       still open. Re-arm for the remainder instead of stranding it. */
    scheduleTaskWake(ctx);
    return;
  }
  try {
    await ctx.opts.relay.request("tasks.wake", { events: batch });
    state.wakes.settled();
  } catch (error) {
    ctx.opts.log.warn("task wake post failed", { error: String(error) });
    state.wakes.restore(batch, Date.now());
  }
  /* Notes that landed during the post (or the restore) re-arm the timer. */
  scheduleTaskWake(ctx);
}
