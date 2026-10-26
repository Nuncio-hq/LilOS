import type { TaskWakeEvent } from "../app/ticket.js";

/**
 * Parent wake on a child task's turn end (D-#844) — the harness-side
 * queue. The relay owns posting and stamping (`tasks.wake`); this class
 * only decides when noticed turns may leave: a burst of children
 * finishing together posts as ONE wake; a failed post is restored with
 * a fresh window so the retry does not spin.
 *
 * No busy check: the posted `taskWake` message rides the parent's own
 * delivery lane, so a running parent turn drains it next — unlike the
 * CEO's standing thread (D-#777), every parent is a different thread.
 */

/** Burst window: children finishing a few hundred ms apart post once. */
export const TASK_WAKE_COALESCE_MS = 800;

export class TaskWakes {
  private pending: TaskWakeEvent[] = [];
  private windowAt = 0;
  private running = false;

  /** Replay-safe (D-#844): a rebound session replays `turn.completed`, so
      the same (taskId, turnId) noted twice lands once — the durable fence
      on the ticket row is the second line. */
  note(event: TaskWakeEvent, at: number): void {
    if (
      this.pending.some(
        (p) => p.taskId === event.taskId && p.turnId === event.turnId,
      )
    )
      return;
    if (this.pending.length === 0) this.windowAt = at;
    this.pending.push(event);
  }

  /** Null while a delivery runs, or the window has not closed. */
  poll(now: number): TaskWakeEvent[] | null {
    if (this.running || this.pending.length === 0) return null;
    if (now - this.windowAt < TASK_WAKE_COALESCE_MS) return null;
    return this.take();
  }

  /** The relay posted the batch — release the queue (`tasks.wake` already
      fenced each event durably, so nothing re-fires on a later replay). */
  settled(): void {
    this.running = false;
  }

  /** The post failed — restore the batch and open a fresh window so the
      retry does not spin (D-#777's queue semantics). */
  restore(events: readonly TaskWakeEvent[], now: number): void {
    this.running = false;
    const known = new Set(events.map((e) => `${e.taskId}${e.turnId}`));
    this.pending = [
      ...events,
      ...this.pending.filter((e) => !known.has(`${e.taskId}${e.turnId}`)),
    ];
    this.windowAt = now;
  }

  get isRunning(): boolean {
    return this.running;
  }
  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** Ms until `poll` can take the batch; zero when nothing waits. */
  remaining(now: number): number {
    if (this.pending.length === 0 || this.running) return 0;
    return Math.max(0, this.windowAt + TASK_WAKE_COALESCE_MS - now);
  }

  private take(): TaskWakeEvent[] {
    const out = this.pending;
    this.pending = [];
    this.windowAt = 0;
    this.running = true;
    return out;
  }
}
