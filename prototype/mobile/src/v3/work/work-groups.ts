import type { V3Data, V3Status, V3Thread, V3Ticket } from "@lilos/ui/v3-data";
import type {
  ProjectPageVM,
  WorkThreadGroup,
  WorkTicketGroup,
} from "@lilos/ui-native/v3";
import { CEO_THREAD_ID, threadRowVM, ticketOf, ticketRowVM } from "../model";

/* Work groups the company by project and floats what wants you to the top of
   each group, so done work never buries the live work. Pure. */

const CHAT = "chat";

const THREAD_RANK: Partial<Record<V3Status, number>> = {
  needs: 0,
  stuck: 1,
  failed: 1,
  working: 2,
  waiting: 4,
};
const UNSEEN_DONE_RANK = 3;
const OTHER_RANK = 5;

const TICKET_RANK: Partial<Record<V3Status, number>> = {
  needs: 0,
  stuck: 1,
  failed: 1,
  working: 2,
  waiting: 3,
  planned: 4,
};

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

/** A thread belongs to its own project, else its ticket's. */
function projectIdOf(d: V3Data, t: V3Thread): string | undefined {
  return (
    t.projectId ?? (t.ticketId ? ticketOf(d, t.ticketId)?.projectId : undefined)
  );
}

function openCaption(open: number): string {
  return open === 0 ? "Nothing open" : `${open} open`;
}

export function threadGroups(d: V3Data): WorkThreadGroup[] {
  const known = new Set(d.projects.map((p) => p.id));
  const bucket = new Map<string, V3Thread[]>();
  for (const t of d.threads) {
    if (t.id === CEO_THREAD_ID) continue;
    const pid = projectIdOf(d, t);
    const key = pid && known.has(pid) ? pid : CHAT;
    const list = bucket.get(key);
    if (list) list.push(t);
    else bucket.set(key, [t]);
  }
  const groups: WorkThreadGroup[] = [];
  const build = (id: string, name: string, about?: string) => {
    const all = bucket.get(id);
    if (!all || all.length === 0) return;
    groups.push({
      id,
      name,
      about,
      caption: openCaption(all.filter((t) => t.status !== "done").length),
      rows: all
        .filter((t) => !isQuiet(t))
        .sort(byThreadOrder)
        .map((t) => threadRowVM(d, t)),
      quiet: all
        .filter(isQuiet)
        .sort(byFinish)
        .map((t) => threadRowVM(d, t)),
    });
  };
  for (const p of d.projects) build(p.id, p.name, p.about);
  build(CHAT, "Chat");
  return groups;
}

export function ticketGroups(d: V3Data): WorkTicketGroup[] {
  const groups: WorkTicketGroup[] = [];
  const rank = (t: V3Ticket) => TICKET_RANK[t.status] ?? 5;
  for (const p of d.projects) {
    const all = d.tickets.filter((t) => t.projectId === p.id);
    if (all.length === 0) continue;
    const live = all.filter((t) => t.status !== "done");
    groups.push({
      id: p.id,
      name: p.name,
      about: p.about,
      caption: openCaption(live.length),
      rows: live
        .sort((a, b) => rank(a) - rank(b))
        .map((t) => ticketRowVM(d, t)),
      done: all
        .filter((t) => t.status === "done")
        .sort((a, b) => (a.doneAgo ?? 0) - (b.doneAgo ?? 0))
        .map((t) => ticketRowVM(d, t)),
    });
  }
  return groups;
}

/** One project's page: its threads and (with tickets on) its tickets, empty
    groups included so the page can say "nothing yet". Undefined when the id
    names no project. */
export function projectPage(d: V3Data, id: string): ProjectPageVM | undefined {
  const project = d.projects.find((p) => p.id === id);
  if (!project && id !== CHAT) return undefined;
  const name = project?.name ?? "Chat";
  const about = project?.about;
  const threads = threadGroups(d).find((g) => g.id === id) ?? {
    id,
    name,
    about,
    caption: openCaption(0),
    rows: [],
    quiet: [],
  };
  const tickets =
    project && d.features.tickets
      ? (ticketGroups(d).find((g) => g.id === id) ?? {
          id,
          name,
          about,
          caption: openCaption(0),
          rows: [],
          done: [],
        })
      : undefined;
  return { id, name, about, threads, tickets };
}
