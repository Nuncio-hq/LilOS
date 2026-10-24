import {
  agentStatus,
  reportsOf,
  type V3Agent,
  type V3Data,
} from "@lilos/ui/v3-data";
import type { OrgNodeVM, PersonRowVM } from "@lilos/ui-native/v3";
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

export function peopleRows(d: V3Data): PersonRowVM[] {
  return ceoFirst(d, d.agents).map((a) => {
    const status = agentStatus(d, a.id);
    return {
      person: personOf(d, a.id),
      status,
      statusWord: STATUS_WORDS[status],
      roleLine: roleLine(a),
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
      person: personOf(d, a.id),
      reports: reportsOf(d.agents, a.id)
        .filter((r) => !seen.has(r.id))
        .map(node),
    };
  };
  return ceoFirst(d, reportsOf(d.agents, undefined)).map(node);
}
