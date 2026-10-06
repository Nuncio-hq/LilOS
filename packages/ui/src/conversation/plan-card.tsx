import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDotIcon,
  ListChecksIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { Plan, PlanStep } from "../types";

/* The plan an employee proposes before touching code (issue #175), as a card under its
   turn. Proposed: goal, numbered steps with the files each touches, risks, and the three
   decisions — Approve, Change (you reply with what to change), Reject. Approved: the same
   steps become the live checklist. Replaced / rejected plans fold to one muted line.
   Every button renders only when its handler is passed (D-#19). */

export type PlanAction = "approve" | "change" | "reject";

export function planProgress(p: Plan) {
  const done = p.steps.filter((s) => s.status === "completed").length;
  return { done, total: p.steps.length, pct: (done / p.steps.length) * 100 };
}

function StepMark({ s, n }: { s: PlanStep; n: number }) {
  if (s.status === "completed")
    return (
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-600">
        <CheckIcon className="size-3" />
      </span>
    );
  if (s.status === "in_progress")
    return (
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-work/15 text-work">
        <CircleDotIcon className="size-3 animate-pulse" />
      </span>
    );
  return (
    <span className="grid size-5 shrink-0 place-items-center rounded-full border font-mono text-[10.5px] text-muted-foreground">
      {n}
    </span>
  );
}

