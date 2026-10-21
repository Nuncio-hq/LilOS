import type { V3Ask, V3Data } from "./v3-data-types";
import { soonestRun } from "./v3-schedule-text";
import type { V3Agent, V3Status, V3Thread, V3Ticket } from "./v3-types";

/* Lookups every v3 page shares. Pure; the shell owns the data. */

/** An id can outlive its agent: a fired agent's threads, asks and schedules
   stay on record. A miss is undefined, never another agent in its place. */
export const agentOf = (d: V3Data, id: string): V3Agent | undefined =>
  d.agents.find((a) => a.id === id);

/** What stands in for the name of an agent that is no longer on the team. */
export const FORMER_AGENT = "Former agent";

/** An agent's name for a label, or FORMER_AGENT once it is gone. */
export const agentNameOf = (d: V3Data, id: string): string =>
  agentOf(d, id)?.name ?? FORMER_AGENT;

/** Who a new chat starts with when nobody was chosen: the CEO if the company
   has that position, else the first agent (none when nobody is hired). */
export const defaultAgent = (d: V3Data): V3Agent | undefined =>
  d.agents.find((a) => a.id === d.ceoId) ?? d.agents[0];

export const ticketOf = (d: V3Data, id: string): V3Ticket | undefined =>
  d.tickets.find((t) => t.id === id);

export const projectOf = (d: V3Data, id: string) =>
  d.projects.find((p) => p.id === id);

/** What a thread is filed under, as a short label: its ticket, else the
   project it lives in, else "Chat" (a plain chat, in no project). The trail,
   the rows and the cards all say it the same way. */
export const threadTag = (d: V3Data, t: V3Thread): string =>
  t.ticketId ??
  (t.projectId ? projectOf(d, t.projectId)?.name : undefined) ??
  "Chat";

/** The same label for an ask: its ticket, else where the thread it was asked
   in lives. */
export const askTag = (d: V3Data, a: V3Ask): string => {
  const thread = d.threads.find((t) => t.id === a.threadId);
  return a.ticketId ?? (thread ? threadTag(d, thread) : "Chat");
};

export const goalOf = (d: V3Data, id: string) =>
  d.goals.find((g) => g.id === id);

/** Threads on a ticket, oldest hand first. Clock strings tie inside a
    minute; `openedAt` breaks that so a reassignment stays after the first hand. */
export const threadsOf = (d: V3Data, ticketId: string): V3Thread[] =>
  d.threads
    .filter((t) => t.ticketId === ticketId)
    .sort(
      (a, b) =>
        a.startedAt.localeCompare(b.startedAt) ||
        (a.openedAt ?? 0) - (b.openedAt ?? 0),
    );

/** How urgent a status is on a person, most urgent first: what needs you,
   then what is stuck or running, then what ended. An agent wears its most
   urgent thread's status. */
const URGENCY: V3Status[] = [
  "needs",
  "stuck",
  "working",
  "waiting",
  "failed",
  "done",
  "idle",
];

/** Where a status sits in `URGENCY`; one that is not listed sorts last. */
const urgency = (s: V3Status): number => {
  const i = URGENCY.indexOf(s);
  return i < 0 ? URGENCY.length : i;
};

/** The thread an agent is on now: live first, else the newest. */
export function agentThread(d: V3Data, agentId: string): V3Thread | undefined {
  const mine = d.threads.filter((t) => t.agentId === agentId);
  return [...mine].sort((a, b) => urgency(a.status) - urgency(b.status))[0];
}
/** Agents whose boss is `managerId` (absent = the owner). A `reportsTo`
    that names nobody is the owner too (D-#775): the row is gone, so they
    report up. Order is the roster's order. */
export function reportsOf(
  agents: readonly V3Agent[],
  managerId?: string,
): V3Agent[] {
  const ids = new Set(agents.map((a) => a.id));
  return agents.filter((a) => {
    const boss = a.reportsTo && ids.has(a.reportsTo) ? a.reportsTo : undefined;
    return boss === managerId;
  });
}

/** An agent's status is its current thread's; a finished or absent thread
   means the agent is idle until it gets the next ticket. */
export function agentStatus(d: V3Data, agentId: string): V3Status {
  const s = agentThread(d, agentId)?.status;
  return !s || s === "done" ? "idle" : s;
}

/** The one dot an agent wears in the sidebar: its most urgent thread's
   status (needs > working > failed > unseen > idle). A thread that finished
   past your read mark (D-#563) counts as `done`, its own colour, so
   "something finished that you have not seen" shows on the person; once seen
   it is idle again. Unlike `agentStatus`, which says what the agent is doing
   now, this is what wants your eye. */
