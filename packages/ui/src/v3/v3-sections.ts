import type { V3Data } from "./v3-data-types";
import { boardStatus, snoozed } from "./v3-model";
import type { V3Thread } from "./v3-types";

/* The thread list's sections (#862), borrowed from T3 Code's sidebar
   (docs/user/thread-sidebar.md): what came back to you is on top, work in
   progress folds away, finished work parks on a shelf of its own, and a
   thread can sleep until later. One set of rules feeds Threads → All, the
   sidebar's thread list and Home's order. Helpers never get a row
   (D-#847); a parent waiting on them folds into Working with the rest of
   the work in flight. Pin, settle and snooze are relay state; only the
   Working fold is the device's own. */

export type V3Section = "pinned" | "active" | "working" | "snoozed" | "settled";

/** The sections, in the order the list draws them. */
export const SECTION_ORDER: V3Section[] = [
  "pinned",
  "active",
  "working",
  "snoozed",
  "settled",
];

/** Which section a listed thread lives in. `settled` says it is already on
    the shelf — the app's put-away list is `archivedThreads` until the
    backend slice renames archive to settle (the UI says Done either way,
    #887). */
export const sectionOf = (
  d: V3Data,
  t: V3Thread,
  opts: { settled?: boolean; now?: number } = {},
): V3Section => {
  const now = opts.now ?? Date.now();
  if (opts.settled) return "settled";
  if (snoozed(t, now)) return "snoozed";
  if (t.pinnedAt !== undefined) return "pinned";
  const s = boardStatus(d, t);
  /* Working folds away what resumes on its own: a running thread, and a
     parent waiting on helpers or other background work (D-#847). A dev
     server left running is not work in flight — its thread ended and
     stays in Active. */
  return s === "working" || s === "waiting" ? "working" : "active";
};

/** The Active list's order: newest back first — when it last finished,
    failed, asked or woke (`cameBackAt`), falling back to its finish or
    open time so a thread with neither sinks to the bottom, never top.
    Home's Recent threads sorts the same way (#862). */
export const backThen = (t: V3Thread, now: number) =>
  t.cameBackAt ??
  t.openedAt ??
  (t.doneAgo !== undefined ? now - t.doneAgo * 60_000 : 0);

export type ThreadSections = Record<V3Section, V3Thread[]>;

/** The thread list as sections, each in its own order: Pinned newest-pin
    first; Active newest-back first; Working keeps the list's newest-first
    arrival order (the thread you last sent work to first); Snoozed by
    soonest wake; Settled newest-settled first. */
export function sectionedThreads(d: V3Data, now = Date.now()): ThreadSections {
  const s: ThreadSections = {
    pinned: [],
    active: [],
    working: [],
    snoozed: [],
    settled: [],
  };
  for (const t of d.threads) {
    // Helpers never get a row (D-#847): they show through their parent.
    if (t.parentId !== undefined) continue;
    s[sectionOf(d, t, { now })].push(t);
  }
  s.pinned.sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  s.active.sort((a, b) => backThen(b, now) - backThen(a, now));
  s.snoozed.sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0));
  s.settled = (d.archivedThreads ?? [])
    .filter((t) => t.parentId === undefined)
    .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
  return s;
}

const HHMM = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** When a snoozed thread comes back, as the shelf shows it: "back 14:32"
    today, "back tomorrow 09:00", "back Tue 09:00" inside the week, or a
    date further out. */
export function snoozeBack(until: number, now = Date.now()): string {
  const d = new Date(until);
  const time = HHMM(d);
  if (d.toDateString() === new Date(now).toDateString()) return `back ${time}`;
  if (d.toDateString() === new Date(now + 86_400_000).toDateString())
    return `back tomorrow ${time}`;
  if (until - now < 7 * 86_400_000)
    return `back ${d.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return `back ${d.getDate()} ${d.toLocaleDateString("en-US", { month: "short" })}`;
}

/** Why a done thread is on the shelf, as the row shows it: "auto · 3
    days idle" for the sweep, "auto · PR #66 merged" for a finished pull
    request. A thread you marked done yourself names no reason — it is just
    Done. */
export function settledReason(t: V3Thread): string {
  const w = t.settledWhy;
  if (!w) return "Done";
  if (w.kind === "idle") return "auto · 3 days idle";
  return `auto · PR #${w.num} ${w.state}`;
}
