import { CrownIcon, TargetIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import { ago } from "./v2-bits";
import type { V2Agent, V2Project } from "./v2-types";
import { ProjectChip } from "./v2-viz";
import {
  TICKET_STATE,
  TicketStateIcon,
  type WorkerIdentity,
  WorkerLabel,
  workerIdentity,
} from "./v2-work-bits";
import {
  groupKey,
  groupsFor,
  ProjectSegments,
  WhoFilter,
} from "./v2-work-filters";
import type {
  V2Connector,
  V2Goal,
  V2Ticket,
  V2TicketState,
} from "./v2-work-types";
import { V2_TICKET_STATES } from "./v2-work-types";

/* One ticket card. Top: who holds it, unmistakably (agent orb + runtime, or
   the provider's mark + name). Then the title, then what is happening now
   and where it runs. Footer: id, project, age. A risky ask turns the card
   amber and says what it wants. */
function TicketCard({
  t,
  who,
  projects,
  active,
  onOpen,
}: {
  t: V2Ticket;
  who: WorkerIdentity;
  projects: V2Project[];
  active: boolean;
  onOpen: () => void;
}) {
  const pi = projects.findIndex((p) => p.id === t.projectId);
  const last = t.trail[t.trail.length - 1];
  const live = t.trail.some((l) => l.live);
  const tint = who.connector?.color;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-v2-ticket={t.id}
      aria-current={active ? "true" : undefined}
      className={cn(
        "relative flex w-full flex-col gap-2.5 overflow-hidden rounded-xl bg-background/90 p-3 pl-3.5 text-left ring-1 ring-foreground/[0.08] transition-shadow hover:ring-foreground/25 dark:bg-white/[0.035]",
        t.state === "needs" && "ring-amber-500/50",
        active && "ring-2 ring-foreground/60",
      )}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{
          background:
            tint ?? (who.outside ? "var(--foreground)" : "var(--work)"),
          opacity: tint || who.outside ? 0.9 : 0.35,
        }}
      />
      <WorkerLabel who={who} />
      <span className="font-medium text-[13.5px] leading-snug">{t.title}</span>
      {t.ask?.risk ? (
        <span className="rounded-lg bg-amber-500/10 px-2 py-1.5 text-[12px] text-amber-800 leading-snug dark:text-amber-200">
          {t.ask.text}
        </span>
      ) : (
        <span className="flex items-start gap-1.5 text-[12px] text-muted-foreground leading-snug">
          {live && (
            <span className="lilos-v2-breathe mt-1 inline-block size-1.5 shrink-0 rounded-full bg-[var(--work)]" />
          )}
          <span className="line-clamp-2">{t.line}</span>
        </span>
      )}
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-mono">{t.id}</span>
        {last?.where && (
          <span className="truncate rounded-full bg-foreground/[0.05] px-1.5">
            {last.where}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums">
          {ago(t.ago)}
          <ProjectChip
            name={projects[pi]?.name ?? "No project"}
            index={projects[pi]?.path ? pi : -1}
            className="size-4 text-[8px]"
          />
        </span>
      </span>
    </button>
  );
}

/* Work: the company's tickets as a board, with the CEO beside it.
   - Header: title, open count, the CEO button (opens the chat docked on
     the right; the board stays).
   - One filter toolbar: projects as a segmented control, Who as round
     marks (LilOS agents, then each outside provider in its own colour).
   - Goals, then the five states: columns when the board is wide, stacked
     sections with a card grid when it is narrow (CEO panel open, small
     window). */
export function V2Work({
  goals,
  tickets,
  agents,
  connectors,
  projects,
  ceo,
  project,
  worker,
  activeTicket,
  ceoOpen,
  dock,
  onProject,
  onWorker,
  onOpenTicket,
  onToggleCeo,
}: {
  goals: V2Goal[];
  tickets: V2Ticket[];
  agents: V2Agent[];
  connectors: V2Connector[];
  projects: V2Project[];
  /** The agent holding the CEO position, if any. */
  ceo?: V2Agent;
  project: string | null;
  /** Filter by worker group key (see groupsFor). */
  worker: string | null;
  activeTicket?: string | null;
  ceoOpen: boolean;
  /** The CEO panel, rendered beside the board when open. */
  dock?: React.ReactNode;
  onProject: (id: string | null) => void;
  onWorker: (key: string | null) => void;
  onOpenTicket: (id: string) => void;
  onToggleCeo?: () => void;
}) {
  const ident = (t: V2Ticket) => workerIdentity(t.assignee, agents, connectors);
  const byProject = tickets.filter((t) => !project || t.projectId === project);
  const shown = byProject.filter(
    (t) => !worker || groupKey(ident(t)) === worker,
  );
  const groups = groupsFor(byProject, agents, connectors);
  const used = projects.filter((p) =>
    tickets.some((t) => t.projectId === p.id),
  );
  const col = (s: V2TicketState) =>
    shown.filter((t) => t.state === s).sort((a, b) => a.ago - b.ago);
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="lilos-drag flex h-[52px] shrink-0 items-center gap-2.5 pr-3 pl-5">
          <h1 className="font-semibold text-[15px] tracking-tight">Work</h1>
          <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 font-medium text-[11.5px] text-muted-foreground tabular-nums">
            {shown.filter((t) => t.state !== "done").length} open
          </span>
          {ceo && onToggleCeo && (
            <button
              type="button"
              onClick={onToggleCeo}
              aria-pressed={ceoOpen}
              title={ceoOpen ? "Hide the CEO" : `Talk to the CEO (${ceo.name})`}
              className={cn(
                "ml-auto flex h-8 shrink-0 items-center gap-2 rounded-full pr-3 pl-1 text-[12.5px] transition-colors",
                ceoOpen
                  ? "bg-foreground text-background"
                  : "bg-amber-500/[0.08] ring-1 ring-amber-500/25 hover:bg-amber-500/[0.14]",
              )}
            >
              <span className="relative">
                <HermesAvatar name={ceo.name} className="size-6" />
                <CrownIcon className="absolute -top-1.5 -right-1 size-3 text-amber-500" />
              </span>
              <span className="font-medium">{ceo.name}</span>
              <span className="hidden opacity-60 md:inline">CEO</span>
            </button>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto pb-6">
          <div
            role="toolbar"
            aria-label="Filters"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pb-4"
          >
            <ProjectSegments
              projects={used}
              value={project}
              onChange={onProject}
            />
            <span className="ml-auto" />
            <WhoFilter groups={groups} value={worker} onChange={onWorker} />
          </div>

          {goals.some((g) => !project || g.projectId === project) && (
            <section
              aria-label="Goals"
              className="grid gap-2 px-5 pb-4 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]"
            >
              {goals
                .filter((g) => !project || g.projectId === project)
                .map((g) => {
                  const mine = tickets.filter((t) => t.goalId === g.id);
                  const done = mine.filter((t) => t.state === "done").length;
                  const pi = projects.findIndex((p) => p.id === g.projectId);
                  return (
                    <div
                      key={g.id}
                      className="flex flex-col gap-2 rounded-xl px-3 py-2.5 ring-1 ring-foreground/[0.07]"
                    >
                      <div className="flex items-center gap-2">
                        <TargetIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate font-medium text-[13px]">
                          {g.title}
                        </span>
                        <ProjectChip
                          name={projects[pi]?.name ?? "No project"}
                          index={pi}
                          className="size-4 text-[8px]"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex h-1.5 flex-1 gap-[2px] overflow-hidden rounded-full bg-foreground/[0.06]">
                          {V2_TICKET_STATES.map((s) => {
                            const n = mine.filter((t) => t.state === s).length;
                            return n ? (
                              <span
                                key={s}
                                title={`${n} ${TICKET_STATE[s].label.toLowerCase()}`}
                                className={cn("h-full", TICKET_STATE[s].bar)}
                                style={{ flexGrow: n }}
                              />
                            ) : null;
                          })}
                        </div>
                        <span className="shrink-0 text-[11.5px] text-muted-foreground tabular-nums">
                          {done}/{mine.length} done
                        </span>
                      </div>
                    </div>
                  );
                })}
            </section>
          )}

          {/* Wide: five columns. Narrow (CEO panel open, small window): the
              states stack as sections and cards flow in a grid, so nothing
              squeezes or scrolls sideways. Empty states hide when stacked. */}
          <div className="@container px-5">
            <div className="flex flex-col gap-3 @min-[1120px]:grid @min-[1120px]:grid-cols-5">
              {V2_TICKET_STATES.map((s) => {
                const items = col(s);
                return (
                  <section
                    key={s}
                    aria-label={TICKET_STATE[s].label}
                    className={cn(
                      "min-w-0 flex-col gap-2 rounded-2xl bg-foreground/[0.025] p-2",
                      items.length === 0 ? "hidden @min-[1120px]:flex" : "flex",
                    )}
                  >
                    <div className="flex h-7 items-center gap-1.5 px-1.5">
                      <TicketStateIcon state={s} />
                      <h2 className="font-semibold text-[12.5px]">
                        {TICKET_STATE[s].label}
                      </h2>
                      <span className="text-[11.5px] text-muted-foreground tabular-nums">
                        {items.length}
                      </span>
                    </div>
                    <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))] @min-[1120px]:grid-cols-1">
                      {items.map((t) => (
                        <TicketCard
                          key={t.id}
                          t={t}
                          who={ident(t)}
                          projects={projects}
                          active={activeTicket === t.id}
                          onOpen={() => onOpenTicket(t.id)}
                        />
                      ))}
                    </div>
                    {items.length === 0 && (
                      <div className="grid h-14 place-items-center rounded-xl text-[11.5px] text-muted-foreground/70">
                        Nothing here
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      {ceoOpen && dock && (
        <div className="absolute inset-y-0 right-0 z-20 flex w-full max-w-[420px] shadow-[-16px_0_48px_-24px_rgb(0_0_0/0.35)] lg:static lg:z-auto lg:w-auto lg:max-w-none lg:shadow-none">
          {dock}
        </div>
      )}
    </div>
  );
}
