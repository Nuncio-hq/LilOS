/* Scheduled tasks (#136): the relay owns the records; this module owns the
   app's copy — one atom refreshed by `schedules.list` and kept current by
   `schedule.upserted`/`schedule.removed` — plus the write calls the dialog
   and row actions make. */
import type {
  Conversation,
  ScheduledTask,
  TaskSchedule,
} from "@lilos/contracts/app";
import { whenText } from "@lilos/ui";
import type { ScheduledRun, ScheduledTask as UiTask } from "@lilos/ui/types";
import { atom } from "nanostores";
import { relay } from "./runtime";

export const $scheduledTasks = atom<ScheduledTask[]>([]);

export async function refreshScheduledTasks(): Promise<void> {
  const res = await relay.request<{ tasks: ScheduledTask[] }>(
    "schedules.list",
    {},
  );
  $scheduledTasks.set(res.tasks);
}

let watched = false;
/* Live updates: every task write broadcasts `schedule.upserted` (or
   `schedule.removed`) — patch the atom so the panel and the DM header
   count stay current without a reload. Runs once per app. */
export function watchSchedules(): void {
  if (watched) return;
  watched = true;
  relay.onEvent((method, params) => {
    if (method === "schedule.upserted") {
      const task = (params as { task?: ScheduledTask }).task;
      if (!task) return;
      $scheduledTasks.set([
        ...$scheduledTasks.get().filter((t) => t.id !== task.id),
        task,
      ]);
    } else if (method === "schedule.removed") {
      const taskId = (params as { taskId?: string }).taskId;
      if (!taskId) return;
      $scheduledTasks.set($scheduledTasks.get().filter((t) => t.id !== taskId));
    }
  });
}

/* ------------------------------ write calls ------------------------------ */

export async function createScheduledTask(input: {
  employeeId: string;
  name: string;
  prompt: string;
  folder?: string;
  schedule: TaskSchedule;
  access: "ask" | "full";
}): Promise<ScheduledTask> {
  const res = await relay.request<{ task: ScheduledTask }>(
    "schedules.create",
    input,
  );
  return res.task;
}

export async function updateScheduledTask(
  id: string,
  patch: {
    name?: string;
    prompt?: string;
    folder?: string | null;
    schedule?: TaskSchedule;
    access?: "ask" | "full";
    paused?: boolean;
  },
): Promise<void> {
  await relay.request("schedules.update", { id, ...patch });
}

export async function deleteScheduledTask(id: string): Promise<void> {
  await relay.request("schedules.delete", { id });
}

export async function runScheduledTaskNow(id: string): Promise<void> {
  await relay.request("schedules.runNow", { id });
}

/* --------------------------- contract -> UI ------------------------------ */

/* The UI task speaks folder ids and root ids; the contract speaks the run's
   conversation id — a run opens its session through `conversations.open`,
   so the DM row it links to is that conversation's root message. */
export function toUiTask(
  task: ScheduledTask,
  conversations: Conversation[],
  now = new Date(),
): UiTask {
  const lastRun: ScheduledRun | undefined = task.lastRun
    ? {
        /* Epoch on the wire, "Today 9:00" on the row (#410's format). */
        at: whenText(new Date(task.lastRun.at), now),
        result: task.lastRun.result,
        rootId: conversations.find((c) => c.id === task.lastRun?.conversationId)
          ?.rootMessageId,
      }
    : undefined;
  return {
    id: task.id,
    employee: task.employeeId,
    name: task.name,
    prompt: task.prompt,
    ...(task.folder !== undefined ? { folder: task.folder } : {}),
    schedule: task.schedule,
    access: task.access,
    ...(task.paused ? { paused: true } : {}),
    ...(lastRun ? { lastRun } : {}),
    ...(task.skippedAt !== undefined
      ? { skipped: whenText(new Date(task.skippedAt), now) }
      : {}),
  };
}
