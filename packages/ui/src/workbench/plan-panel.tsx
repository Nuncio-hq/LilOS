import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { ScrollArea } from "../components/ui/scroll-area";
import { PlanRisks, PlanSteps, planProgress } from "../conversation/plan-card";
import { cn } from "../lib/utils";
import type { Plan, Thread, Todo } from "../types";

/* Workbench → Plan (issue #175): the session's current plan in full — goal, progress,
   every step with its files, risks — and the earlier versions it replaced, folded. */

/** Every plan the session proposed, oldest first. */
export function threadPlans(thread: Thread): Plan[] {
  return thread.replies.flatMap((r) => (r.plan ? [r.plan] : []));
}

/** The approved plan's steps as the checklist the Focus tray shows. */
export function planTodos(thread: Thread): Todo[] {
  const p = [...threadPlans(thread)]
    .reverse()
    .find((x) => x.status === "approved");
  return p ? p.steps.map((s) => ({ content: s.text, status: s.status })) : [];
}

const LABEL: Record<Plan["status"], string> = {
  proposed: "Waiting for your decision",
  approved: "Approved",
  replaced: "Replaced",
  rejected: "Rejected",
};

function Older({ p }: { p: Plan }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-muted-foreground"
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        <span className="shrink-0 whitespace-nowrap">
          v{p.version} · {LABEL[p.status]}
        </span>
        <span className="min-w-0 truncate">· {p.goal}</span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          <PlanSteps plan={p} />
        </div>
      )}
    </div>
  );
}

export function PlanPanel({ plans }: { plans: Plan[] }) {
  const current = plans[plans.length - 1];
  if (!current)
    return (
      <div className="grid h-full place-items-center p-8 text-center text-muted-foreground text-xs">
        No plan in this session yet.
      </div>
    );
  const { done, total, pct } = planProgress(current);
  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 p-4" data-planpanel>
        <section className="space-y-3">
          <div className="flex items-baseline gap-2">
            <h3 className="font-semibold text-[15px]">
              Plan{current.version > 1 && ` v${current.version}`}
            </h3>
            <span
              className={cn(
                "text-[12px]",
                current.status === "proposed"
                  ? "text-amber-600"
                  : current.status === "rejected"
                    ? "text-red-600"
                    : "text-muted-foreground",
              )}
            >
              {LABEL[current.status]}
            </span>
            <span className="ml-auto font-mono text-[12px] text-muted-foreground">
              {done}/{total}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-emerald-500 transition-[width] duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-[13.5px] leading-5">
            <span className="text-muted-foreground">Goal · </span>
            {current.goal}
          </p>
          <PlanSteps plan={current} />
          {!!current.risks?.length && <PlanRisks risks={current.risks} />}
        </section>
        {plans.length > 1 && (
          <section className="space-y-2">
            <h4 className="font-medium text-[11.5px] text-muted-foreground uppercase tracking-wide">
              Earlier versions
            </h4>
            {plans
              .slice(0, -1)
              .reverse()
              .map((p) => (
                <Older key={p.id} p={p} />
              ))}
          </section>
        )}
      </div>
    </ScrollArea>
  );
}
