import type { V3Data, V3Status, V3Thread, V3Ticket } from "@lilos/ui/v3-data";
import type {
  ProjectPageVM,
  WorkItemVM,
  WorkProjectVM,
} from "@lilos/ui-native/v3";
import {
  CEO_THREAD_ID,
  personOf,
  threadRowVM,
  ticketOf,
  ticketRowVM,
} from "../model";

/* What Work and a project's page say about the company: the open work of each
   project (tickets, and plain chats that belong to no ticket), what wants you
   across all of them, and the full lists behind each project. Pure. */

/** The group of threads that live in no project. */
export const CHAT_ID = "chat";

/** Most pressing first: what wants you, what is stuck, what runs, what
    finished unseen, what waits, what is still to come. */
const RANK: Partial<Record<V3Status, number>> = {
  needs: 0,
  stuck: 1,
  failed: 1,
  working: 2,
  done: 3,
  waiting: 4,
  planned: 5,
};
const rankOf = (s: V3Status) => RANK[s] ?? 5;

/** A thread belongs to its own project, else its ticket's, else Chat. */
function projectIdOf(d: V3Data, t: V3Thread): string {
  const pid =
    t.projectId ??
    (t.ticketId ? ticketOf(d, t.ticketId)?.projectId : undefined);
  return pid && d.projects.some((p) => p.id === pid) ? pid : CHAT_ID;
}

/** An item and what orders it: how pressing, then how long it has waited. */
type Ranked = { item: WorkItemVM; rank: number; since: number };

function byPressing(a: Ranked, b: Ranked): number {
  return a.rank - b.rank || b.since - a.since;
}

function ticketItem(d: V3Data, t: V3Ticket, where: string): Ranked {
  return {
    item: {
      key: `ticket:${t.id}`,
      kind: "ticket",
      id: t.id,
      title: t.title,
      status: t.status,
      who: personOf(d, t.owner),
      where,
    },
    rank: rankOf(t.status),
    since: t.since,
  };
}

function threadItem(d: V3Data, t: V3Thread, where: string): Ranked {
  return {
    item: {
      key: `thread:${t.id}`,
      kind: "thread",
      id: t.id,
      title: t.title,
      status: t.status,
      who: personOf(d, t.agentId),
      where,
    },
    rank: rankOf(t.status),
    since: t.minutes,
  };
}

/** Open work in one project: its tickets that are not done, and the plain
    threads (those on no ticket of the project) that are live or finished
    but unseen. A ticket's own threads are on the ticket's page. */
function openRanked(d: V3Data, projectId: string, where: string): Ranked[] {
  const tickets = d.features.tickets
    ? d.tickets.filter((t) => t.projectId === projectId)
    : [];
  const ticketIds = new Set(tickets.map((t) => t.id));
  const out: Ranked[] = tickets
    .filter((t) => t.status !== "done")
    .map((t) => ticketItem(d, t, where));
  for (const t of d.threads) {
    if (t.id === CEO_THREAD_ID || projectIdOf(d, t) !== projectId) continue;
    if (t.ticketId && ticketIds.has(t.ticketId)) continue;
    if (t.status === "done" && !t.unseen) continue;
    out.push(threadItem(d, t, where));
  }
  return out.sort(byPressing);
}

/** What counts in the one-line summary, most pressing first. */
const SUMMARY: { statuses: V3Status[]; words: string }[] = [
  { statuses: ["needs"], words: "needs you" },
  { statuses: ["stuck", "failed"], words: "stuck" },
  { statuses: ["working"], words: "working" },
  { statuses: ["done"], words: "to look at" },
  { statuses: ["waiting"], words: "waiting" },
  { statuses: ["planned"], words: "planned" },
];
const SUMMARY_PARTS = 3;

/** "2 working · 1 stuck": the three most pressing counts. */
export function summaryOf(items: readonly { status: V3Status }[]): string {
  if (items.length === 0) return "Nothing open";
  const parts: string[] = [];
  for (const s of SUMMARY) {
    const n = items.filter((i) => s.statuses.includes(i.status)).length;
    if (n > 0) parts.push(`${n} ${s.words}`);
  }
  return parts.slice(0, SUMMARY_PARTS).join(" · ");
}

/** The status a project wears: its most pressing item's. Absent when nothing
    is open, so a quiet project shows no dot. */
export function worstStatus(
  items: readonly { status: V3Status }[],
): V3Status | undefined {
  return [...items].sort((a, b) => rankOf(a.status) - rankOf(b.status))[0]
    ?.status;
}

/** What Attention is about: things that want a person, worst first. A stuck
    or failed item comes before one that waits on you: an agent that is going
    round in circles burns money and nothing else on the phone says so, while
    a decision waiting on you is already a badge on Needs you and the lead of
    Home. Inside a severity the longest-waiting leads. */
