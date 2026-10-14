import { z } from "zod";
import { ConversationAccess } from "../engine/approvals";
import { Timestamp } from "./domain";

/**
 * Scheduled tasks (issue #136): a prompt that opens a new DM session for an
 * employee on a schedule. The relay owns the task records (D-#25); the
 * engine host owns the clock and fires each run as a `conversations.open`.
 *
 * The schedule math here is the same algorithm `packages/ui`'s
 * `schedule/schedule-text.ts` renders — the UI keeps its own copy because
 * `packages/ui` deliberately has no contracts dependency.
 */

export const ScheduleKind = z.enum([
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "once",
  "cron",
]);
export type ScheduleKind = z.infer<typeof ScheduleKind>;

/** `time` is "HH:MM" (hourly reads only the minutes); `day` 0–6 = Sun–Sat
    for weekly; `date` "YYYY-MM-DD" for once; `cron` five fields for custom. */
export const TaskSchedule = z.object({
  kind: ScheduleKind,
  time: z.string(),
  day: z.int().min(0).max(6).optional(),
  date: z.string().optional(),
  cron: z.string().optional(),
});
export type TaskSchedule = z.infer<typeof TaskSchedule>;

export const ScheduledRunResult = z.enum(["running", "finished", "failed"]);
export type ScheduledRunResult = z.infer<typeof ScheduledRunResult>;

/** The task's latest run — `conversationId` is the run's session in the DM. */
export const ScheduledRunRecord = z.object({
  /** Epoch ms the run opened. */
  at: Timestamp,
  result: ScheduledRunResult,
  conversationId: z.string().min(1),
});
export type ScheduledRunRecord = z.infer<typeof ScheduledRunRecord>;

export const ScheduledTask = z.object({
  id: z.string().min(1),
  employeeId: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string(),
  /** Folder the run's session opens in; unset = the harness default dir. */
  folder: z.string().optional(),
  schedule: TaskSchedule,
  /** Access for unattended runs (#106): `ask` stops on risky commands. */
  access: ConversationAccess,
  paused: z.boolean().optional(),
  /** Epoch ms of the last fired slot — the scheduler's "runs after this"
      anchor; a slept-through slot lands once on the next tick, never a
      burst. */
  lastFiredAt: Timestamp.optional(),
  /** Run-now stamp (#136): a click while the host was down still fires —
      the host fires any `requestedAt` newer than `lastFiredAt`. */
  requestedAt: Timestamp.optional(),
  lastRun: ScheduledRunRecord.optional(),
  /** Epoch ms a run was skipped because the previous one was still going
      (AC-4); the next real run clears it. */
  skippedAt: Timestamp.optional(),
  createdAt: Timestamp,
});
export type ScheduledTask = z.infer<typeof ScheduledTask>;

/* ------------------------------- wire params ----------------------------- */

export const SchedulesListParams = z.object({
  /** One employee's tasks; absent = every task (host use). */
  employeeId: z.string().min(1).optional(),
});
export type SchedulesListParams = z.infer<typeof SchedulesListParams>;

export const SchedulesListResult = z.object({
  tasks: z.array(ScheduledTask),
});

export const SchedulesCreateParams = z.object({
  employeeId: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string().min(1),
  folder: z.string().min(1).optional(),
  schedule: TaskSchedule,
  access: ConversationAccess,
});
export type SchedulesCreateParams = z.infer<typeof SchedulesCreateParams>;

/**
 * `name`/`prompt`/`folder`/`schedule`/`access`/`paused` are the user's
 * edits; `lastRun`/`skippedAt`/`lastFiredAt`/`requestedAt` are host-only —
 * the scheduler stamps them as runs fire, finish and skip.
 */
export const SchedulesUpdateParams = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  folder: z.string().min(1).nullable().optional(),
  schedule: TaskSchedule.optional(),
  access: ConversationAccess.optional(),
  paused: z.boolean().optional(),
  lastRun: ScheduledRunRecord.nullable().optional(),
  skippedAt: Timestamp.nullable().optional(),
  lastFiredAt: Timestamp.nullable().optional(),
  requestedAt: Timestamp.nullable().optional(),
});
export type SchedulesUpdateParams = z.infer<typeof SchedulesUpdateParams>;

export const SchedulesDeleteParams = z.object({ id: z.string().min(1) });
export type SchedulesDeleteParams = z.infer<typeof SchedulesDeleteParams>;

