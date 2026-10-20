import type { V3Agent, V3Data, V3Status, V3Thread, V3Ticket } from "./v3-types";

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

export const goalOf = (d: V3Data, id: string) =>
  d.goals.find((g) => g.id === id);

/** Threads on a ticket, oldest hand first (start times are zero-padded
   clock strings, so text order is time order). */
export const threadsOf = (d: V3Data, ticketId: string): V3Thread[] =>
  d.threads
    .filter((t) => t.ticketId === ticketId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

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

/** The counts strip under a title: how many agents sit in each status. */
export function teamCounts(d: V3Data) {
  const c: Partial<Record<V3Status, number>> = {};
  for (const a of d.agents) {
    const s = agentStatus(d, a.id);
    c[s] = (c[s] ?? 0) + 1;
  }
  return c;
}