export function PlanSteps({ plan }: { plan: Plan }) {
  return (
    <ol className="space-y-1.5">
      {plan.steps.map((s, i) => (
        <li key={i} className="flex gap-2.5" data-planstep={s.status}>
          <StepMark s={s} n={i + 1} />
          <div className="min-w-0 flex-1 pt-px">
            <p
              className={cn(
                "text-[13.5px] leading-5",
                s.status === "completed" && "text-muted-foreground",
                s.status === "cancelled" &&
                  "text-muted-foreground line-through",
              )}
            >
              {s.text}
            </p>
            {!!s.files?.length && (
              <p className="mt-0.5 flex flex-wrap gap-1">
                {s.files.map((f) => (
                  <code
                    key={f}
                    className="rounded bg-muted px-1 py-px font-mono text-[11px] text-muted-foreground"
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

export function PlanRisks({ risks }: { risks: string[] }) {
  return (
    <div className="rounded-lg bg-amber-500/8 px-3 py-2 text-[12.5px] text-amber-800 dark:text-amber-300">
      <p className="mb-0.5 flex items-center gap-1.5 font-medium">
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

/* Where the card is in its life: waiting on you, working, done, stopped mid-way, or
   superseded. Done folds to one green line (plans: with the goal) — tap for the steps. */
function planPhase(p: Plan) {
  const { done, total } = planProgress(p);
  if (p.status === "proposed") return "waiting";
  if (p.status === "replaced" || p.status === "rejected") return p.status;
  if (done === total) return "done";
  if (p.steps.some((s) => s.status === "cancelled")) return "stopped";
  return "working";
}

function Status({ plan }: { plan: Plan }) {
  const { done, total } = planProgress(plan);
  switch (planPhase(plan)) {
    case "waiting":
      return (
        <span className="flex items-center gap-1.5 rounded-full bg-primary/12 px-2 py-0.5 font-semibold text-[11.5px] text-tint-text">
          <span className="size-1.5 animate-pulse rounded-full bg-primary" />
          Waiting for you
        </span>
      );
    case "working":
      return (
        <span className="font-medium font-mono text-[12px] text-work">
          {done}/{total}
        </span>
      );
    case "done":
      return (
        <span className="font-medium text-[12px] text-emerald-600">
          {total}/{total} done
        </span>
      );
    case "stopped":
      return (
        <span className="text-[12px] text-muted-foreground">
          Stopped · {done}/{total}
        </span>
      );
    case "replaced":
      return (
        <span className="text-[12px] text-muted-foreground">
          Replaced by v{plan.version + 1}
        </span>
      );
    default:
      return <span className="text-[12px] text-red-600">Rejected</span>;
  }
}

export function PlanCard({
  plan,
  onAction,
  onOpen,
  keyHint,
}: {
  plan: Plan;
  onAction?: (a: PlanAction, planId: string) => void;
  /** Opens the Workbench Plan tab. */
  onOpen?: () => void;
  /** #558: this waiting card answers from the keyboard — show the keys. */
  keyHint?: boolean;
}) {
  const phase = planPhase(plan);
  const tasks = plan.kind === "tasks";
  const finished = phase === "done";
  const muted = phase === "replaced" || phase === "rejected";
  const folded = muted || finished;
  // Unset = follow the phase: the card folds on its own once done, replaced or rejected.
  const [open, setOpen] = useState<boolean | null>(null);
  const { pct } = planProgress(plan);
  const shown = !folded || !!open;
  const name = tasks
    ? "Tasks"
    : `Plan${plan.version > 1 ? ` v${plan.version}` : ""}`;
  return (
    <div
      data-plan={plan.id}
      data-planstatus={plan.status}
      data-planphase={phase}
      className={cn(
        "w-full max-w-xl overflow-hidden rounded-xl border bg-background",
        phase === "waiting" &&
          "border-primary/40 shadow-[0_0_0_4px] shadow-primary/8",
        finished && "border-emerald-500/30 bg-emerald-500/[0.04]",
        muted && "bg-muted/30",
      )}
    >
      <button
        type="button"
        disabled={!folded}
        onClick={() => setOpen(!shown)}
        className={cn(
          "flex w-full items-center gap-2 px-3.5 text-left",
          folded && !shown ? "py-2.5" : "pt-3 pb-2",
        )}
      >
        {finished ? (
          <CircleCheckIcon className="size-4 shrink-0 text-emerald-600" />
        ) : (
          <ListChecksIcon
            className={cn(
              "size-4 shrink-0",
              muted ? "text-muted-foreground" : "text-foreground",
            )}
          />
        )}
        <span
          className={cn(
            "shrink-0 font-semibold text-[13.5px]",
            muted && "text-muted-foreground",
          )}
        >
          {finished ? `${name} done` : name}
        </span>
        {folded && !shown && plan.goal ? (
          <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
            · {plan.goal}
          </span>
        ) : (
          <span className="shrink-0 text-[12px] text-muted-foreground">
            · {plan.steps.length} {tasks ? "tasks" : "steps"}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <Status plan={plan} />
          {folded && (
            <ChevronRightIcon
              className={cn(
                "size-3.5 text-muted-foreground transition-transform",
                shown && "rotate-90",
              )}
            />
          )}
        </span>
      </button>
      {(phase === "working" || phase === "stopped") && (
        <div className="mx-3.5 mb-2 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {shown && (
        <div className="space-y-3 px-3.5 pb-3.5">
          {plan.goal && (
            <p className="text-[13.5px] leading-5">
              <span className="text-muted-foreground">Goal · </span>
              {plan.goal}
            </p>
          )}
          <PlanSteps plan={plan} />
          {phase === "waiting" && !!plan.risks?.length && (
            <PlanRisks risks={plan.risks} />
          )}
          {(phase === "waiting" && onAction) || (onOpen && !muted) ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {phase === "waiting" && onAction && (
                <>
                  <Button
                    size="sm"
                    onClick={() => onAction("approve", plan.id)}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onAction("change", plan.id)}
                  >
                    Change…
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => onAction("reject", plan.id)}
                  >
                    Reject
                  </Button>
                </>
              )}
              {onOpen && !muted && (
                <button
                  type="button"
                  onClick={onOpen}
                  className="ml-auto flex items-center gap-0.5 text-[12px] text-muted-foreground hover:text-foreground"
                >
                  Open in Workbench
                  <ArrowUpRightIcon className="size-3" />
                </button>
              )}
            </div>
          ) : null}
          {phase === "waiting" && keyHint && (
            <div data-ask-keyhint className="text-[11px] text-muted-foreground">
              Answer from the keyboard: ↵ Approve · ⌫ Reject
            </div>
          )}
        </div>
      )}
    </div>
  );
}