/** "Run now" — stamps `requestedAt`; the host fires it on its next tick. */
export const SchedulesRunNowParams = z.object({ id: z.string().min(1) });
export type SchedulesRunNowParams = z.infer<typeof SchedulesRunNowParams>;

export const ScheduledTaskResult = z.object({ task: ScheduledTask });

export const ScheduleUpsertedEvent = z.object({ task: ScheduledTask });
export type ScheduleUpsertedEvent = z.infer<typeof ScheduleUpsertedEvent>;

export const ScheduleRemovedEvent = z.object({ taskId: z.string().min(1) });
export type ScheduleRemovedEvent = z.infer<typeof ScheduleRemovedEvent>;

/* ------------------------------ schedule math ---------------------------- */

const hm = (time: string) => {
  const [h = "0", m = "0"] = time.split(":");
  return { h: Number(h), m: Number(m) };
};

/* "09:05" → "9:05". */
export const clockText = (time: string) => {
  const { h, m } = hm(time);
  return `${h}:${String(m).padStart(2, "0")}`;
};

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?$/;
const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

/* One cron field → the allowed values, or null when it doesn't parse. */
function cronField(src: string, [lo, hi]: [number, number]) {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    if (!FIELD.test(part)) return null;
    const [range, stepSrc] = part.split("/");
    const step = stepSrc ? Number(stepSrc) : 1;
    let [a, b] = [lo, hi];
    if (range !== "*") {
      const [x, y] = range.split("-").map(Number);
      a = x;
      b = y ?? (stepSrc ? hi : x);
    }
    if (a < lo || b > hi || a > b || step < 1) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

function parseCron(cron: string) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => cronField(p, RANGES[i]));
  return sets.every(Boolean) ? (sets as Set<number>[]) : null;
}

export const validCron = (cron: string) => !!parseCron(cron);

export const validSchedule = (s: TaskSchedule) => {
  if (s.kind === "cron") return validCron(s.cron ?? "");
  /* Bounds, not just shape — "25:00"/"9:99" would overflow through
     setHours/setMinutes and fire at a wrong wall time. */
  const tm = /^(\d{1,2}):(\d{2})$/.exec(s.time);
  if (!tm || Number(tm[1]) > 23 || Number(tm[2]) > 59) return false;
  if (s.kind === "once")
    return !!s.date && !Number.isNaN(new Date(`${s.date}T00:00`).getTime());
  return true;
};

/**
 * The next time this schedule fires strictly after `after`; null when it
 * never will (a past "once", or a cron that doesn't parse). The scheduler
 * anchors on `lastFiredAt`, so a slept-through slot surfaces as one due
 * time on the next tick — missed occurrences coalesce by construction.
 */
export function nextRunAt(s: TaskSchedule, after: Date): Date | null {
  if (s.kind === "cron") {
    const sets = parseCron(s.cron ?? "");
    if (!sets) return null;
    const [mins, hours, doms, months, dows] = sets;
    const d = new Date(after);
    d.setSeconds(0, 0);
    // Minute walk, capped at ~1 year.
    for (let i = 0; i < 366 * 24 * 60; i++) {
      d.setMinutes(d.getMinutes() + 1);
      if (
        mins.has(d.getMinutes()) &&
        hours.has(d.getHours()) &&
        doms.has(d.getDate()) &&
        months.has(d.getMonth() + 1) &&
        dows.has(d.getDay())
      )
        return d;
    }
    return null;
  }
  const { h, m } = hm(s.time);
  if (s.kind === "once") {
    if (!s.date) return null;
    const d = new Date(`${s.date}T00:00`);
    d.setHours(h, m, 0, 0);
    return d > after ? d : null;
  }
  if (s.kind === "hourly") {
    const d = new Date(after);
    d.setMinutes(m, 0, 0);
    if (d <= after) d.setHours(d.getHours() + 1);
    return d;
  }
  for (let i = 0; i < 8; i++) {
    const d = new Date(after);
    d.setDate(d.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (d <= after) continue;
    const dow = d.getDay();
    if (s.kind === "weekdays" && (dow === 0 || dow === 6)) continue;
    if (s.kind === "weekly" && dow !== (s.day ?? 1)) continue;
    return d;
  }
  return null;
}

/* "Thu 2 Oct" — the run-title date leg. */
export const dateText = (d: Date) =>
  `${DAY_NAMES[d.getDay()].slice(0, 3)} ${d.getDate()} ${d.toLocaleString("en", { month: "short" })}`;

/** A run's session title: "<task name> · Thu 2 Oct". */
export const runTitle = (name: string, at: Date) => `${name} · ${dateText(at)}`;
