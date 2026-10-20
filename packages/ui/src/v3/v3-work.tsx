import {
  ChartGanttIcon,
  Columns3Icon,
  FolderIcon,
  ListIcon,
  PlusIcon,
  TableIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../lib/utils";
import { Avatar, Btn, Page, Tabs, Title } from "./v3-bits";
import type { V3Data, V3PageProps, V3Ticket } from "./v3-types";
import { TimelineView } from "./v3-work-timeline";
import { BoardView, ProjectView, WaitingView } from "./v3-work-views";

type View = "waiting" | "board" | "project" | "timeline";

const TABS: { id: View; label: string; icon: ReactNode }[] = [
  { id: "waiting", label: "Waiting on", icon: <ListIcon /> },
  { id: "board", label: "Board", icon: <Columns3Icon /> },
  { id: "project", label: "By project", icon: <TableIcon /> },
  { id: "timeline", label: "Timeline", icon: <ChartGanttIcon /> },
];

/** Who holds the ticket: everyone, LilOS agents, or the outside workers
   reached through one connector (its id). */
type Who = "all" | "lilos" | (string & {});

/** The connector an outside worker owns this ticket through, if any. */
const viaTicket = (d: V3Data, t: V3Ticket) => {
  const owner = d.agents.find((a) => a.id === t.owner);
  return owner?.kind === "outside" ? owner.via : undefined;
};

/** Compact segmented chips; a connector's own colour shows only on its mark.
   The tabs row already scrolls sideways, so nothing here wraps. */
function WhoFilter({
  value,
  onChange,
  options,
}: {
  value: Who;
  onChange: (w: Who) => void;
  options: { id: Who; label: string; mark?: ReactNode; count?: number }[];
}) {
  return (
    <fieldset
      aria-label="Who"
      className="m-0 inline-flex items-center gap-0.5 rounded-[7px] border-0 bg-[var(--v3-soft)] p-0.5"
    >
      {options.map((o) => (
        <button
          type="button"
          key={o.id}
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] px-2 text-[12.5px] transition-colors",
            value === o.id
              ? "bg-background font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.mark}
          {o.label}
          {o.count !== undefined && (
            <span className="text-muted-foreground/70">{o.count}</span>
          )}
        </button>
      ))}
    </fieldset>
  );
}

/** Every ticket in the company: one data set, four ways to look at it. */
export function V3Work({ data, go, act, view }: V3PageProps & { view: View }) {
  // null = all projects.
  const [projectId, setProjectId] = useState<string | null>(null);
  const [who, setWho] = useState<Who>("all");
  const project = data.projects.find((p) => p.id === projectId);
  const inProject = projectId
    ? data.tickets.filter((t) => t.projectId === projectId)
    : data.tickets;

  // One chip per connector that has outside workers; none when there are none.
  const bots = data.connectors.filter((c) =>
    data.agents.some((a) => a.kind === "outside" && a.via === c.id),
  );
  const picked =
    who === "lilos" || bots.some((c) => c.id === who) ? who : "all";
  const tickets =
    picked === "all"
      ? inProject
      : inProject.filter((t) =>
          picked === "lilos"
            ? !viaTicket(data, t)
            : viaTicket(data, t) === picked,
        );

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
            {bots.length > 0 && (
              <WhoFilter
                value={picked}
                onChange={setWho}
                options={[
                  { id: "all", label: "Everyone" },
                  { id: "lilos", label: "LilOS agents" },
                  ...bots.map((c) => ({
                    id: c.id,
                    label: c.label,
                    mark: (
                      <Avatar name={c.label} tone="n" size={14} look={c.look} />
                    ),
                    count: inProject.filter(
                      (t) => t.status !== "done" && viaTicket(data, t) === c.id,
                    ).length,
                  })),
                ]}
              />
            )}
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
