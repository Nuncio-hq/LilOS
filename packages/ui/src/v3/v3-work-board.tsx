import { cn } from "../lib/utils";
import { ago } from "./v3-bits";
import { AgentAvatar, INK, StatusDot } from "./v3-marks";
import { agentOf, FORMER_AGENT } from "./v3-model";
import { useOpenRecord } from "./v3-open-record";
import type { V3Status, V3Ticket } from "./v3-types";
import type { WorkViewProps } from "./v3-work-views";

/* The Board view: one column per status, a card per ticket. It is apart from
   the table-like views in v3-work-views.tsx because it shares none of their
   row anatomy (cards, not grid rows) and only needs the view props. */

const COLUMNS: {
  label: string;
  status: V3Status;
  match: (t: V3Ticket) => boolean;
}[] = [
  { label: "Needs you", status: "needs", match: (t) => t.status === "needs" },
  {
    label: "Stuck",
    status: "stuck",
    match: (t) => t.status === "stuck" || t.status === "failed",
  },
  { label: "Waiting", status: "waiting", match: (t) => t.status === "waiting" },
  { label: "Working", status: "working", match: (t) => t.status === "working" },
  { label: "Planned", status: "planned", match: (t) => t.status === "planned" },
  {
    label: "Done",
    status: "done",
    match: (t) => t.status === "done" && (t.doneAgo ?? 0) < 1440,
  },
];

export function BoardView({ data, go, tickets }: WorkViewProps) {
  const isOpen = useOpenRecord();
  return (
    <div className="mt-6 flex gap-3 overflow-x-auto pb-2">
      {COLUMNS.map((c) => {
        const rows = tickets.filter(c.match);
        return (
          <div key={c.label} className="w-[172px] shrink-0">
            <div className="mb-2 flex items-center gap-2 px-0.5 text-[13px] font-medium">
              <StatusDot status={c.status} />
              {c.label}
              <small className="font-normal text-muted-foreground/70">
                {rows.length}
              </small>
            </div>
            <div className="flex flex-col gap-2">
              {rows.map((t) => {
                const owner = agentOf(data, t.owner);
                return (
                  <button
                    type="button"
                    key={t.id}
                    onClick={() => go({ page: "ticket", id: t.id })}
                    className={cn(
                      "flex flex-col gap-2 rounded-lg border border-[var(--v3-line)] p-2.5 text-left transition-colors hover:bg-[var(--v3-hover)]",
                      isOpen("ticket", t.id) &&
                        "border-foreground/45 bg-[var(--v3-hover)]",
                    )}
                  >
                    <span className="text-[12px] text-muted-foreground/70">
                      {t.id}
                    </span>
                    <span className="text-[13.5px] leading-snug">
                      {t.title}
                    </span>
                    <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                      <AgentAvatar data={data} agent={owner} size={18} />
                      <span className="truncate">
                        {owner?.name ?? FORMER_AGENT}
                      </span>
                      <span
                        className={cn(
                          "ml-auto shrink-0",
                          t.status === "stuck" && t.since > 30
                            ? cn("font-semibold", INK.stuck)
                            : "text-muted-foreground/70",
                        )}
                      >
                        {t.status === "planned"
                          ? (t.startsAt ?? "—")
                          : ago(
                              t.status === "done" ? (t.doneAgo ?? 0) : t.since,
                            )}
                      </span>
                    </span>
                  </button>
                );
              })}
              {rows.length === 0 && (
                <div className="rounded-lg border border-[var(--v3-line)] border-dashed px-2.5 py-3 text-center text-[12.5px] text-muted-foreground/70">
                  Nothing
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
