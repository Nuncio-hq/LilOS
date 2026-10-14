import type { AppChannel, Conversation } from "@lilos/contracts/app";
import { runTitle, type ScheduledTask } from "@lilos/contracts/app";
import { TaskScheduler } from "../scheduler";
import type { HarnessCtx } from "./ctx";

/**
 * Scheduled tasks (#136): the TaskScheduler owns the due decision; these
 * methods own the relay round-trips. A run IS a `conversations.open` on the
 * employee's DM channel — the message pipeline that delivers any user's
 * prompt picks it up the same way, so approvals, notifications and badges
 * need no special-casing.
 *
 * Dedupe legs: `sched:<taskId>:run:<slotMs>` for a schedule slot and
 * `sched:<taskId>:req:<requestedAt>` for Run-now — slot-stable so a relay
 * retry or a slept machine re-answering the same slot re-answers with the
 * same conversation instead of opening a second run.
 */
export function wireScheduler(this: HarnessCtx): void {
  this.scheduler = new TaskScheduler({
    intervalMs: 30_000,
    log: this.opts.log,
    fire: (task, due) => this.fireScheduledTask(task, due),
    skip: (task, at) => this.skipScheduledRun(task, at),
    stillGoing: (task) => this.scheduledRunStillGoing(task),
  });
  this.scheduler.start();
}

/* Re-fetch after re-registering — the task list may have changed while the
   host was down, and the first tick then picks up every slept-through
   slot at once (coalesced to one run per task). */
export async function syncScheduledTasks(this: HarnessCtx): Promise<void> {
  const { tasks } = await this.opts.relay.request<{ tasks: ScheduledTask[] }>(
    "schedules.list",
    {},
  );
  this.scheduler.setTasks(tasks);
  await this.scheduler.tick();
}

export async function onScheduleUpserted(
  this: HarnessCtx,
  task: ScheduledTask,
): Promise<void> {
  this.scheduler.upsertTask(task);
  /* Run-now stamps `requestedAt`; ticking right away — not next interval —
     is what makes the button feel instant. */
  await this.scheduler.tick();
}

export function onScheduleRemoved(this: HarnessCtx, taskId: string): void {
  this.scheduler.removeTask(taskId);
  this.scheduledRunsInFlight.delete(taskId);
}

/** AC-4: a task can't overlap itself. `runsInFlight` covers the gap between
    `conversations.open` returning and the first turn binding; after that,
    the live binding's queue/running turn — or an `active` row when the
    binding is gone — still means "going". */
export function scheduledRunStillGoing(
  this: HarnessCtx,
  task: ScheduledTask,
): boolean {
  if (task.lastRun?.result !== "running") return false;
  const conversationId = task.lastRun.conversationId;
  if (!conversationId) return false;
  if (this.scheduledRunsInFlight.get(task.id) === conversationId) return true;
  if ((this.inFlightDeliveries.get(conversationId) ?? 0) > 0) return true;
  const binding = this.bindings.get(conversationId);
  if (
    binding &&
    (binding.runningTurnId ||
      binding.queue.length > 0 ||
      binding.inflightPrompts.size > 0)
  ) {
    return true;
  }
  const conversation = this.conversationFromAtom(conversationId);
  return conversation?.state === "active";
}

export async function fireScheduledTask(
  this: HarnessCtx,
  task: ScheduledTask,
  due: { at: number; key: string },
): Promise<void> {
  /* The task opens on the employee's DM; the channel may not exist yet if
     the human has never opened the DM — create it like `channels.openDm`. */
  let channel = this.opts.relay.channels
    .get()
    .find(
      (c: AppChannel) => c.kind === "dm" && c.employeeId === task.employeeId,
    );
  if (!channel) {
    const opened = await this.opts.relay.request<{ channel: AppChannel }>(
      "channels.openDm",
      { employeeId: task.employeeId },
    );
    channel = opened.channel;
  }
  const { conversation } = await this.opts.relay.request<{
    conversation: Conversation;
  }>("conversations.open", {
    channelId: channel.id,
    text: task.prompt,
    /* Runs read like a session the user titled (AC-3): "Name · Thu 2 Oct". */
    title: runTitle(task.name, new Date(due.at)),
    ...(task.folder !== undefined ? { cwd: task.folder } : {}),
    access: task.access,
    dedupeKey: `sched:${task.id}:${due.key}`,
    scheduled: { taskId: task.id, name: task.name },
  });
  /* lastFiredAt advances the coalescing anchor; lastRun links the row to
     the DM session the UI opens and tracks. */
  await this.opts.relay.request("schedules.update", {
    id: task.id,
    lastFiredAt: Date.now(),
    skippedAt: null,
    lastRun: {
      at: Date.now(),
      result: "running",
      conversationId: conversation.id,
    },
  });
  this.scheduledRunsInFlight.set(task.id, conversation.id);
}

export async function skipScheduledRun(
  this: HarnessCtx,
  task: ScheduledTask,
  at: number,
): Promise<void> {
  await this.opts.relay.request("schedules.update", {
    id: task.id,
    /* The skipped slot is still consumed — it doesn't retry. */
    lastFiredAt: at,
    skippedAt: at,
  });
}

/** A run's session changed in the DM (`conversation.updated` dispatch):
    the first `active` means the run is really going; `idle`/`closed` after
    `running` is its result — the task row carries it for the last-run text. */
export async function onScheduledConversationUpdate(
  this: HarnessCtx,
  conversation: Conversation,
): Promise<void> {
  const marker = conversation.scheduled;
  if (!marker) return;
  if (
    conversation.state === "active" &&
    this.scheduledRunsInFlight.get(marker.taskId) === conversation.id
  ) {
    this.scheduledRunsInFlight.delete(marker.taskId);
    return;
  }
  if (conversation.state !== "idle" && conversation.state !== "closed") return;
  const task = this.scheduler.getTask(marker.taskId);
  if (!task) return;
  if (
    task.lastRun?.result !== "running" ||
    task.lastRun.conversationId !== conversation.id
  ) {
    return;
  }
  this.scheduledRunsInFlight.delete(marker.taskId);
  await this.opts.relay.request("schedules.update", {
    id: marker.taskId,
    lastRun: {
      ...task.lastRun,
      result: conversation.turnFailure ? "failed" : "finished",
    },
  });
}
