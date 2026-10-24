import {
  agentOf,
  askTag,
  FORMER_AGENT,
  type LookAtRow,
  resultsToLookAt,
  threadTag,
  ticketOf,
  type V3Agent,
  type V3Ask,
  type V3Data,
  type V3Status,
  type V3Thread,
  type V3Ticket,
  type V3Update,
  waitingLabel,
} from "@lilos/ui/v3-data";
import type {
  AskVM,
  Person,
  ResultVM,
  ThreadRowVM,
  TicketRowVM,
} from "@lilos/ui-native/v3";
import { hasPlan } from "../../../web/src/thread/mock-plans";

/* Lookups and view-model builders every v3 screen shares. Pure: they read
   the company and never change it. */

/** The id of the CEO's standing thread: the one chat Pulse, CEO updates and
    "Ask the CEO" all open. The store seeds it, so it always exists. */
export const CEO_THREAD_ID = "t-ceo";

export const STATUS_WORDS: Record<V3Status, string> = {
  working: "Working",
  waiting: "Waiting",
  needs: "Needs you",
  stuck: "Stuck",
  idle: "Idle",
  done: "Done",
  planned: "Planned",
  failed: "Failed",
};

export function personOf(d: V3Data, id: string): Person {
  const a: V3Agent | undefined = agentOf(d, id);
  if (!a) {
    // "you" and a fired agent's id both land here: neither is on the team.
    return {
      id,
      name: id === "you" ? d.me : FORMER_AGENT,
      role: "",
      isCeo: false,
      outside: false,
    };
  }
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    isCeo: a.id === d.ceoId,
    outside: a.kind === "outside",
  };
}

/** Minutes as a short phrase: "now", "41 min", "3 h", "2 d". */
export function minutesText(min: number): string {
  if (min < 1) return "now";
  if (min < 60) return `${Math.round(min)} min`;
  if (min < 60 * 48) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} d`;
}

/** "41 min ago" / "just now". */
export function agoText(min: number): string {
  return min < 1 ? "just now" : `${minutesText(min)} ago`;
}

/** A plan ask is an approval whose thread carries a plan to read (the Mac's
    mock-plans.ts holds the plan text, not the company data). */
function askKind(d: V3Data, a: V3Ask): AskVM["kind"] {
  if (a.kind === "question") return "question";
  const thread = d.threads.find((t) => t.askId === a.id);
  return thread && hasPlan(thread.id) ? "plan" : "approval";
}

export function askVM(d: V3Data, a: V3Ask): AskVM {
  const spend = a.spend
    ? `$${a.spend.amount} · $${a.spend.used} of $${a.spend.cap} used`
    : undefined;
  const thread = d.threads.find((t) => t.askId === a.id);
  const threadId = a.threadId ?? thread?.id;
  const kind = askKind(d, a);
  return {
    id: a.id,
    kind,
    from: personOf(d, a.from),
    // "Review the plan" says nothing: a plan ask is named by what it plans.
    title: kind === "plan" && thread ? thread.title : a.title,
    ask: a.ask,
    // A plan ask says nothing itself; its thread's one-line summary stands in.
    why: a.why ?? (kind === "plan" ? thread?.quote : undefined),
    ifYes: a.ifYes,
    ifNo: a.ifNo,
    tag: askTag(d, a),
    waiting: a.waiting < 1 ? "under a minute" : minutesText(a.waiting),
    options: a.options,
    spend,
    fallback: a.fallback
      ? `At ${a.fallback.at} the CEO ${a.fallback.does}.`
      : undefined,
    threadId,
  };
}

/** Open asks, longest-waiting first. */
export function openAsks(d: V3Data): V3Ask[] {
  return [...d.asks].sort((a, b) => b.waiting - a.waiting);
}

export function threadRowVM(d: V3Data, t: V3Thread): ThreadRowVM {
  const live = t.status === "working" || t.status === "stuck";
  const detail =
    t.status === "needs" && t.quote
      ? t.quote
      : (t.summary ??
        t.now?.text ??
        (live
          ? `Started ${t.startedAt} · ${minutesText(t.minutes)}`
          : `${t.startedAt} · ${minutesText(t.minutes)}`));
  return {
    id: t.id,
    title: t.title,
    agent: personOf(d, t.agentId),
    status: t.status,
    statusWord: STATUS_WORDS[t.status],
    tag: threadTag(d, t),
    detail,
    unseen: t.unseen === true,
  };
}

/** Why a ticket is in its state, in one plain line. */
export function ticketDetail(d: V3Data, t: V3Ticket): string {
  switch (t.status) {
    case "needs":
      return `Waits on ${waitingLabel(d, t)} · ${minutesText(t.since)}`;
    case "waiting":
      return `Waits on ${waitingLabel(d, t)} · ${minutesText(t.since)}`;
    case "stuck":
      return `${t.stuckWhy ?? "Stuck"} · ${minutesText(t.since)}`;
    case "planned":
      return t.startsAt ? `Starts ${t.startsAt}` : "Planned";
    case "done":
      return t.doneAgo === undefined ? "Done" : `Done ${agoText(t.doneAgo)}`;
    default:
      return `${minutesText(t.since)} in this state`;
  }
}

export function ticketRowVM(d: V3Data, t: V3Ticket): TicketRowVM {
  return {
    id: t.id,
    title: t.title,
    owner: personOf(d, t.owner),
    status: t.status,
    statusWord: STATUS_WORDS[t.status],
    detail: ticketDetail(d, t),
  };
}

export { ticketOf };

/** What finished since you looked, as rows to open and as view models. Home
    and Needs show the same list (the Mac's `resultsToLookAt`). */
export function resultRows(d: V3Data): { rows: LookAtRow[]; vms: ResultVM[] } {
  const rows = resultsToLookAt(d);
  return {
    rows,
    vms: rows.map((r) => ({
      key: r.key,
      title: r.title,
      by: personOf(d, r.by),
      note: r.note,
      tag: r.tag,
      ago: agoText(r.minutes),
      unseen: r.unseen,
      openable: Boolean(r.threadId ?? r.ticketId),
    })),
  };
}

/** What an update is about, and so what it opens: the CEO's own notes open
    the CEO's thread; an update about a ticket opens that ticket; one by an
    agent with nothing else to point at opens the agent. A note from LilOS
    itself about nothing opens nothing. */
export type UpdateTarget =
  | { kind: "thread"; id: string }
  | { kind: "ticket"; id: string }
  | { kind: "agent"; id: string };

export function updateTarget(d: V3Data, u: V3Update): UpdateTarget | undefined {
  const ceo = Boolean(d.ceoId) && u.by === d.ceoId;
  if (ceo && u.kind === "note") return { kind: "thread", id: CEO_THREAD_ID };
  if (u.ticketId && ticketOf(d, u.ticketId))
    return { kind: "ticket", id: u.ticketId };
  if (ceo) return { kind: "thread", id: CEO_THREAD_ID };
  if (u.authorKind !== "system" && agentOf(d, u.by))
    return { kind: "agent", id: u.by };
  return undefined;
}

/** Newest first, one per destination: two updates about the same ticket (or
    two notes to the CEO's thread) are one row, the newer. Ones that open
    nothing stay, each its own. */
export function recentUpdates(d: V3Data, limit: number): V3Update[] {
  const seen = new Set<string>();
  const out: V3Update[] = [];
  for (const u of d.updates) {
    const t = updateTarget(d, u);
    const key = t ? `${t.kind}:${t.id}` : `update:${u.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
    if (out.length === limit) break;
  }
  return out;
}
