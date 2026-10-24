import type { ProjectPageVM, WorkView } from "@lilos/ui-native/v3";
import { ProjectScreen } from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import { useLayoutEffect, useMemo, useState } from "react";
import { hapticSelect } from "../haptics";
import { openThread, openTicket } from "../nav";
import { $data, markSeen } from "../store";
import { projectPage } from "./work-groups";

/** A project's page, pushed from Work or Company: every thread and ticket in
    it. `navigation` is whichever stack pushed it. */
export function ProjectContainer({
  route,
  navigation,
}: {
  route: { params: { projectId: string } };
  navigation: { setOptions: (o: { title: string }) => void };
}) {
  const { projectId } = route.params;
  const d = useStore($data);
  const [view, setView] = useState<WorkView>("threads");
  const page: ProjectPageVM | undefined = useMemo(
    () => projectPage(d, projectId),
    [d, projectId],
  );

  useLayoutEffect(() => {
    navigation.setOptions({ title: page?.name ?? "Project" });
  }, [navigation, page?.name]);

  return (
    <ProjectScreen
      page={page}
      view={view}
      onView={(next) => {
        if (next === view) return;
        hapticSelect();
        setView(next);
      }}
      onOpenThread={(id) => {
        // Opening a finished thread is looking at it.
        markSeen(id);
        openThread(id);
      }}
      onOpenTicket={openTicket}
    />
  );
}
