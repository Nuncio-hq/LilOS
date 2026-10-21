import {
  BotIcon,
  ChevronRightIcon,
  FileTextIcon,
  GlobeIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { stripAnsi } from "../lib/helpers";
import { cn } from "../lib/utils";
import type { Step } from "../types";
import { Spinner } from "../v3/v3-bits";
import { DiffStat } from "../workbench/diff-view";
import { StepDetail } from "./step-detail";
import {
  failedStep,
  type StepKind,
  stepKind,
  stepTarget,
  stepVerb,
} from "./work-steps";

/* One step inside an opened work fold: icon · verb · mono target · meta,
   expanding to the step itself (diff / command output / inputs). The running
   step swaps its icon for a spinner and shows the output tail arriving. */

const ICON: Record<StepKind, typeof FileTextIcon> = {
  read: FileTextIcon,
  search: SearchIcon,
  edit: PencilIcon,
  run: TerminalIcon,
  web: GlobeIcon,
  delegate: BotIcon,
  other: WrenchIcon,
};

/* Lines of the running command's output kept on screen. */
const TAIL_LINES = 5;

/** The running command and its output, last lines only — the box keeps one
    height so arriving lines never push the page around. */
function LiveOutput({ s }: { s: Step }) {
  const cmd = typeof s.input.command === "string" ? s.input.command : "";
  const lines = stripAnsi(s.output)
    .split("\n")
    .filter((l) => l.trim())
    .slice(-TAIL_LINES);
  if (!cmd && !lines.length) return null;
  return (
    <div data-live-output className="mt-1 mb-1.5">
      {cmd && (
        <div className="break-all font-mono text-[12.5px] text-foreground">
          {cmd}
        </div>
      )}
      {lines.length > 0 && (
        <div className="mt-1.5 overflow-hidden rounded-[7px] bg-[var(--v3-soft)] px-3 py-2 font-mono text-[12px] text-muted-foreground leading-[1.7]">
          {lines.map((l, i) => (
            <div
              key={`${lines.length}:${i}`}
              className="lilos-v3-line-in truncate"
            >
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkStep({
  s,
  tail,
  waiting,
}: {
  s: Step;
  /** Show the output tail under this (the turn's running) step. */
  tail: boolean;
  /** The turn is parked on an approval for this step. */
  waiting: boolean;
}) {
  const kind = stepKind(s);
  const running = !!s.running;
  const bad = !running && failedStep(s);
  const Icon = ICON[kind];
  const target = stepTarget(s);
  const hasBody =
    !running && (!!s.diff || !!s.output || Object.keys(s.input).length > 0);
  const tone = bad
    ? "text-red-600 dark:text-red-300"
    : running
      ? "text-sky-700 dark:text-sky-300"
      : "";
  return (
    <Collapsible>
      <CollapsibleTrigger
        className={cn(
          "group/step -ml-1.5 flex min-h-[30px] w-[calc(100%+0.375rem)] items-center gap-2.5 rounded-md px-1.5 text-left text-[13.5px] hover:bg-[var(--v3-hover)]",
          !hasBody && "cursor-default",
        )}
      >
        {running ? (
          <Spinner className="size-[15px]" />
        ) : (
          <Icon
            aria-hidden
            className={cn(
              "size-[15px] shrink-0 text-muted-foreground",
              bad && "text-red-500 dark:text-red-400",
            )}
          />
        )}
        <span
          className={cn(
            "w-[70px] shrink-0 truncate text-muted-foreground",
            tone,
          )}
        >
          {stepVerb(s, kind, running)}
        </span>
        <span
          title={target}
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-[12.5px]",
            tone,
          )}
        >
          {target}
        </span>
        {waiting ? (
          <span className="shrink-0 whitespace-nowrap text-[12.5px] text-sky-700 dark:text-sky-300">
            Waiting for approval
          </span>
        ) : s.dispatched ? (
          <span className="shrink-0 whitespace-nowrap text-[12.5px] text-sky-700 dark:text-sky-300">
            Dispatched
          </span>
        ) : bad ? (
          <span className="shrink-0 whitespace-nowrap text-[12.5px] text-red-600 dark:text-red-300">
            {s.status}
          </span>
        ) : s.diff ? (
          <DiffStat add={s.diff.add} del={s.diff.del} />
        ) : s.commit ? (
          <span className="shrink-0 font-mono text-[12px] text-muted-foreground/70">
            {s.commit.hash}
          </span>
        ) : null}
        {hasBody && (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-data-[panel-open]/step:rotate-90" />
        )}
      </CollapsibleTrigger>
      {tail && <LiveOutput s={s} />}
      {hasBody && (
        <CollapsibleContent className="mt-1 mb-2 min-w-0">
          <StepDetail s={s} />
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
