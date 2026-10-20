/* Scheduled tasks (#136): the relay owns the records; this module owns the
   app's copy — one atom refreshed by `schedules.list` and kept current by
   `schedule.upserted`/`schedule.removed` — plus the write calls the dialog
   and row actions make. */
import type { ScheduledTask, TaskSchedule } from "@lilos/contracts/app";
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
