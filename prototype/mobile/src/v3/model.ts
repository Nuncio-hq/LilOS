import {
  agentOf,
  askTag,
  FORMER_AGENT,
  threadTag,
  ticketOf,
  type V3Agent,
  type V3Ask,
  type V3Data,
  type V3Status,
  type V3Thread,
  type V3Ticket,
  waitingLabel,
} from "@lilos/ui/v3-data";
import type {
  AskVM,
  Person,
  ThreadRowVM,
  TicketRowVM,
} from "@lilos/ui-native/v3";

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

/** A plan ask names a thread and has no ticket and nothing else to say: the
    plan itself reads in the thread. */
function askKind(a: V3Ask): AskVM["kind"] {
  if (a.kind === "question") return "question";
  return a.threadId && !a.ticketId && !a.why ? "plan" : "approval";
}

export function askVM(d: V3Data, a: V3Ask): AskVM {
  const spend = a.spend
    ? `$${a.spend.amount} · $${a.spend.used} of $${a.spend.cap} used`
    : undefined;
  const threadId =
    a.threadId ?? d.threads.find((t) => t.askId === a.id)?.id ?? undefined;
  return {
    id: a.id,
    kind: askKind(a),
    from: personOf(d, a.from),
    title: a.title,
    ask: a.ask,
    why: a.why,
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
