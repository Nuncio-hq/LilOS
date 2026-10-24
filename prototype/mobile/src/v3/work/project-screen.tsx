import { ProjectScreen, type WorkView } from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useLayoutEffect, useMemo, useState } from "react";
import { hapticSelect } from "../haptics";
import type { RootRoutes } from "../nav";
import { openThread, openTicket } from "../nav";
import { $data, markSeen } from "../store";
import { projectPage } from "./work-model";

const SERIF = { fontFamily: "Charter" } as const;

/** A project's page, pushed from Work or Company: every thread and ticket in
    it, under the project's name as a large title. */
export function ProjectContainer({
  route,
  navigation,
}: NativeStackScreenProps<RootRoutes, "Project">) {
  const { projectId } = route.params;
  const d = useStore($data);
  const [view, setView] = useState<WorkView>("threads");
  const page = useMemo(() => projectPage(d, projectId), [d, projectId]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: page?.name ?? "Project",
      headerLargeTitle: true,
      headerLargeTitleShadowVisible: false,
      headerLargeTitleStyle: SERIF,
    });
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
