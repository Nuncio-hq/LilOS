import { agentStatus, type V3Data, type V3Status } from "@lilos/ui/v3-data";
import type { RingPerson } from "@lilos/ui-native/v3";
import { STATUS_WORDS } from "../model";

/* Home's and Pulse's view models: pure functions of the company. */

/** Everyone on the team, the CEO first, then the roster's order: a ring and
    one word for what they are doing, both from `agentStatus` like Company's. */
export function teamPeople(d: V3Data): RingPerson[] {
  const ordered = [
    ...d.agents.filter((a) => a.id === d.ceoId),
    ...d.agents.filter((a) => a.id !== d.ceoId),
  ];
  return ordered.map((a) => ({
    id: a.id,
    name: a.name,
    status: agentStatus(d, a.id),
    caption: STATUS_WORDS[agentStatus(d, a.id)],
    isCeo: a.id === d.ceoId,
    outside: a.kind === "outside",
  }));
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
