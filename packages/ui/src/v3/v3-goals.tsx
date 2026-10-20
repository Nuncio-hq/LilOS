import { CalendarIcon, FolderIcon, InfoIcon, TargetIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { Btn, Meter, Page, Prop, Section, Title } from "./v3-bits";
import { DOT, ProjectMark } from "./v3-marks";
import { goalOf, goalProgress, projectOf } from "./v3-model";
import { RowButton } from "./v3-open-record";
import type { V3PageProps } from "./v3-page-types";
import { TicketRow } from "./v3-rows";
import type { V3Status } from "./v3-types";

/* Goals: what the company wants and how far along it is. A goal's progress is
   its done tickets over all its tickets, nothing more clever than that. */

const GRID =
  "grid grid-cols-[minmax(0,1fr)_120px_92px_210px_96px] items-center gap-x-3";

/** Open tickets are listed by the order a reader cares about. */
const OPEN_ORDER: V3Status[] = [
  "needs",
  "stuck",
  "working",
  "waiting",
  "planned",
  "failed",
];

export function V3Goals({ data, go }: V3PageProps) {
  return (
    <Page wide>
      <Title>Goals</Title>
      <p className="text-[14.5px] text-muted-foreground">
        What the company wants, and how far along it is.
      </p>

      <div className="mt-6 text-[14px]">
        <div
          className={cn(
            GRID,
            "border-[var(--v3-line)] border-b pb-[7px] text-[12.5px] text-muted-foreground/70",
          )}
        >
          <span>Goal</span>
          <span>Project</span>
          <span>Due</span>
          <span>Progress</span>
          <span>Open</span>
        </div>
        {data.goals.map((g) => {
          const p = goalProgress(data, g.id);
          const project = projectOf(data, g.projectId);
          const open = data.tickets.filter(
            (t) => t.goalId === g.id && t.status !== "done",
          );
          return (
            <RowButton
              key={g.id}
              onClick={() => go({ page: "goal", id: g.id })}
              className={cn(
                GRID,
                "min-h-[46px] border-[var(--v3-line)] border-b py-2",
              )}
            >
              <span className="truncate font-medium text-foreground">
                {g.title}
              </span>
              <span className="flex items-center gap-2 text-muted-foreground">
                {project && (
                  <ProjectMark name={project.name} tone={project.tone} />
                )}
                <span className="truncate">{project?.name}</span>
              </span>
              <span className="text-muted-foreground">{g.due}</span>
              <span className="flex items-center gap-3">
                <Meter
                  value={p.total ? (p.done / p.total) * 100 : 0}
                  className="w-[150px]"
                />
                <span className="text-[13px] text-muted-foreground">
                  {p.done} / {p.total}
                </span>
              </span>
              <span className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
                {open.length === 0 && "—"}
                {OPEN_ORDER.map((s) => {
                  const n = open.filter((t) => t.status === s).length;
                  return n ? (
                    <span key={s} className="inline-flex items-center gap-1">
                      <span className={cn("size-1.5 rounded-full", DOT[s])} />
                      {n}
                    </span>
                  ) : null;
                })}
              </span>
            </RowButton>
          );
        })}
      </div>
    </Page>
  );
}

export function V3GoalPage({
  data,
  go,
  act,
  id,
}: V3PageProps & { id: string }) {
  const goal = goalOf(data, id);
  const [showDone, setShowDone] = useState(true);
  if (!goal) {
    return (
      <Page>
        <p className="text-[14px] text-muted-foreground">Goal not found.</p>
      </Page>
    );
  }
  const project = projectOf(data, goal.projectId);
  const p = goalProgress(data, goal.id);
  const tickets = data.tickets.filter((t) => t.goalId === goal.id);
  const open = tickets
    .filter((t) => t.status !== "done")
    .sort(
      (a, b) => OPEN_ORDER.indexOf(a.status) - OPEN_ORDER.indexOf(b.status),
    );
  const done = tickets.filter((t) => t.status === "done");

  return (
    <Page wide>
      <Title kicker={`Goal · ${project?.name ?? ""}`}>{goal.title}</Title>
      <div className="mt-4 mb-1">
        <Prop icon={<FolderIcon />} label="Project">
          {project && (
            <button
              type="button"
              onClick={() => go({ page: "project", id: project.id })}
              className="inline-flex items-center gap-2 text-foreground hover:underline"
            >
              <ProjectMark name={project.name} tone={project.tone} />
              {project.name}
            </button>
          )}
        </Prop>
        <Prop icon={<CalendarIcon />} label="Due">
          {goal.due}
        </Prop>
        <Prop icon={<TargetIcon />} label="Progress">
          <Meter
            value={p.total ? (p.done / p.total) * 100 : 0}
            className="w-[150px]"
          />
          <span className="text-[13.5px] text-muted-foreground">
            {p.done} of {p.total} done
          </span>
        </Prop>
        <Prop icon={<InfoIcon />} label="Why">
          <span className="text-foreground">{goal.why}</span>
        </Prop>
      </div>
      <div className="mt-3">
        <Btn primary onClick={() => act.ask(`For “${goal.title}”: `)}>
          Add work to this goal
        </Btn>
      </div>

      <Section title="Tickets" count={tickets.length} />
      {tickets.length === 0 && (
        <p className="text-[14px] text-muted-foreground">
          No tickets yet. Add work to this goal to start.
        </p>
      )}
      {open.length > 0 && (
        <>
          <div className="mt-3 mb-1 text-[12.5px] text-muted-foreground/70">
            Open · {open.length}
          </div>
          <div className="border-[var(--v3-line)] border-t">
            {open.map((t) => (
              <TicketRow key={t.id} data={data} ticket={t} go={go} owner />
            ))}
          </div>
        </>
      )}
      {done.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowDone((v) => !v)}
            className="mt-5 mb-1 text-[12.5px] text-muted-foreground/70 hover:text-foreground"
          >
            {showDone ? "▾" : "▸"} Done · {done.length}
          </button>
          {showDone && (
            <div className="border-[var(--v3-line)] border-t">
              {done.map((t) => (
                <TicketRow key={t.id} data={data} ticket={t} go={go} owner />
              ))}
            </div>
          )}
        </>
      )}
    </Page>
  );
}
