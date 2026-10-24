import { WorkScreen } from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import { useMemo } from "react";
import { openProject, openThread, openTicket } from "../nav";
import { $data, markSeen } from "../store";
import { workOverview } from "./work-model";

/** The Work tab: what wants you, then each project's open work. */
export function WorkContainer() {
  const d = useStore($data);
  const { attention, projects } = useMemo(() => workOverview(d), [d]);

  return (
    <WorkScreen
      attention={attention}
      projects={projects}
      onOpenItem={(item) => {
        if (item.kind === "ticket") {
          openTicket(item.id);
          return;
        }
        // Opening a finished thread is looking at it.
        markSeen(item.id);
        openThread(item.id);
      }}
      onOpenProject={openProject}
    />
  );
}
