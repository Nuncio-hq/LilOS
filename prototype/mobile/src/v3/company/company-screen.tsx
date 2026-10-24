import { goalProgress, projectOf } from "@lilos/ui/v3-data";
import { CompanyScreen } from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import { useMemo } from "react";
import { openAgent, openHire } from "../nav";
import { $data } from "../store";
import { orgTree, peopleRows } from "./company-model";

/* The Company tab: the company's people, org, goals and projects. */

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
