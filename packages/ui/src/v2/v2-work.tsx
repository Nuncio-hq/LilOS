import { CrownIcon, TargetIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import { ago } from "./v2-bits";
import type { V2Agent, V2Project } from "./v2-types";
import { ProjectChip } from "./v2-viz";
import { AssigneeBadge, TICKET_STATE, TicketStateIcon } from "./v2-work-bits";
import type {
  V2Connector,
  V2Goal,
  V2Ticket,
  V2TicketState,
} from "./v2-work-types";
import { V2_TICKET_STATES } from "./v2-work-types";

/* One ticket card on the board: title, its project, who holds it, and the
   latest step in one line. A breathing ring on the state icon means the
   worker is on it right now. */
function TicketCard({
  t,
  agents,
  connectors,
  projects,
  onOpen,
}: {
  t: V2Ticket;
  agents: V2Agent[];
  connectors: V2Connector[];
  projects: V2Project[];
  onOpen: () => void;
}) {
  const pi = projects.findIndex((p) => p.id === t.projectId);
  const live = t.trail.some((l) => l.live);
  return (
    <button
      type="button"
      onClick={onOpen}
      data-v2-ticket={t.id}
      className={cn(
        "flex w-full flex-col gap-2 rounded-xl bg-background/80 p-3 text-left ring-1 ring-foreground/[0.07] transition-colors hover:ring-foreground/20 dark:bg-white/[0.03]",
        t.state === "needs" && "ring-amber-500/40",
      )}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5">
          <TicketStateIcon state={t.state} />
        </span>
        <span className="min-w-0 flex-1 font-medium text-[13px] leading-snug">
          {t.title}
        </span>
      </div>
      <p
        className={cn(
          "line-clamp-2 text-[12px] leading-snug",
          t.state === "needs"
            ? "text-amber-700 dark:text-amber-300"
            : "text-muted-foreground",
        )}
      >
        {live && (
          <span className="lilos-v2-breathe mr-1.5 inline-block size-1.5 rounded-full bg-[var(--work)] align-middle" />
        )}
        {t.ask?.risk ? t.ask.text : t.line}
      </p>
      <div className="flex items-center gap-2">
        <AssigneeBadge a={t.assignee} agents={agents} connectors={connectors} />
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {ago(t.ago)}
          </span>
          <ProjectChip
            name={projects[pi]?.name ?? "No project"}
            index={projects[pi]?.path ? pi : -1}
            className="size-4 text-[8px]"
          />
        </span>
      </div>
    </button>
  );
}

/* Work: the CEO's view of the company's tickets. Goals as a strip of
   progress bars on top, then one column per state. Who holds a ticket can be
   a LilOS agent or an outside worker; both look the same, outside ones carry
   a plug badge. Opening a ticket slides its live trail in from the right. */
export function V2Work({
  goals,
  tickets,
  agents,
  connectors,
  projects,
  ceo,
  project,
  onProject,
  onOpenTicket,
  onOpenCeo,
}: {
  goals: V2Goal[];
  tickets: V2Ticket[];
  agents: V2Agent[];
  connectors: V2Connector[];
  projects: V2Project[];
  /** The agent holding the CEO position, if any. */
  ceo?: V2Agent;
  /** Filter: one project, or all. */
  project: string | null;
  onProject: (id: string | null) => void;
  onOpenTicket: (id: string) => void;
  onOpenCeo?: () => void;
}) {
  const shown = tickets.filter((t) => !project || t.projectId === project);
  const used = projects.filter((p) =>
    tickets.some((t) => t.projectId === p.id),
  );
  const col = (s: V2TicketState) =>
    shown.filter((t) => t.state === s).sort((a, b) => a.ago - b.ago);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="lilos-drag flex h-[52px] shrink-0 items-center gap-3 pr-3 pl-5">
        <h1 className="font-semibold text-[14px]">Work</h1>
        <span className="text-[12px] text-muted-foreground tabular-nums">
          {shown.filter((t) => t.state !== "done").length} open
        </span>
        <div className="ml-2 flex items-center gap-1 rounded-full bg-foreground/[0.05] p-0.5">
          <FilterPill on={!project} onClick={() => onProject(null)}>
            All
          </FilterPill>
          {used.map((p) => (
            <FilterPill
              key={p.id}
              on={project === p.id}
              onClick={() => onProject(p.id)}
            >
              {p.name}
            </FilterPill>
          ))}
        </div>
        {ceo && onOpenCeo && (
          <button
            type="button"
            onClick={onOpenCeo}
            title={`Talk to the CEO (${ceo.name})`}
            className="ml-auto flex h-8 items-center gap-2 rounded-full pr-3 pl-1.5 text-[12.5px] ring-1 ring-foreground/10 hover:bg-foreground/[0.04]"
          >
            <span className="relative">
              <HermesAvatar name={ceo.name} className="size-6" />
              <CrownIcon className="absolute -top-1.5 -right-1 size-3 text-amber-500" />
            </span>
            CEO
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-5 pb-6">
        <div className="mb-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {goals
            .filter((g) => !project || g.projectId === project)
            .map((g) => {
              const mine = tickets.filter((t) => t.goalId === g.id);
              const done = mine.filter((t) => t.state === "done").length;
              const pi = projects.findIndex((p) => p.id === g.projectId);
              return (
                <div
                  key={g.id}
                  className="flex flex-col gap-2 rounded-xl p-3 ring-1 ring-foreground/[0.07]"
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
                            className={cn(
                              "h-full",
                              s === "done" && "bg-emerald-500",
                              s === "checking" && "bg-violet-500",
                              s === "needs" && "bg-amber-500",
                              s === "working" && "bg-work",
                              s === "todo" && "bg-foreground/15",
                            )}
                            style={{ flexGrow: n }}
                          />
                        ) : null;
                      })}
                    </div>
                    <span className="shrink-0 text-[11.5px] text-muted-foreground tabular-nums">
                      {done}/{mine.length}
                    </span>
                  </div>
                </div>
              );
            })}
        </div>

        <div className="grid min-w-[880px] grid-cols-5 gap-3">
          {V2_TICKET_STATES.map((s) => {
            const items = col(s);
            return (
              <section key={s} className="flex min-w-0 flex-col gap-2">
                <div className="flex h-7 items-center gap-1.5 px-1">
                  <TicketStateIcon state={s} />
                  <h2 className="font-semibold text-[12.5px]">
                    {TICKET_STATE[s].label}
                  </h2>
                  <span className="text-[11.5px] text-muted-foreground tabular-nums">
                    {items.length}
                  </span>
                </div>
                {items.map((t) => (
                  <TicketCard
                    key={t.id}
                    t={t}
                    agents={agents}
                    connectors={connectors}
                    projects={projects}
                    onOpen={() => onOpenTicket(t.id)}
                  />
                ))}
                {items.length === 0 && (
                  <div className="h-16 rounded-xl border border-foreground/[0.08] border-dashed" />
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function FilterPill({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "h-6 rounded-full px-2.5 text-[12px] transition-colors",
        on
          ? "bg-background font-medium shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
