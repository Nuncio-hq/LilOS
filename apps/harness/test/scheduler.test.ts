import type { ScheduledTask } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { TaskScheduler } from "../src/scheduler";

const LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  close: async () => {},
};

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: "task-1",
  employeeId: "emp-1",
  name: "Triage",
  prompt: "triage new issues",
  schedule: { kind: "daily", time: "9:00" },
  access: "ask",
  createdAt: Date.parse("2026-10-01T00:00:00"),
  ...over,
});

const make = (
  over: Partial<ConstructorParameters<typeof TaskScheduler>[0]> = {},
) => {
  const fired: { task: ScheduledTask; due: { at: number; key: string } }[] = [];
  const skipped: ScheduledTask[] = [];
  const scheduler = new TaskScheduler({
    intervalMs: 30_000,
    log: LOG,
    fire: async (t, due) => {
      fired.push({ task: t, due });
    },
    skip: async (t) => {
      skipped.push(t);
    },
    stillGoing: () => false,
    ...over,
  });
  return { scheduler, fired, skipped };
};

describe("TaskScheduler (#136)", () => {
  it("fires a due slot once — not on every tick", async () => {
    const { scheduler, fired } = make();
    scheduler.setTasks([task()]);
    /* Anchor at 10am Oct 10: the next daily-9am slot is Oct 11 9:00. */
    const t = task({ lastFiredAt: Date.parse("2026-10-10T10:00:00") });
    scheduler.setTasks([t]);
    await scheduler.tick(Date.parse("2026-10-11T09:30:00"));
    expect(fired).toHaveLength(1);
    expect(fired[0].due.at).toBe(Date.parse("2026-10-11T09:00:00"));
    await scheduler.tick(Date.parse("2026-10-11T09:31:00"));
    expect(fired).toHaveLength(1);
  });

  it("does not fire before the slot", async () => {
    const { scheduler, fired } = make();
    scheduler.setTasks([
      task({ lastFiredAt: Date.parse("2026-10-10T10:00:00") }),
    ]);
    await scheduler.tick(Date.parse("2026-10-11T08:59:00"));
    expect(fired).toHaveLength(0);
  });

  it("coalesces slept-through slots to one run (AC-2)", async () => {
    const { scheduler, fired } = make();
    /* Last fired Monday; the Mac wakes Friday — 4 missed slots, 1 run,
       and it fires the OLDEST missed slot. */
    scheduler.setTasks([
      task({ lastFiredAt: Date.parse("2026-10-05T09:00:00") }),
    ]);
    await scheduler.tick(Date.parse("2026-10-09T07:00:00"));
    expect(fired).toHaveLength(1);
    expect(fired[0].due.at).toBe(Date.parse("2026-10-06T09:00:00"));
    expect(fired[0].due.key).toBe(`run:${Date.parse("2026-10-06T09:00:00")}`);
  });

  it("a task never fired runs its next due slot from creation", async () => {
    const { scheduler, fired } = make();
    scheduler.setTasks([
      task({ createdAt: Date.parse("2026-10-10T10:00:00") }),
    ]);
    await scheduler.tick(Date.parse("2026-10-11T09:30:00"));
    expect(fired).toHaveLength(1);
  });

  it("skips when the previous run is still going (AC-4) and consumes the slot", async () => {
    const { scheduler, fired, skipped } = make({
      stillGoing: () => true,
    });
    scheduler.setTasks([
      task({
        lastFiredAt: Date.parse("2026-10-10T10:00:00"),
        lastRun: {
          at: Date.parse("2026-10-10T10:00:00"),
          result: "running",
          conversationId: "conv-1",
        },
      }),
    ]);
    await scheduler.tick(Date.parse("2026-10-11T09:30:00"));
    expect(fired).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });

  it("Run now fires regardless of schedule, once", async () => {
    const { scheduler, fired } = make();
    const requestedAt = Date.parse("2026-10-11T12:00:00");
    scheduler.setTasks([
      task({
        requestedAt,
        lastFiredAt: Date.parse("2026-10-11T09:00:00"),
      }),
    ]);
    await scheduler.tick(Date.parse("2026-10-11T12:01:00"));
    expect(fired).toHaveLength(1);
    expect(fired[0].due.key).toBe(`req:${requestedAt}`);
    await scheduler.tick(Date.parse("2026-10-11T12:02:00"));
    expect(fired).toHaveLength(1);
  });

  it("a stamp older than the last fire is not a pending request", async () => {
    const { scheduler, fired } = make();
    scheduler.setTasks([
      task({
        requestedAt: Date.parse("2026-10-11T08:00:00"),
        lastFiredAt: Date.parse("2026-10-11T12:00:00"),
      }),
    ]);
    await scheduler.tick(Date.parse("2026-10-11T12:30:00"));
    expect(fired).toHaveLength(0);
  });

  it("paused tasks never fire", async () => {
    const { scheduler, fired } = make();
    scheduler.setTasks([
      task({ paused: true, createdAt: Date.parse("2026-10-01T00:00:00") }),
    ]);
    await scheduler.tick(Date.parse("2026-10-20T00:00:00"));
    expect(fired).toHaveLength(0);
  });

  it("a failed fire retries the same slot next tick", async () => {
    let calls = 0;
    const { scheduler } = make({
      fire: async () => {
        calls++;
        if (calls === 1) throw new Error("relay down");
      },
    });
    scheduler.setTasks([
      task({ lastFiredAt: Date.parse("2026-10-10T10:00:00") }),
    ]);
    await scheduler.tick(Date.parse("2026-10-11T09:30:00"));
    expect(calls).toBe(1);
    await scheduler.tick(Date.parse("2026-10-11T09:31:00"));
    expect(calls).toBe(2);
  });

  it("a re-fired task updates go through upsertTask", async () => {
    const { scheduler, fired } = make();
    scheduler.setTasks([
      task({ lastFiredAt: Date.parse("2026-10-10T10:00:00") }),
    ]);
    /* The relay's upsert broadcast lands mid-tick — the row's new
       lastFiredAt re-anchors before the next one. */
    scheduler.upsertTask(
      task({ lastFiredAt: Date.parse("2026-10-11T09:30:00") }),
    );
    await scheduler.tick(Date.parse("2026-10-11T09:35:00"));
    expect(fired).toHaveLength(0);
    await scheduler.tick(Date.parse("2026-10-12T09:05:00"));
    expect(fired).toHaveLength(1);
  });
});
