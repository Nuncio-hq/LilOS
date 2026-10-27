import { baseName } from "../lib/helpers";
import type { V3Ask, V3Data } from "./v3-data-types";
import type { V3Route } from "./v3-page-types";
import { soonestRun } from "./v3-schedule-text";
import type {
  V3Agent,
  V3Project,
  V3Runtime,
  V3Status,
  V3Thread,
  V3Ticket,
  V3Tone,
} from "./v3-types";

/* Lookups every v3 page shares. Pure; the shell owns the data. */

/** The company layer is on unless the app paused it (D-#836). */
export const companyOn = (d: V3Data): boolean => d.features.company !== false;

/** What the shell hands its pages (D-#836). With the company layer paused
   the data is unchanged underneath — tickets, goals, the CEO position and
   every action keep working — but as far as a page can see there is no CEO
   (`ceoId` checks all answer no: no crowns, no brief, no "the CEO will
   handle") and the company has no tickets feature (Work, Goals, Inbox and
   every `features.tickets` control stay off). Nothing is deleted: flip the
   flag and it all comes back. */
export const shownData = (d: V3Data): V3Data =>
  companyOn(d)
    ? d
    : { ...d, ceoId: undefined, features: { ...d.features, tickets: false } };

/** Where a route lands with the company layer paused (D-#836). Pages of the
   hidden layer (Work, Goals, Inbox, People, Hire) fall back to Home; a
   ticket or goal record opens the project it belongs to, so an old link or
   a leftover in the trail still shows something real. Everything else —
   threads, projects, agents, settings — is the daily app's own. Called with
   the real data (it still has the records); a page maps to a page and a
   record to a record, so the nav's shape survives. */
export const shownRoute = (d: V3Data, r: V3Route): V3Route => {
  if (companyOn(d)) return r;
  switch (r.page) {
    case "work":
    case "goals":
    case "inbox":
    case "people":
    case "hire":
      return { page: "home" };
    case "ticket":
      return { page: "project", id: ticketOf(d, r.id)?.projectId ?? "" };
    case "goal":
      return { page: "project", id: goalOf(d, r.id)?.projectId ?? "" };
    default:
      return r;
  }
};

/** An id can outlive its agent: a fired agent's threads, asks and schedules
   stay on record. A miss is undefined, never another agent in its place. */
export const agentOf = (d: V3Data, id: string): V3Agent | undefined =>
  d.agents.find((a) => a.id === id);

/** Whether the owner may take this agent off LilOS (#856): a LilOS agent (an
   outside worker is its connector's to remove, not ours), not the CEO while
   the position shows, and never the last LilOS agent — somebody must run the
   app. `d` is shown data: with the company layer paused `ceoId` is already
   absent, so the hidden position does not stand in the way (D-#836). */
export const removable = (d: V3Data, a: V3Agent): boolean =>
  a.kind !== "outside" &&
  a.id !== d.ceoId &&
  d.agents.some((x) => x.id !== a.id && x.kind !== "outside");

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

export const projectOf = (d: V3Data, id: string | undefined) =>
  id === undefined ? undefined : d.projects.find((p) => p.id === id);

/** The project a folder belongs to: the one whose folder is it or holds it —
   a subfolder, a task worktree in the repo's `.lilos/wt/` (D-#848). The
   deepest match wins when a project sits inside another's folder (#854). */
export const projectForFolder = (
  d: V3Data,
  folder: string | undefined,
): V3Project | undefined => {
  if (!folder) return undefined;
  let best: V3Project | undefined;
  for (const p of d.projects)
    if (folder === p.folder || folder.startsWith(`${p.folder}/`))
      if (!best || p.folder.length > best.folder.length) best = p;
  return best;
};

/** The project a thread lives in: its own, or its ticket's (D-#771), else
   the project its working folder sits in — a folder inside a project's
   folder is that project's, no project record needed on the thread (#854). */
export const threadProjectId = (d: V3Data, t: V3Thread): string | undefined =>
  t.projectId ??
  (t.ticketId ? ticketOf(d, t.ticketId)?.projectId : undefined) ??
  projectForFolder(d, t.folder)?.id;

