import { WorkScreen, type WorkView } from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import { useMemo, useState } from "react";
import { hapticSelect } from "../haptics";
import { openThread, openTicket } from "../nav";
import { $data, markSeen } from "../store";
import { threadGroups, ticketGroups } from "./work-groups";

/** The Work tab: threads or tickets, grouped by project. */
export function WorkContainer() {
  const d = useStore($data);
  const [view, setView] = useState<WorkView>("threads");
  const threads = useMemo(() => threadGroups(d), [d]);
  const tickets = useMemo(() => ticketGroups(d), [d]);

  return (
    <WorkScreen
      view={view}
      onView={(next) => {
        if (next === view) return;
        hapticSelect();
        setView(next);
      }}
      threads={threads}
      tickets={tickets}
      onOpenThread={(id) => {
        // Opening a finished thread is looking at it.
        markSeen(id);
        openThread(id);
      }}
      onOpenTicket={openTicket}
    />
  );
}
