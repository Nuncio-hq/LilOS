import {
  agentStatus,
  goalProgress,
  projectOf,
  reportsOf,
  type V3Agent,
  type V3Data,
} from "@lilos/ui/v3-data";
import {
  CompanyScreen,
  type OrgNodeVM,
  type PersonRowVM,
} from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import { useMemo } from "react";
import { personOf, STATUS_WORDS } from "../model";
import { openAgent, openHire } from "../nav";
import { $data } from "../store";

/* The Company tab: the company's people, org, goals and projects. */

/** The CEO first, then the roster in its own order. */
function ceoFirst<T extends V3Agent>(d: V3Data, agents: T[]): T[] {
  return [...agents].sort(
    (a, b) => Number(b.id === d.ceoId) - Number(a.id === d.ceoId),
  );
}

export function roleLine(a: V3Agent): string {
  if (a.kind !== "outside") return a.role;
  return a.role ? `${a.role} · Outside worker` : "Outside worker";
}

function peopleRows(d: V3Data): PersonRowVM[] {
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
function orgTree(d: V3Data): OrgNodeVM[] {
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

export function CompanyContainer() {
  const d = useStore($data);
  const props = useMemo(() => {
    const tickets = d.features.tickets;
    return {
      people: peopleRows(d),
      org: orgTree(d),
      goals: tickets
        ? d.goals.map((g) => ({
            id: g.id,
            title: g.title,
            project: projectOf(d, g.projectId)?.name,
            due: g.due,
            why: g.why,
            ...goalProgress(d, g.id),
          }))
        : [],
      projects: d.projects.map((p) => ({
        id: p.id,
        name: p.name,
        key: p.key,
        about: p.about,
        folder: p.folder,
        open: tickets
          ? d.tickets.filter((t) => t.projectId === p.id && t.status !== "done")
              .length
          : undefined,
      })),
    };
  }, [d]);
  return <CompanyScreen {...props} onOpenAgent={openAgent} onHire={openHire} />;
}
