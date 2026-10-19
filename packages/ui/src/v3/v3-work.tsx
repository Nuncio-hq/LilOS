import {
  ChartGanttIcon,
  Columns3Icon,
  FolderIcon,
  ListIcon,
  PlusIcon,
  TableIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Btn, Page, Tabs, Title } from "./v3-bits";
import type { V3PageProps } from "./v3-types";
import { TimelineView } from "./v3-work-timeline";
import { BoardView, ProjectView, WaitingView } from "./v3-work-views";

type View = "waiting" | "board" | "project" | "timeline";

const TABS: { id: View; label: string; icon: ReactNode }[] = [
  { id: "waiting", label: "Waiting on", icon: <ListIcon /> },
  { id: "board", label: "Board", icon: <Columns3Icon /> },
  { id: "project", label: "By project", icon: <TableIcon /> },
  { id: "timeline", label: "Timeline", icon: <ChartGanttIcon /> },
];

/** Every ticket in the company: one data set, four ways to look at it. */
export function V3Work({ data, go, act, view }: V3PageProps & { view: View }) {
  // null = all projects.
  const [projectId, setProjectId] = useState<string | null>(null);
  const project = data.projects.find((p) => p.id === projectId);
  const tickets = projectId
    ? data.tickets.filter((t) => t.projectId === projectId)
    : data.tickets;

  // One small button instead of a menu: each click moves to the next project.
  const cycle = () => {
    const ids = [null, ...data.projects.map((p) => p.id)];
    setProjectId(ids[(ids.indexOf(projectId) + 1) % ids.length]);
  };

  const props = { data, go, tickets };
  return (
    // Board columns and the day strip need more room than a reading column.
    <Page
      wide
      className={
        view === "board" || view === "timeline" ? "max-w-[1240px]" : undefined
      }
    >
      <Title>Work</Title>
      <p className="text-[15px] text-muted-foreground">
        Every ticket in the company, grouped by what it is waiting on.
      </p>
      <Tabs
        tabs={TABS}
        value={view}
        onChange={(v) => go({ page: "work", view: v })}
        right={
          <>
            <button
              type="button"
              onClick={cycle}
              title="Show the next project"
              className="flex items-center gap-1.5 hover:text-foreground [&_svg]:size-4"
            >
              <FolderIcon />
              {project ? project.name : "All projects"}
            </button>
            <Btn small primary onClick={() => act.ask()}>
              <PlusIcon className="size-3.5" />
              New
            </Btn>
          </>
        }
      />
      {view === "waiting" && <WaitingView {...props} />}
      {view === "board" && <BoardView {...props} />}
      {view === "project" && <ProjectView {...props} />}
      {view === "timeline" && <TimelineView {...props} />}
    </Page>
  );
}
