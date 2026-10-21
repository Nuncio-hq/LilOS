import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDotIcon,
  ListChecksIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import type { Plan, PlanStep } from "../types";
import { DOT, INK, StatusPill } from "../v3/v3-marks";
import { CardButton, CardLink, KEY_HINT } from "./card-bits";

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
      <span className="grid size-5 shrink-0 place-items-center">
        <CheckIcon className={cn("size-3.5", INK.done)} />
      </span>
    );
  if (s.status === "in_progress")
    return (
      <span className="grid size-5 shrink-0 place-items-center">
        <CircleDotIcon className={cn("size-3.5 animate-pulse", INK.working)} />
      </span>
    );
  return (
    <span className="grid size-5 shrink-0 place-items-center rounded-full border border-[var(--v3-line)] font-mono text-[10.5px] text-muted-foreground">
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
                    className="rounded-[5px] bg-[var(--v3-soft)] px-1 py-px font-mono text-[11px] text-muted-foreground"
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

/* Risks sit under the steps behind a hairline — a note, not a warning box. */
export function PlanRisks({ risks }: { risks: string[] }) {
  return (
    <div className="border-[var(--v3-line)] border-t pt-2.5 text-[13px] text-muted-foreground">
      <p className="mb-0.5 font-medium text-foreground">Risks</p>
      <ul className="list-disc space-y-0.5 pl-5">
        {risks.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

/* Where the card is in its life: waiting on you, working, done, stopped mid-way, or
   superseded. Done folds to one quiet line (plans: with the goal) — tap for the steps. */
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
      return <StatusPill status="needs" label="Waiting for you" />;
    case "working":
      return (
        <span
          className={cn("font-medium font-mono text-[12.5px]", INK.working)}
        >
          {done}/{total}
        </span>
      );
    case "done":
      return (
        <span className="text-[12.5px] text-muted-foreground">
          {total}/{total} done
        </span>
      );
    case "stopped":
      return (
        <span className="text-[12.5px] text-muted-foreground">
          Stopped · {done}/{total}
        </span>
      );
    case "replaced":
      return (
        <span className="text-[12.5px] text-muted-foreground">
          Replaced by v{plan.version + 1}
        </span>
      );
    default:
      return <span className={cn("text-[12.5px]", INK.failed)}>Rejected</span>;
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
  const quiet = muted || (folded && !shown);
  const name = tasks
    ? "Tasks"
    : `Plan${plan.version > 1 ? ` v${plan.version}` : ""}`;
  return (
    <div
      data-plan={plan.id}
      data-planstatus={plan.status}
      data-planphase={phase}
      // A folded plan is a quiet receipt line; the hairline appears with the steps.
      className={cn(
        "w-full",
        shown && "rounded-[10px] border border-[var(--v3-line)]",
      )}
    >
      <button
        type="button"
        disabled={!folded}
        onClick={() => setOpen(!shown)}
        aria-expanded={folded ? shown : undefined}
        className={cn(
          "flex w-full items-center gap-2 text-left text-[13.5px]",
          folded && !shown ? "py-1" : "px-4 pt-3.5 pb-2.5",
        )}
      >
        {finished ? (
          <CheckIcon className="size-3.5 shrink-0 text-emerald-600" />
        ) : (
          <ListChecksIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          className={cn(
            "shrink-0",
            quiet ? "text-muted-foreground" : "font-medium text-foreground",
          )}
        >
          {finished ? `${name} done` : name}
        </span>
        {folded && !shown && plan.goal ? (
          <span className="min-w-0 truncate text-muted-foreground">
            · {plan.goal}
          </span>
        ) : (
          <span className="shrink-0 text-muted-foreground">
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
        <div className="mx-4 mb-2.5 h-1 overflow-hidden rounded-full bg-[var(--v3-soft)]">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500",
              DOT.working,
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {shown && (
        <div className="space-y-3 px-4 pb-3.5">
          {plan.goal && (
            <p className="text-[13.5px] leading-normal">
              <span className="text-muted-foreground">Goal · </span>
              {plan.goal}
            </p>
          )}
          <PlanSteps plan={plan} />
          {phase === "waiting" && !!plan.risks?.length && (
            <PlanRisks risks={plan.risks} />
          )}
          {(phase === "waiting" && onAction) || (onOpen && !muted) ? (
            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              {onOpen && !muted && (
                <button
                  type="button"
                  onClick={onOpen}
                  className="mr-auto flex items-center gap-0.5 text-[12.5px] text-muted-foreground hover:text-foreground"
                >
                  Open in Workbench
                  <ArrowUpRightIcon className="size-3" />
                </button>
              )}
              {phase === "waiting" && onAction && (
                <>
                  <CardLink onClick={() => onAction("reject", plan.id)}>
                    Reject
                  </CardLink>
                  <CardButton onClick={() => onAction("change", plan.id)}>
                    Change…
                  </CardButton>
                  <CardButton
                    primary
                    onClick={() => onAction("approve", plan.id)}
                  >
                    Approve
                  </CardButton>
                </>
              )}
            </div>
          ) : null}
          {phase === "waiting" && keyHint && (
            <div data-ask-keyhint className={KEY_HINT}>
              Answer from the keyboard: ↵ Approve · ⌫ Reject
            </div>
          )}
        </div>
      )}
    </div>
  );
}