/** What a thread is filed under, as a short label: its ticket, else the
   project it lives in, else "Chat" (a plain chat, in no project). The trail,
   the rows and the cards all say it the same way. With the company layer
   paused (D-#836) a ticket names nothing you can see, so the tag is the
   thread's project instead. A chat that runs in a folder names it, so a
   folder that is no project is still easy to spot (#854). */
export const threadTag = (d: V3Data, t: V3Thread): string => {
  const project = threadProjectId(d, t);
  const name = project ? projectOf(d, project)?.name : undefined;
  const tag = name ?? (t.folder ? `Chat · ${baseName(t.folder)}` : "Chat");
  if (!companyOn(d)) return tag;
  return t.ticketId ?? tag;
};

/** The same label for an ask: its ticket, else where the thread it was asked
   in lives. Paused, the thread's place stands in for the ticket's id. */
export const askTag = (d: V3Data, a: V3Ask): string => {
  const thread = d.threads.find((t) => t.id === a.threadId);
  if (!companyOn(d)) return thread ? threadTag(d, thread) : "Chat";
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

/* Helper threads (D-#844): a `task_*` hand-off runs as an ordinary thread
   with `parentId` lineage to the thread that created it. Helpers have no
   row of their own in the lists — they show through their parent, the same
   rule T3 Code applies to subagent threads in its sidebar (D-#847). */

/** A thread record by id, active or archived. */
export const threadOf = (d: V3Data, id: string): V3Thread | undefined =>
  d.threads.find((t) => t.id === id) ??
  d.archivedThreads?.find((t) => t.id === id);

/** A thread's helpers, oldest first. */
export const childrenOf = (d: V3Data, parentId: string): V3Thread[] =>
  d.threads
    .filter((t) => t.parentId === parentId)
    .sort(
      (a, b) =>
        a.startedAt.localeCompare(b.startedAt) ||
        (a.openedAt ?? 0) - (b.openedAt ?? 0),
    );

/** The statuses that raise a hand: needing you, stuck or failed — what a
   snooze ends early for (an ask or a fresh failure is allowed to pull a
   thread back, #862). */
const RAISED_HAND: V3Status[] = ["needs", "stuck", "failed"];

/** Snoozed right now: hidden until its wake time while it keeps working
   underneath. It comes back early when it raises a hand — an ask, a stuck
   or failed run — and your message ends the snooze too (the mock clears
   `snoozedUntil` then; the rule is T3 Code's sidebar's). */
export const snoozed = (t: V3Thread, now = Date.now()): boolean =>
  t.snoozedUntil !== undefined &&
  t.snoozedUntil > now &&
  !RAISED_HAND.includes(t.status);

/** The threads lists draw: helper threads have no row of their own
   (D-#847), and a snoozed thread sleeps on the Snoozed shelf until it
   wakes (#862). */
export const listedThreads = (
  threads: readonly V3Thread[],
  now = Date.now(),
): V3Thread[] =>
  threads.filter((t) => t.parentId === undefined && !snoozed(t, now));

/** The thread whose row stands in for `id`: a helper has no row, so an open
   helper marks its nearest non-helper ancestor (T3's
   `resolveSidebarRowThreadId`). A broken chain — a missing parent or a
   cycle — resolves to the thread itself, which matches no row. */
export const listedAncestorOf = (d: V3Data, id: string): string => {
  const seen = new Set<string>();
  let t = threadOf(d, id);
  while (t?.parentId && !seen.has(t.id)) {
    seen.add(t.id);
    t = threadOf(d, t.parentId);
  }
  return t?.id ?? id;
};

/** The helper statuses that still count as work in flight for the parent. */
const HELPER_LIVE: V3Status[] = ["working", "waiting", "needs", "stuck"];

/** A thread's helpers still on the job. */
export const liveHelpersOf = (d: V3Data, parentId: string): V3Thread[] =>
  childrenOf(d, parentId).filter((t) => HELPER_LIVE.includes(t.status));

/** What a thread reads as on the boards: a parent only waiting on helpers
   is working, not idle — its helpers are the work (D-#847). */
export const boardStatus = (d: V3Data, t: V3Thread): V3Status =>
  (t.status === "waiting" || t.status === "idle") &&
  liveHelpersOf(d, t.id).length > 0
    ? "working"
    : t.status;

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
  const t = agentThread(d, agentId);
  const s = t && boardStatus(d, t);
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
    const s =
      t.status === "done" ? (t.unseen ? "done" : "idle") : boardStatus(d, t);
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

/** What a ticket waits on, as one plain phrase: "You", "the CEO", "HB-11".
    No holder stays "the CEO" — never another agent's name (D-#778). */
export function waitingLabel(d: V3Data, t: V3Ticket): string {
  const w = t.waitingOn;
  if (!w) return "—";
  if (w.kind === "you") return "You";
  if (w.kind === "agent") return agentNameOf(d, w.agentId);
  if (w.kind === "ceo") {
    const ceo = d.agents.find((a) => a.id === d.ceoId);
    return ceo?.name ?? "the CEO";
  }
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

export const onLiveBoard = (d: V3Data, t: V3Thread): boolean => {
  const s = boardStatus(d, t);
  return s in LIVE_RANK && (s !== "done" || t.unseen === true);
};

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

/** Agents with nothing on the live board. A helper's own thread is hidden
   from the board, but it still marks its agent busy (D-#847). */
export function asleepAgents(d: V3Data): V3Agent[] {
  const busy = new Set(
    d.threads
      .filter((t) =>
        t.parentId === undefined
          ? onLiveBoard(d, t)
          : HELPER_LIVE.includes(t.status),
      )
      .map((t) => t.agentId),
  );
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
  for (const t of companyOn(data) ? data.tickets : []) {
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
      /* Empty when nobody holds it. The thread's agent is not a stand-in:
         the row says Unassigned, not Former agent. */
      by: t.owner,
      note: th?.summary ?? (pr ? `PR #${pr.num} · ${pr.branch}` : "Done"),
      minutes: t.doneAgo ?? 0,
      threadId: th?.id,
      unseen: false,
    });
  }
  return rows.sort((a, b) => a.minutes - b.minutes);
}