const ATTENTION_RANK: Partial<Record<V3Status, number>> = {
  stuck: 0,
  failed: 0,
  needs: 1,
};

/** How many lines Attention shows. The rest of what wants you stays in its
    project's module (it is not hidden behind a "more"). */
export const ATTENTION_TOP = 3;

/** Every project's open work, most pressing first; Chat only while it holds
    something. */
function rankedByProject(d: V3Data) {
  return [
    ...d.projects.map((p) => ({ id: p.id, name: p.name })),
    { id: CHAT_ID, name: "Chat" },
  ]
    .map((g) => ({ ...g, ranked: openRanked(d, g.id, g.name) }))
    .filter((g) => g.id !== CHAT_ID || g.ranked.length > 0);
}

/** The same, as the lines a module shows. */
export function openByProject(d: V3Data) {
  return rankedByProject(d).map((g) => ({
    id: g.id,
    name: g.name,
    items: g.ranked.map((r) => r.item),
  }));
}

export type WorkOverview = {
  attention: WorkItemVM[];
  projects: WorkProjectVM[];
};

/** The Work tab. Attention shows the worst few; a project's module leaves out
    exactly those and lists the rest of its open work, so no line shows twice
    and nothing is hidden. Its summary counts everything open in the project. */
export function workOverview(d: V3Data): WorkOverview {
  const groups = rankedByProject(d);
  const attention = groups
    .flatMap((g) => g.ranked)
    .filter((r) => r.item.status in ATTENTION_RANK)
    .sort(
      (a, b) =>
        (ATTENTION_RANK[a.item.status] ?? 0) -
          (ATTENTION_RANK[b.item.status] ?? 0) || b.since - a.since,
    )
    .slice(0, ATTENTION_TOP)
    .map((r) => r.item);
  const shown = new Set(attention.map((i) => i.key));
  const projects = groups
    .map((g) => {
      const all = g.ranked.map((r) => r.item);
      return {
        id: g.id,
        name: g.name,
        summary: summaryOf(all),
        items: all.filter((i) => !shown.has(i.key)),
      };
    })
    // Chat is a module only while it has something Attention does not show.
    .filter((p) => p.id !== CHAT_ID || p.items.length > 0);
  return { attention, projects };
}

/* The page's own order: what wants you first inside each list, so finished
   work never buries the live work. */

const THREAD_RANK: Partial<Record<V3Status, number>> = {
  needs: 0,
  stuck: 1,
  failed: 1,
  working: 2,
  waiting: 4,
};
const UNSEEN_DONE_RANK = 3;
const OTHER_RANK = 5;

/** Finished and already looked at: nothing new about it. */
const isQuiet = (t: V3Thread) => t.status === "done" && !t.unseen;

function threadRank(t: V3Thread): number {
  if (t.status === "done") return UNSEEN_DONE_RANK;
  return THREAD_RANK[t.status] ?? OTHER_RANK;
}

/** Newest finish first; a thread with no finish time goes after the rest. */
const byFinish = (a: V3Thread, b: V3Thread) =>
  (a.doneAgo ?? Number.POSITIVE_INFINITY) -
  (b.doneAgo ?? Number.POSITIVE_INFINITY);

function byThreadOrder(a: V3Thread, b: V3Thread): number {
  const ra = threadRank(a);
  const rb = threadRank(b);
  if (ra !== rb) return ra - rb;
  return ra === UNSEEN_DONE_RANK || ra === OTHER_RANK ? byFinish(a, b) : 0;
}

/** One project's page: all of its threads, and (with tickets on) all of its
    tickets, done work apart from the open. Undefined when the id names no
    project. */
export function projectPage(d: V3Data, id: string): ProjectPageVM | undefined {
  const project = d.projects.find((p) => p.id === id);
  if (!project && id !== CHAT_ID) return undefined;
  const threads = d.threads.filter(
    (t) => t.id !== CEO_THREAD_ID && projectIdOf(d, t) === id,
  );
  const tickets =
    project && d.features.tickets
      ? d.tickets.filter((t) => t.projectId === id)
      : undefined;
  return {
    id,
    name: project?.name ?? "Chat",
    about: project?.about,
    threads: {
      open: threads
        .filter((t) => !isQuiet(t))
        .sort(byThreadOrder)
        .map((t) => threadRowVM(d, t)),
      done: threads
        .filter(isQuiet)
        .sort(byFinish)
        .map((t) => threadRowVM(d, t)),
    },
    tickets: tickets && {
      open: tickets
        .filter((t) => t.status !== "done")
        .sort((a, b) => rankOf(a.status) - rankOf(b.status))
        .map((t) => ticketRowVM(d, t)),
      done: tickets
        .filter((t) => t.status === "done")
        .sort((a, b) => (a.doneAgo ?? 0) - (b.doneAgo ?? 0))
        .map((t) => ticketRowVM(d, t)),
    },
  };
}