export function agentDot(d: V3Data, agentId: string): V3Status {
  let dot: V3Status = "idle";
  for (const t of d.threads) {
    if (t.agentId !== agentId) continue;
    const s = t.status === "done" ? (t.unseen ? "done" : "idle") : t.status;
    if (urgency(s) < urgency(dot)) dot = s;
  }
  return dot;
}

/** The ticket an agent holds now. */
export function agentTicket(d: V3Data, agentId: string): V3Ticket | undefined {
  const order: V3Status[] = [
    "needs",
    "stuck",
    "working",
    "waiting",
    "failed",
    "planned",
  ];
  return d.tickets
    .filter((t) => t.owner === agentId && t.status !== "done")
    .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))[0];
}

/** What a ticket waits on, as one plain phrase: "You", "CEO", "HB-11". */
export function waitingLabel(d: V3Data, t: V3Ticket): string {
  const w = t.waitingOn;
  if (!w) return "—";
  if (w.kind === "you") return "You";
  if (w.kind === "agent") return agentNameOf(d, w.agentId);
  return w.ticketId;
}

/** Goal progress: done tickets over all tickets under it. */
export function goalProgress(d: V3Data, goalId: string) {
  const ts = d.tickets.filter((t) => t.goalId === goalId);
  return {
    done: ts.filter((t) => t.status === "done").length,
    total: ts.length,
  };
}

/** Threads on the live board, in board order. A finished thread is on it
    only while you have not seen it. Home's idle count is who is not here:
    the same agents Threads draws as idle cards (D-#774). */
export const LIVE_RANK: Partial<Record<V3Status, number>> = {
  needs: 0,
  stuck: 1,
  failed: 1.5,
  working: 2,
  done: 3,
};

export const onLiveBoard = (t: V3Thread): boolean =>
  t.status in LIVE_RANK && (t.status !== "done" || t.unseen === true);

/** How many threads wear one status. Home and Threads both read this, so
    the two pages cannot disagree (D-#774). Status itself is `threadStatus`
    in client-runtime (D-#33); this only counts. */
export const threadsIn = (
  threads: readonly V3Thread[],
  status: V3Status,
): number => threads.filter((t) => t.status === status).length;

/** Finished, and not opened since. */
export const unseenThreads = (threads: readonly V3Thread[]): V3Thread[] =>
  threads.filter((t) => t.status === "done" && t.unseen);

/** Agents with nothing on the live board. */
export function asleepAgents(d: V3Data): V3Agent[] {
  const busy = new Set(d.threads.filter(onLiveBoard).map((t) => t.agentId));
  return d.agents.filter((a) => !busy.has(a.id));
}

/** An idle agent's next scheduled run, "Morning triage · Tomorrow 09:00".
    The soonest by `nextAt` (D-#774). Absent when nothing will run; the
    row then keeps `agent.next`. */
export function nextRunLabel(d: V3Data, agentId: string): string | undefined {
  const s = soonestRun(d.schedules.filter((x) => x.agentId === agentId));
  return s ? `${s.title} · ${s.next}` : undefined;
}

/** One finished thing to look at. Needs you and Home share this list
    (D-#774): unseen threads, then a done ticket from the last three hours
    that no unseen thread already covers. */
export interface LookAtRow {
  key: string;
  title: string;
  ticketId?: string;
  /** Where it lives: its ticket, its project, or "Chat". */
  tag: string;
  by: string;
  note: string;
  minutes: number;
  threadId?: string;
  unseen: boolean;
}

export function resultsToLookAt(data: V3Data): LookAtRow[] {
  const rows: LookAtRow[] = [];
  const seenTickets = new Set<string>();
  for (const th of unseenThreads(data.threads)) {
    const t = th.ticketId ? ticketOf(data, th.ticketId) : undefined;
    if (th.ticketId) seenTickets.add(th.ticketId);
    rows.push({
      key: th.id,
      title: th.title,
      ticketId: th.ticketId,
      tag: threadTag(data, th),
      by: th.agentId,
      note: th.quote ? `“${th.quote}”` : (th.summary ?? ""),
      minutes: th.doneAgo ?? t?.doneAgo ?? t?.since ?? 0,
      threadId: th.id,
      unseen: true,
    });
  }
  for (const t of data.tickets) {
    if (
      t.status !== "done" ||
      (t.doneAgo ?? Number.POSITIVE_INFINITY) >= 180 ||
      seenTickets.has(t.id)
    )
      continue;
    const th = threadsOf(data, t.id).at(-1);
    const pr = t.result?.pr;
    rows.push({
      key: t.id,
      title: t.title,
      ticketId: t.id,
      tag: t.id,
      by: t.owner,
      note: th?.summary ?? (pr ? `PR #${pr.num} · ${pr.branch}` : "Done"),
      minutes: t.doneAgo ?? 0,
      threadId: th?.id,
      unseen: false,
    });
  }
  return rows.sort((a, b) => a.minutes - b.minutes);
}
