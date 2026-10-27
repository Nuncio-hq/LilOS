import { ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { ScrollArea } from "../components/ui/scroll-area";
import { planProgress } from "../conversation/plan-card";
import { cn } from "../lib/utils";
import type { Plan, Thread, Todo } from "../types";
import { CARD, PANEL, PlanDot, WbEmpty, WbHead } from "./wb-bits";

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

/* A cancelled step is a todo that is struck through. */
function Steps({ plan }: { plan: Plan }) {
  return (
    <ol className="space-y-2">
      {plan.steps.map((s, i) => (
        <li key={i} className="flex gap-2" data-planstep={s.status}>
          <span className="mt-[2px] flex">
            <PlanDot
              state={
                s.status === "completed"
                  ? "done"
                  : s.status === "in_progress"
                    ? "current"
                    : "todo"
              }
            />
          </span>
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "text-[13px] leading-5",
                s.status === "pending" && "text-muted-foreground/70",
                s.status === "completed" && "text-muted-foreground",
                s.status === "cancelled" &&
                  "text-muted-foreground/70 line-through",
              )}
            >
              {s.text}
            </p>
            {!!s.files?.length && (
              <p className="mt-0.5 flex flex-wrap gap-1">
                {s.files.map((f) => (
                  <code
                    key={f}
                    className="rounded bg-[var(--v3-soft)] px-1 py-px font-mono text-[11px] text-muted-foreground"
                  >
                    {f}
                  </code>
                ))}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/* Risks are a caution, so the colour is amber text — no tinted box. */
function Risks({ risks }: { risks: string[] }) {
  return (
    <div className="text-[13px] text-amber-700 dark:text-amber-300">
      <p className="mb-1 flex items-center gap-1.5 font-medium">
        <TriangleAlertIcon className="size-3.5" />
        Risks
      </p>
      <ul className="list-disc space-y-0.5 pl-5">
        {risks.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

function Older({ p }: { p: Plan }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={CARD}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-[10px] px-3.5 py-2.5 text-left text-[13px] text-muted-foreground hover:bg-[var(--v3-hover)]"
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        <span className="shrink-0 whitespace-nowrap">
          v{p.version} · {LABEL[p.status]}
        </span>
        {p.goal && <span className="min-w-0 truncate">· {p.goal}</span>}
      </button>
      {open && (
        <div className="border-[var(--v3-line)] border-t px-3.5 py-3">
          <Steps plan={p} />
        </div>
      )}
    </div>
  );
}

export function PlanPanel({ plans }: { plans: Plan[] }) {
  const current = plans[plans.length - 1];
  if (!current) return <WbEmpty>No plan in this thread yet.</WbEmpty>;
  const { done, total, pct } = planProgress(current);
  return (
    <ScrollArea className="h-full">
      <div className={cn(PANEL, "space-y-6")} data-planpanel>
        <section className="space-y-3">
          <div className="flex items-baseline gap-2">
            <h3 className="font-semibold text-[15px]">
              {current.kind === "tasks"
                ? "Tasks"
                : `Plan${current.version > 1 ? ` v${current.version}` : ""}`}
            </h3>
            <span
              className={cn(
                "text-[12px]",
                current.status === "proposed"
                  ? "text-amber-600 dark:text-amber-400"
                  : current.status === "rejected"
                    ? "text-red-600 dark:text-red-400"
                    : "text-muted-foreground",
              )}
            >
              {done === total
                ? "Done"
                : current.kind === "tasks"
                  ? "The agent's own list"
                  : LABEL[current.status]}
            </span>
            <span className="ml-auto font-mono text-[12px] text-muted-foreground">
              {done}/{total}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-[var(--v3-soft)]">
            <div
              className="h-full rounded-full bg-foreground transition-[width] duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          {current.goal && (
            <p className="text-[13.5px] leading-5">
              <span className="text-muted-foreground">Goal · </span>
              {current.goal}
            </p>
          )}
          <Steps plan={current} />
          {!!current.risks?.length && <Risks risks={current.risks} />}
        </section>
        {plans.length > 1 && (
          <section>
            <WbHead count={String(plans.length - 1)}>Earlier versions</WbHead>
            <div className="space-y-2">
              {plans
                .slice(0, -1)
                .reverse()
                .map((p) => (
                  <Older key={p.id} p={p} />
                ))}
            </div>
          </section>
        )}
      </div>
    </ScrollArea>
  );
}
