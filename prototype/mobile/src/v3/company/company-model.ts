import {
  agentStatus,
  reportsOf,
  type V3Agent,
  type V3Data,
} from "@lilos/ui/v3-data";
import type { OrgNodeVM, PersonRowVM, RingPerson } from "@lilos/ui-native/v3";
import { personOf, STATUS_WORDS } from "../model";

/* What the Company tab, the People page and an agent's page all say about
   who works here. Pure: they read the company and never change it. */

/** The CEO first, then the roster in its own order. */
export function ceoFirst<T extends V3Agent>(d: V3Data, agents: T[]): T[] {
  return [...agents].sort(
    (a, b) => Number(b.id === d.ceoId) - Number(a.id === d.ceoId),
  );
}

export function roleLine(a: V3Agent): string {
  if (a.kind !== "outside") return a.role;
  return a.role ? `${a.role} · Outside worker` : "Outside worker";
}

function personRow(d: V3Data, a: V3Agent): PersonRowVM {
  const status = agentStatus(d, a.id);
  return {
    person: personOf(d, a.id),
    status,
    statusWord: STATUS_WORDS[status],
    roleLine: roleLine(a),
  };
}

/** The Company tab's grid: everyone, CEO first, each wearing their status. */
export function ringPeople(d: V3Data): RingPerson[] {
  return ceoFirst(d, d.agents).map((a) => {
    const { person, status } = personRow(d, a);
    return {
      id: a.id,
      name: person.name,
      status,
      isCeo: person.isCeo,
      outside: person.outside,
    };
  });
}

/** The CEO's tree, with anyone who has no boss beside them. `seen` stops a
    reporting loop from drawing forever. */
export function orgTree(d: V3Data): OrgNodeVM[] {
  const seen = new Set<string>();
  const node = (a: V3Agent): OrgNodeVM => {
    seen.add(a.id);
    return {
      row: personRow(d, a),
      reports: reportsOf(d.agents, a.id)
        .filter((r) => !seen.has(r.id))
        .map(node),
    };
  };
  return ceoFirst(d, reportsOf(d.agents, undefined)).map(node);
}

/** "8 people · 3 working · 1 needs you": how many, and who wants a look. */
export function peopleSummary(d: V3Data): string {
  const statuses = d.agents.map((a) => agentStatus(d, a.id));
  const count = (s: string) => statuses.filter((x) => x === s).length;
  const parts = [
    `${d.agents.length} ${d.agents.length === 1 ? "person" : "people"}`,
  ];
  const needs = count("needs");
  if (needs > 0) parts.push(`${needs} ${needs === 1 ? "needs" : "need"} you`);
  for (const status of ["stuck", "working"] as const) {
    const n = count(status);
    if (n > 0) parts.push(`${n} ${status}`);
  }
  return parts.join(" · ");
}
