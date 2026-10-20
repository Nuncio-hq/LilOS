import { validCron } from "../schedule/schedule-text";
import type { V3Schedule, V3ScheduleWhen } from "./v3-types";

/* Plain-words schedules for v3: kinds and wording. A saved schedule keeps
   `next` as a phrase, so saving computes it here against the real clock.
   Times are always "HH:MM". Custom (cron) is only checked loosely and never
   walked: its next run reads "Per its cron" rather than a time the
   prototype could get wrong. */

export type When = V3ScheduleWhen;

export const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export const KINDS: { id: When["kind"]; label: string }[] = [
  { id: "hourly", label: "Every hour" },
  { id: "daily", label: "Every day" },
  { id: "weekdays", label: "Weekdays" },
  { id: "weekly", label: "Every week" },
  { id: "once", label: "Once" },
  { id: "cron", label: "Custom" },
];

/** What a cron schedule's next run says instead of a time. */
export const PER_CRON = "Per its cron";

export const pad = (n: number) => String(n).padStart(2, "0");

const hm = (time: string) => {
  const [h = "0", m = "0"] = time.split(":");
  return { h: Number(h), m: Number(m) };
};

/** Today as "YYYY-MM-DD", local time. */
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** "Mon 19 Oct". */
const dateText = (d: Date) =>
  `${DAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${d.toLocaleString("en", { month: "short" })}`;

/** Whether the schedule can be saved: five cron fields for Custom, else a
    real time, and a date for "once". */
export function validWhen(w: When): boolean {
  if (w.kind === "cron") return validCron(w.cron ?? "");
  const t = /^(\d{1,2}):(\d{2})$/.exec(w.time);
  if (!t || Number(t[1]) > 23 || Number(t[2]) > 59) return false;
  if (w.kind !== "once") return true;
  return !!w.date && !Number.isNaN(new Date(`${w.date}T00:00`).getTime());
}

/** "Weekdays at 09:00", "Every Monday at 09:00", "Every hour at :15"… */
export function describeWhen(w: When): string {
  if (w.kind === "cron") return `Custom: ${w.cron?.trim() || "…"}`;
  const { h, m: min } = hm(w.time);
  const at = `${pad(h)}:${pad(min)}`;
  switch (w.kind) {
    case "hourly":
      return min ? `Every hour at :${pad(min)}` : "Every hour";
    case "daily":
      return `Every day at ${at}`;
    case "weekdays":
      return `Weekdays at ${at}`;
    case "weekly":
      return `Every ${DAYS[w.day ?? 1]} at ${at}`;
    case "once":
      return w.date
        ? `Once, ${dateText(new Date(`${w.date}T00:00`))} at ${at}`
        : `Once at ${at}`;
  }
}

/** The next time this fires after `now`; null when it never will (a once
    that is already past). Cron is not walked here (see nextWords). */
function nextRun(w: When, now: Date): Date | null {
  const { h, m } = hm(w.time);
  if (w.kind === "once") {
    if (!w.date) return null;
    const d = new Date(`${w.date}T00:00`);
    d.setHours(h, m, 0, 0);
    return d > now ? d : null;
  }
  if (w.kind === "hourly") {
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
    if (w.kind === "weekdays" && (dow === 0 || dow === 6)) continue;
    if (w.kind === "weekly" && dow !== (w.day ?? 1)) continue;
    return d;
  }
  return null;
}

/** "Today 14:00", "Tomorrow 09:00", "Fri 09:00", "Thu 9 Oct 09:00": a real
    date in the words a saved schedule carries (the app builds `next` and
    `last.at` with it, so a list reads one way whoever made the phrase). */
export function whenWords(d: Date, now: Date): string {
  const at = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  if (diff === 0) return `Today ${at}`;
  if (diff === 1) return `Tomorrow ${at}`;
  if (diff > 1 && diff < 7) return `${DAYS[d.getDay()].slice(0, 3)} ${at}`;
  return `${dateText(d)} ${at}`;
}

/** The next run in words; null when it never runs again. */
export function nextWords(w: When, now = new Date()): string | null {
  if (w.kind === "cron") return PER_CRON;
  const d = nextRun(w, now);
  return d ? whenWords(d, now) : null;
}

/* Sooner-first rank for the phrases a saved schedule carries ("Today 14:00",
   "Tonight 02:00", "Tomorrow 09:00", then weekdays and dates in list order). */
const RANK = [/^(now|today)/i, /^tonight/i, /^tomorrow/i];

/** The soonest next run among active schedules, e.g. "Tomorrow 09:00". */
export function soonestNext(list: V3Schedule[]): string | undefined {
  const rank = (n: string) => {
    const i = RANK.findIndex((re) => re.test(n));
    return i < 0 ? RANK.length : i;
  };
  return list
    .filter(
      (s) => !s.paused && s.next !== PER_CRON && s.next !== "No more runs",
    )
    .sort(
      (a, b) =>
        rank(a.next) - rank(b.next) ||
        (rank(a.next) < RANK.length
          ? a.next.slice(-5).localeCompare(b.next.slice(-5))
          : 0),
    )[0]?.next;
}