/** The runtime row an agent runs on (D-#761): `runtime` names its row;
    absent names the default row — the roster can leave the default's
    agents blank. No rows at all means the shell never learned them. */
export const runtimeOf = (
  d: Pick<V3Data, "runtimes">,
  a: Pick<V3Agent, "runtime">,
): V3Runtime | undefined => {
  const rows = d.runtimes;
  if (!rows?.length) return undefined;
  if (!a.runtime) return rows.find((r) => r.isDefault) ?? rows[0];
  return rows.find((r) => r.id === a.runtime);
};

/** A plain name for "Runs on" (#872): the row's label — "Devin",
    "Claude Code"; the launcher name "hermes" reads as "Hermes". A runtime
    id no row names yet still never shows as `acp:devin`. */
export const runtimeLabelOf = (d: V3Data, a: V3Agent): string | undefined => {
  const raw = runtimeOf(d, a)?.label ?? a.runtime;
  return raw ? prettifyRuntimeId(raw) : undefined;
};

/** A runtime's words without a row: `acp:devin` reads "Devin", never the
    raw id (#872). */
export function prettifyRuntimeId(id: string): string {
  return id
    .replace(/^acp:/, "")
    .split(/[-_\s]+/)
    .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Agent and runtime faces share one palette: a stable pastel from a
    31-polynomial hash, so the same name paints the same on the sidebar,
    the page and a thread line (#872). `n` stays reserved for the
    gone-agent "?". */
const FACE_TONES: V3Tone[] = ["c", "b", "r", "m", "s", "d"];
export function agentTone(name: string): V3Tone {
  let x = 0;
  for (const ch of name.toLowerCase())
    x = (Math.imul(x, 31) + ch.charCodeAt(0)) >>> 0;
  return FACE_TONES[x % FACE_TONES.length];
}

/* A coding runtime's tone (#872): known ids keep their brand-adjacent
   colour, a new one hashes to a stable pastel. */
const RUNTIME_TONE: Record<string, V3Tone> = { devin: "b", claude: "m" };

/** A non-default runtime's mark — the label and tone its agents' avatars
    wear wherever an avatar is drawn (sidebar, page, thread). */
export function runtimeLook(id: string): { label: string; tone: V3Tone } {
  return {
    label: prettifyRuntimeId(id),
    tone: RUNTIME_TONE[id.replace(/^acp:/, "")] ?? agentTone(id),
  };
}

/* #872: the rule lives in @lilos/client-runtime so web and mobile render
   the same name; re-exported here for the v3 surfaces. */
export { agentDisplayName } from "@lilos/client-runtime";

/** Engine-side `updatable` names → the page fields they let you edit
    (soul holds the persona — the page's Instructions). */
const PAGE_FIELD = {
  description: "description",
  model: "model",
  soul: "instructions",
} as const;
type AgentPageField = NonNullable<V3Data["agentFields"]>[number];

const pageFieldsOf = (updatable: readonly string[]): AgentPageField[] =>
  updatable.flatMap((f) =>
    f in PAGE_FIELD ? [PAGE_FIELD[f as keyof typeof PAGE_FIELD]] : [],
  );

/** Which engine-owned fields this agent's runtime lets LilOS write: the
    runtime row's own `updatable` (D-#761) — the default engine's list for
    a default-runtime agent, nothing while a coding runtime hasn't been
    described. Read-only text beats an input that would fail (#872). An
    agent stamped with a runtime whose ROW hasn't arrived knows nothing —
    never the default engine's fields on its page. */
export const agentPageFields = (d: V3Data, a: V3Agent): AgentPageField[] => {
  const rt = runtimeOf(d, a);
  if (a.runtime && !rt) return [];
  if (rt && !rt.isDefault) return pageFieldsOf(rt.updatable ?? []);
  return d.agentFields ?? [];
};

/** The model labels this agent's own runtime offers — Devin's SWE-2
    options, never Hermes's list on an ACP agent (#872). Empty while its
    catalog hasn't landed; the field shows text until then. */
export const modelChoicesOf = (d: V3Data, a: V3Agent): string[] => {
  const rt = runtimeOf(d, a);
  if (a.runtime && !rt) return [];
  if (rt && !rt.isDefault) return rt.models ?? [];
  return rt?.models ?? d.modelChoices;
};

/* #872 — the page's Default effort row: the levels the agent's OWN
   runtime reports for its model (`efforts` on the catalog option,
   ordered low → high by the engine). Absent = the runtime reports no
   levels, and the row stays off the page. */
export const effortLadderOf = (
  d: V3Data,
  a: V3Agent,
): { efforts: string[]; defaultEffort?: string } | undefined => {
  const cat = modelCatalogOf(d, a);
  if (!cat) return undefined;
  const opt =
    cat.options.find((o) => o.id === a.modelId) ??
    cat.options.find((o) => o.id === cat.defaultModel);
  if (!opt?.efforts?.length) return undefined;
  return {
    efforts: opt.efforts,
    ...(opt.defaultEffort ? { defaultEffort: opt.defaultEffort } : {}),
  };
};

/* #872 — the composer's model catalog follows the SELECTED agent: a
   runtime agent picks from its own engine's catalog (`modelCatalogs`),
   the default engine's agent from `modelCatalog`. Absent = the plain
   label menu (`modelChoicesOf`). #895: the open thread's composer calls
   the same lookup with its agent's runtime — one rule, two composers. */
export const modelCatalogOf = (
  d: Pick<V3Data, "runtimes" | "modelCatalog" | "modelCatalogs">,
  a: Pick<V3Agent, "runtime">,
): NonNullable<V3Data["modelCatalog"]> | undefined => {
  const rt = runtimeOf(d, a);
  if (a.runtime && !rt) return undefined;
  return rt && !rt.isDefault ? d.modelCatalogs?.[rt.id] : d.modelCatalog;
};

/** Why this agent's runtime can't take scheduled jobs right now — the
    probe's or supervisor's own words. `undefined` means it can: a row
    that never ran still starts on demand, so absence is not a reason. */
export const schedulesOff = (d: V3Data, a: V3Agent): string | undefined => {
  const rt = runtimeOf(d, a);
  if (!rt) return undefined;
  const label = rt.label ?? a.name;
  if (rt.available === false) return rt.detail ?? `${label} is not available`;
  if (rt.state === "failed") return rt.detail ?? `${label} isn't running`;
  return undefined;
};
