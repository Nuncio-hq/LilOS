import type { Schedule, ScheduleKind } from "../types";

/* Plain-words schedules and next-run times for scheduled tasks (#136).
   Pure helpers: the real app's harness owns the clock; these only render. */

export const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export const SCHEDULE_KINDS: { id: ScheduleKind; label: string }[] = [
  { id: "hourly", label: "Every hour" },
  { id: "daily", label: "Every day" },
  { id: "weekdays", label: "Weekdays" },
  { id: "weekly", label: "Every week" },
  { id: "once", label: "Once" },
  { id: "cron", label: "Custom" },
];

const hm = (time: string) => {
  const [h = "0", m = "0"] = time.split(":");
  return { h: Number(h), m: Number(m) };
};

/* "09:05" → "9:05". */
export const clock = (time: string) => {
  const { h, m } = hm(time);
  return `${h}:${String(m).padStart(2, "0")}`;
};

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

export const validSchedule = (s: Schedule) => {
  if (s.kind === "cron") return validCron(s.cron ?? "");
  if (!/^\d{1,2}:\d{2}$/.test(s.time)) return false;
  if (s.kind === "once") return !!s.date;
  return true;
};

/* "Weekdays at 9:00", "Every Monday at 9:00", "Every hour at :15"… */
export function describeSchedule(s: Schedule): string {
  const at = clock(s.time);
  switch (s.kind) {
    case "hourly": {
      const m = hm(s.time).m;
      return m ? `Every hour at :${String(m).padStart(2, "0")}` : "Every hour";
    }
    case "daily":
      return `Every day at ${at}`;
    case "weekdays":
      return `Weekdays at ${at}`;
    case "weekly":
      return `Every ${DAYS[s.day ?? 1]} at ${at}`;
    case "once":
      return s.date
        ? `Once, ${dateText(new Date(`${s.date}T00:00`))} at ${at}`
        : `Once at ${at}`;
    case "cron":
      return `Custom: ${s.cron?.trim() || "…"}`;
  }
}

/* The next time this schedule fires after `now`; null when it never will
   (a past "once", or a cron that doesn't parse). */
export function nextRun(s: Schedule, now: Date): Date | null {
  if (s.kind === "cron") {
    const sets = parseCron(s.cron ?? "");
    if (!sets) return null;
    const [mins, hours, doms, months, dows] = sets;
    const d = new Date(now);
    d.setSeconds(0, 0);
    // Minute walk, capped at ~1 year: fine for a prototype preview.
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
    return d > now ? d : null;
  }
  if (s.kind === "hourly") {
    const d = new Date(now);
    d.setMinutes(m, 0, 0);
    if (d <= now) d.setHours(d.getHours() + 1);
    return d;
  }
  for (let i = 0; i < 8; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (d <= now) continue;
    const dow = d.getDay();
    if (s.kind === "weekdays" && (dow === 0 || dow === 6)) continue;
    if (s.kind === "weekly" && dow !== (s.day ?? 1)) continue;
    return d;
  }
  return null;
}

/* "Thu 2 Oct". */
export const dateText = (d: Date) =>
  `${DAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${d.toLocaleString("en", { month: "short" })}`;

/* "Today 14:00", "Tomorrow 9:00", "Fri 9:00", "Thu 9 Oct 9:00". */
export function whenText(d: Date, now: Date): string {
  const at = clock(`${d.getHours()}:${d.getMinutes()}`);
  const day = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  if (diff === 0) return `Today ${at}`;
  if (diff === 1) return `Tomorrow ${at}`;
  if (diff > 1 && diff < 7) return `${DAYS[d.getDay()].slice(0, 3)} ${at}`;
  return `${dateText(d)} ${at}`;
}
