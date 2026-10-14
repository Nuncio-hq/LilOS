import { TargetIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { BotAvatar, ProviderChip, TicketStatePill } from "./company-bits";
import type {
  Bot,
  CompanyGoal,
  CompanyProject,
  CompanyTicket,
  TicketState,
} from "./company-types";

const COLUMNS: { title: string; states: TicketState[] }[] = [
  { title: "To do", states: ["todo"] },
  { title: "In progress", states: ["working", "needs-ceo", "needs-you"] },
  { title: "CEO checking", states: ["review"] },
  { title: "Done", states: ["done"] },
];

/* The work the CEO handed out: goals on top, then tickets by state. One
   assignee per ticket (Paperclip-style). Read-only for Oscar — the CEO moves
   tickets; Oscar opens one to see the detail. */
export function TicketBoard({
  projects,
  projectId,
  onProject,
  goals,
  tickets,
  bots,
  selected,
  onOpenTicket,
}: {
  projects: CompanyProject[];
  projectId: string | "all";
  onProject: (id: string | "all") => void;
  goals: CompanyGoal[];
  tickets: CompanyTicket[];
  bots: Bot[];
  selected?: string | null;
  onOpenTicket: (id: string) => void;
}) {
  const shown = tickets.filter(
    (t) => projectId === "all" || t.projectId === projectId,
  );
  const shownGoals = goals.filter(
    (g) => projectId === "all" || g.projectId === projectId,
  );
  const bot = (id: string) => bots.find((b) => b.id === id);
  return (
    <section
      aria-label="Tickets"
      className="lilos-glass flex min-h-0 min-w-0 flex-col"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
        <h2 className="mr-2 font-semibold">Work</h2>
        {[{ id: "all", name: "All projects" }, ...projects].map((p) => (
          <button
            key={p.id}
            onClick={() => onProject(p.id)}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs",
              projectId === p.id
                ? "bg-primary/12 font-medium text-tint-text"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            {p.name}
          </button>
        ))}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {shownGoals.length > 0 && (
          <div className="mb-4 grid gap-2 sm:grid-cols-2">
            {shownGoals.map((g) => (
              <div key={g.id} className="rounded-xl border bg-background p-3">
                <div className="flex items-center gap-2 text-[13px]">
                  <TargetIcon className="size-4 shrink-0 text-tint-text" />
                  <span className="min-w-0 truncate font-medium">
                    {g.title}
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{
                      width: `${(g.progress.done / Math.max(1, g.progress.total)) * 100}%`,
                    }}
                  />
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {g.progress.done} of {g.progress.total} tickets done
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Columns size to the board, not the window: each needs ~220px. */}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {COLUMNS.map((col) => {
            const rows = shown.filter((t) => col.states.includes(t.state));
            return (
              <div key={col.title} className="min-w-0">
                <div className="mb-2 flex items-center gap-2 px-1 font-semibold text-[11px] text-muted-foreground">
                  {col.title}
                  <span className="rounded-full bg-muted-foreground/12 px-1.5">
                    {rows.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {rows.map((t) => {
                    const b = bot(t.assignee);
                    return (
                      <button
                        key={t.id}
                        onClick={() => onOpenTicket(t.id)}
                        className={cn(
                          "lilos-lift block w-full rounded-xl border bg-background p-3 text-left",
                          selected === t.id && "ring-2 ring-primary/60",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {t.id}
                          </span>
                          <TicketStatePill state={t.state} />
                        </div>
                        <div className="mt-1.5 font-medium text-[13px] leading-snug">
                          {t.title}
                        </div>
                        {b && (
                          <div className="mt-2 flex items-center gap-2 text-[11.5px] text-muted-foreground">
                            <BotAvatar bot={b} size={20} />
                            <span className="truncate">{b.name}</span>
                            <ProviderChip
                              provider={b.provider}
                              className="ml-auto"
                            />
                          </div>
                        )}
                        <div className="mt-1.5 truncate text-[11.5px] text-muted-foreground">
                          {t.update} · {t.updatedAgo}
                        </div>
                      </button>
                    );
                  })}
                  {rows.length === 0 && (
                    <div className="rounded-xl border border-dashed px-3 py-4 text-center text-[11.5px] text-muted-foreground">
                      Nothing here
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
