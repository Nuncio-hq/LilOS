import { nextRunAt, type ScheduledTask } from "@lilos/contracts/app";
import type { Logger } from "./log";

/**
 * The scheduled-task clock (D-#136): the relay owns the records, this class
 * owns when they fire. It ticks on an interval plus on every task change
 * (`schedule.upserted` also means "check now" — that's what makes Run now
 * instant) and fires each due task exactly once, as a `conversations.open`.
 * The harness hosts it because it is the launchd agent that already
 * survives quit and reboot (D-#34). Not: a relay- or engine-side timer.
 *
 * Missed runs coalesce by construction: the due test is
 * `nextRunAt(schedule, lastFiredAt) <= now`, so a Mac that slept through
 * many slots surfaces exactly ONE due time on wake — the oldest missed —
 * never a burst. Not: a catch-up run per missed slot.
 *
 * Re-entrancy: `ticking` guards overlapping ticks; `firing` guards a task
 * whose `conversations.open` is still in flight so a second tick can't
 * double-open it (the open's dedupeKey is the second line of defence).
 */
export interface TaskSchedulerDeps {
  /** Check period — runs are due to the minute; anything below ~30s is plenty. */
  intervalMs: number;
  log: Logger;
  /** Open the task's run as a thread (conversations.open + stamp the
      row). `due.at` is the slot's epoch ms, `due.key` its dedupe leg. */
  fire: (
    task: ScheduledTask,
    due: { at: number; key: string },
  ) => Promise<void>;
  /** Mark a slot consumed without opening a session (AC-4 skip). */
  skip: (task: ScheduledTask, at: number) => Promise<void>;
  /** True while the task's previous run is still going (AC-4). */
  stillGoing: (task: ScheduledTask) => boolean;
}

export class TaskScheduler {
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly firing = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(private readonly opts: TaskSchedulerDeps) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Bulk refresh after `schedules.list` (relay ready / re-register). */
  setTasks(tasks: ScheduledTask[]): void {
    this.tasks.clear();
    for (const task of tasks) this.tasks.set(task.id, task);
  }

  upsertTask(task: ScheduledTask): void {
    this.tasks.set(task.id, task);
  }

  /** Employee gone → its tasks go too (the relay cascade-deletes them
      without per-task broadcasts). */
  removeEmployeeTasks(employeeId: string): void {
    for (const task of this.tasks.values())
      if (task.employeeId === employeeId) this.tasks.delete(task.id);
  }

  removeTask(taskId: string): void {
    this.tasks.delete(taskId);
  }

  getTask(taskId: string): ScheduledTask | undefined {
    return this.tasks.get(taskId);
  }

  /** One due pass — tests drive it with a fake `now`. */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const task of this.tasks.values()) {
        const requested =
          task.requestedAt !== undefined &&
          task.requestedAt > (task.lastFiredAt ?? 0);
        /* Run now is an explicit manual fire — it bypasses `paused` rather
           than being stamped and silently deferred to a resume. */
        if (task.paused && !requested) continue;
        if (this.firing.has(task.id)) continue;
        const anchor = task.lastFiredAt ?? task.createdAt;
        const dueAt = nextRunAt(task.schedule, new Date(anchor))?.getTime();
        const due = requested
          ? { at: task.requestedAt as number, key: `req:${task.requestedAt}` }
          : dueAt !== undefined && dueAt <= now
            ? { at: dueAt, key: `run:${dueAt}` }
            : null;
        if (!due) continue;
        this.firing.add(task.id);
        try {
          if (this.opts.stillGoing(task)) {
            /* AC-4: never overlap a task with itself — the slot is still
               consumed, and the row carries the skip note for the UI. */
            await this.opts.skip(task, now);
            task.lastFiredAt = now;
            task.skippedAt = now;
            this.opts.log.info("scheduled run skipped — previous still going", {
              taskId: task.id,
            });
          } else {
            await this.opts.fire(task, due);
            /* The relay's own update stamps `lastFiredAt = Date.now()` —
               mirror THAT, not the slot time, so a dropped upsert echo can't
               re-anchor early and surface another missed slot as a second
               real run (the burst AC-2 forbids). */
            task.lastFiredAt = Date.now();
            if (requested) task.requestedAt = undefined;
            this.opts.log.info("scheduled run fired", {
              taskId: task.id,
              dueAt: due.at,
              requested,
            });
          }
        } catch (error) {
          /* A failed open leaves lastFiredAt untouched, so the slot is
             retried on the next tick — the dedupeKey keeps a half-opened
             attempt from double-firing. */
          this.opts.log.warn("scheduled run failed to start", {
            taskId: task.id,
            error: String(error),
          });
        } finally {
          this.firing.delete(task.id);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
