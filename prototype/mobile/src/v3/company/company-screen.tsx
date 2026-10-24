import { goalProgress, projectOf } from "@lilos/ui/v3-data";
import {
  CompanyScreen,
  type GoalVM,
  type ProjectVM,
} from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import { useNavigation } from "@react-navigation/native";
import { useLayoutEffect, useMemo } from "react";
import { openAgent, openPeople, openProject } from "../nav";
import { $data } from "../store";
import {
  CHAT_ID,
  openByProject,
  summaryOf,
  worstStatus,
} from "../work/work-model";
import { ringPeople } from "./company-model";
import { HIRE_BUTTON } from "./hire-button";

/* The Company tab: the company's people, goals and projects. Hire is the `+`
   in the navigation bar. */

export function CompanyContainer() {
  const navigation = useNavigation();
  const d = useStore($data);
  const props = useMemo(() => {
    const tickets = d.features.tickets;
    const goals: GoalVM[] = tickets
      ? d.goals.map((g) => {
          const project = projectOf(d, g.projectId);
          return {
            id: g.id,
            title: g.title,
            projectId: project?.id,
            project: project?.name,
            due: g.due,
            ...goalProgress(d, g.id),
          };
        })
      : [];
    const projects: ProjectVM[] = openByProject(d)
      .filter((p) => p.id !== CHAT_ID)
      .map((p) => ({
        id: p.id,
        name: p.name,
        status: worstStatus(p.items),
        summary: summaryOf(p.items),
      }));
    return { people: ringPeople(d), goals, projects };
  }, [d]);

  useLayoutEffect(() => {
    navigation.setOptions(HIRE_BUTTON);
  }, [navigation]);

  return (
    <CompanyScreen
      {...props}
      onOpenAgent={openAgent}
      onOpenPeople={openPeople}
      onOpenProject={openProject}
    />
  );
}
