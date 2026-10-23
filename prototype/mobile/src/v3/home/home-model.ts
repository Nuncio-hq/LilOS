import {
  agentDot,
  agentStatus,
  agentThread,
  agentTicket,
  nextRunLabel,
  type V3Data,
  type V3Status,
} from "@lilos/ui/v3-data";
import type { HomeTeamRow } from "@lilos/ui-native/v3";
import { minutesText, personOf, STATUS_WORDS } from "../model";

/* Home's and Pulse's view models: pure functions of the company. */

/** Everyone on the team, the CEO first, then the roster's order. */
export function teamRows(d: V3Data): HomeTeamRow[] {
  const ordered = [
    ...d.agents.filter((a) => a.id === d.ceoId),
    ...d.agents.filter((a) => a.id !== d.ceoId),
  ];
  return ordered.map((a) => {
    const status = agentStatus(d, a.id);
    const idle = status === "idle";
    const ticket = agentTicket(d, a.id);
    const thread = idle ? undefined : agentThread(d, a.id);
    const run = idle ? nextRunLabel(d, a.id) : undefined;
    const next = idle ? (run ? `Next: ${run}` : a.next) : undefined;
    /* A planned ticket on an idle agent is what its next run already says;
       it shows only when nothing else tells what the agent will do. */
    const own =
      ticket && !(idle && ticket.status === "planned" && next)
        ? ticket
        : undefined;
    const on = own ? `${own.id} · ${own.title}` : thread?.title;
    const since = own
      ? own.status === "planned"
        ? undefined
        : minutesText(own.since)
      : thread
        ? minutesText(thread.minutes)
        : undefined;
    return {
      person: personOf(d, a.id),
      dot: agentDot(d, a.id),
      statusWord: STATUS_WORDS[status],
      on,
      since,
      next,
    };
  });
}

/** What the CEO is doing, ignoring `needs` (that waits on you, not on them):
    working if any of its threads is, else the next most urgent, else idle. */
const CEO_STATE_ORDER: V3Status[] = ["working", "stuck", "waiting", "failed"];

export function ceoState(d: V3Data): V3Status {
  const mine = d.threads.filter((t) => t.agentId === d.ceoId);
  return (
    CEO_STATE_ORDER.find((s) => mine.some((t) => t.status === s)) ?? "idle"
  );
}

/** Tickets moving: those with a hand working on them, outside workers' and
    agents' alike. A ticket waiting on the CEO's sign-off still moves while
    the CEO's thread works, so this agrees with Home's "working" count. */
export function ticketsMoving(d: V3Data): string {
  const live = new Set(
    d.threads
      .filter((t) => t.status === "working" && t.ticketId)
      .map((t) => t.ticketId),
  );
  const n = d.tickets.filter(
    (t) => t.status === "working" || live.has(t.id),
  ).length;
  if (n === 0) return "no tickets moving";
  return `${n} ${n === 1 ? "ticket" : "tickets"} moving`;
}
