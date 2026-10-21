import { ChevronRightIcon } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { Streamdown } from "streamdown";
import {
  safeMessageComponents,
  safeMessageRehypePlugins,
} from "../components/ai-elements/message-safety";
import { Shimmer } from "../components/ai-elements/shimmer";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { useTurnBlockState } from "../lib/block-state";
import { cn } from "../lib/utils";
import type { Step } from "../types";
import { StatusDot } from "../v3/v3-marks";
import { WorkStep } from "./work-step";
import { formatDur, stepFacts, stepNow } from "./work-steps";

/* A turn's work folded into ONE quiet line — "Worked 2m · read 2 files,
   1 search" — that opens to every step and, while the turn runs, reads
   "Working · {step}" with the live output tail under the running step
   (the v3 design's work block). Reasoning lives inside the fold. Open state
   is a DEFAULT only (#320): the block opens itself while the turn is in its
   thinking/tools phases, and the first user click wins for the rest of the
   turn, in either direction. */

const BOX =
  "-ml-1.5 flex min-h-7 max-w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[13.5px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground";
const ROW = `group ${BOX}`;

/* The hairline the folded rows hang from. */
const RAIL = "ml-[7px] border-[var(--v3-line)] border-l pl-3.5";

export function TurnWork({
  steps,
  reasoning,
  thought,
  dur,
  live,
  thinking,
  working: workingProp,
  idle = "thinking…",
  autoOpen,
  waitingApproval,
  openKey,
  changed,
  onOpenChanges,
}: {
  steps: Step[];
  /** The turn's reasoning text (`""` while it has only just started). */
  reasoning?: string;
  /** Seconds the model thought, once it stopped. */
  thought?: number;
  /** Seconds the turn worked, once it ended. */
  dur?: number;
  /** The turn is in flight. */
  live?: boolean;
  /** The reasoning is still streaming. */
  thinking?: boolean;
  /** What the line says while nothing runs ("Waiting for your answer…");
      defaults to "thinking…". */
  idle?: string;
  /** The turn has not started its answer yet — the line reads "Working".
      Defaults to "a step runs or the model is thinking". */
  working?: boolean;
  autoOpen?: boolean;
  /* The turn is parked on an approval (engine request.opened): the running
     step reads "Waiting for approval" (issue #71, AC-4). */
  waitingApproval?: boolean;
  /* Conv-scoped persist key — survives card remounts (#320). */
  openKey?: string;
  /** Files the turn changed (the Workbench's Changes count): "edited N files"
      says this number. */
  changed?: number;
  /** Opens the Changes tab; absent (no Workbench here) = plain text. */
  onOpenChanges?: () => void;
}) {
  const [userSet, setUserSet] = useTurnBlockState<boolean | undefined>(
    openKey,
    undefined,
  );
  const open = userSet ?? !!autoOpen;
  const runIdx = steps.map((s) => !!s.running).lastIndexOf(true);
  const working = workingProp ?? (runIdx >= 0 || !!thinking);
  const hasReasoning = reasoning !== undefined;
  /* #400: the reasoning stays in the DOM when the fold is closed — the
     turn's text must not silently leave the page while the model still
     has it, and `until-found` lets in-page search reach it. React's types
     only know boolean `hidden`, so the attribute is set here; when a find
     lands inside it the browser un-hides it and the fold follows (opens),
     or the next render would hide the match again. */
  const held = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (open) held.current?.removeAttribute("hidden");
    else held.current?.setAttribute("hidden", "until-found");
  }, [open, hasReasoning]);
  useLayoutEffect(() => {
    const el = held.current;
    const reveal = () => setUserSet(true);
    el?.addEventListener("beforematch", reveal);
    return () => el?.removeEventListener("beforematch", reveal);
  }, [hasReasoning, setUserSet]);
  /* A turn that has only just started has nothing to open yet. */
  const foldable = steps.length > 0 || hasReasoning;

  const facts = [
    ...(hasReasoning ? [`thought for ${thought || 1}s`] : []),
    ...stepFacts(steps, changed),
  ];
  /* "edited N files" opens the Changes tab where the host has one: the
     turn's one files-changed entry (the footer carries none). */
  const edited = facts.findIndex((f) => f.startsWith("edited "));
  const link = !working && !!onOpenChanges && (changed ?? 0) > 0 && edited >= 0;
  /* A folded block still says what the turn is blocked on; an open one
     says it on the step's own row, so it isn't repeated up here. */
  const now =
    waitingApproval && !open
      ? "Waiting for approval"
      : runIdx >= 0
        ? stepNow(steps[runIdx])
        : idle;

  return (
    <Collapsible
      open={open}
      onOpenChange={setUserSet}
      data-tasksteps
      className="min-w-0"
    >
      {link ? (
        /* The line splits around the link (a button never holds another):
           everything but "edited N files" still toggles the fold. */
        <div className={BOX}>
          <CollapsibleTrigger className="group inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-data-[panel-open]:rotate-90" />
            Worked{dur ? ` ${formatDur(dur)}` : ""}
          </CollapsibleTrigger>{" "}
          <span className="flex min-w-0 text-muted-foreground/70">
            <CollapsibleTrigger className="min-w-0 truncate whitespace-pre">
              {`· ${facts
                .slice(0, edited)
                .map((f) => `${f}, `)
                .join("")}`}
            </CollapsibleTrigger>
            <button
              type="button"
              data-files-changed
              title="Open the changes"
              onClick={onOpenChanges}
              className="shrink-0 whitespace-nowrap underline-offset-2 hover:text-foreground hover:underline"
            >
              {facts[edited]}
            </button>
            {edited < facts.length - 1 && (
              <CollapsibleTrigger className="min-w-0 truncate whitespace-pre">
                {`, ${facts.slice(edited + 1).join(", ")}`}
              </CollapsibleTrigger>
            )}
          </span>
        </div>
      ) : (
        <CollapsibleTrigger
          disabled={!foldable}
          className={cn(
            ROW,
            !foldable && "cursor-default hover:bg-transparent",
          )}
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-data-[panel-open]:rotate-90",
              !foldable && "invisible",
            )}
          />
          {working ? (
            <>
              <StatusDot status="working" />
              <span className="font-medium text-foreground">Working</span>{" "}
              <span className="min-w-0 truncate text-muted-foreground/70">
                · {now}
              </span>
            </>
          ) : (
            <>
              <span className="whitespace-nowrap">
                Worked{dur ? ` ${formatDur(dur)}` : ""}
              </span>{" "}
              {facts.length > 0 && (
                <span className="min-w-0 truncate text-muted-foreground/70">
                  · {facts.join(", ")}
                </span>
              )}
            </>
          )}
        </CollapsibleTrigger>
      )}
      {/* Not a Collapsible: the steps panel alone unmounts on close. */}
      {hasReasoning && (
        <div ref={held} className={RAIL}>
          {/* The spacing sits inside: a hidden-until-found box keeps its own
              margin and padding, which would show as a gap when folded. */}
          <div className="mt-1 pb-1 text-[13.5px] text-muted-foreground">
            <div className="min-h-[30px] py-1 italic">
              {live && thinking ? (
                <Shimmer duration={1}>Thinking…</Shimmer>
              ) : (
                <span>Thought for {thought || 1}s</span>
              )}
            </div>
            {reasoning && (
              <div className="lilos-prose compact max-h-64 overflow-y-auto break-words leading-snug">
                <Streamdown
                  components={safeMessageComponents}
                  rehypePlugins={safeMessageRehypePlugins}
                >
                  {reasoning}
                </Streamdown>
              </div>
            )}
          </div>
        </div>
      )}
      {steps.length > 0 && (
        <CollapsibleContent className={cn(RAIL, !hasReasoning && "mt-1")}>
          {steps.map((s, i) => (
            // Steps are an append-only log, so the index is their identity.
            <WorkStep
              key={i}
              s={s}
              tail={i === runIdx && !!live && !waitingApproval}
              waiting={!!waitingApproval && i === runIdx}
            />
          ))}
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
