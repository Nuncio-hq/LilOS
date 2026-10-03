import {
  ArrowUpRightIcon,
  BanIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  NetworkIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { MessageResponse } from "../components/ai-elements/message";
import { Shimmer } from "../components/ai-elements/shimmer";
import { Task, TaskContent, TaskTrigger } from "../components/ai-elements/task";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { useTurnBlockState } from "../lib/block-state";
import { inline, plural } from "../lib/helpers";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type { EmpFn, Subagent } from "../types";
import { StepRow } from "../workbench/step-row";

/* The helpers a turn spun off (issue #170). Where a Workbench exists the turn shows only
   SubagentsLink and the rows live in the Workbench → Subagents tab (#317), so a running helper
   never turns one message into the place to watch it. Without a Workbench: one collapsible block
   under the turn, the same
   Task shell as TurnSteps. Each row reads as: who, what it's doing now (the live step, or its
   result line once finished), how long. A subagent opens in place to its own steps + report;
   an employee helper worked in their own session, so its row only links there (onOpenSession,
   rendered only when passed — D-#19). */

const STATUS_ICON: Record<Subagent["status"], React.ReactNode> = {
  running: <CircleDotIcon className="size-3.5 animate-pulse text-work" />,
  done: <CheckIcon className="size-3.5 text-emerald-600" />,
  failed: <XIcon className="size-3.5 text-red-600" />,
  stopped: <BanIcon className="size-3.5 text-muted-foreground" />,
};

/* What the row says right now: the running tool + its argument, else the report's first line. */
function nowLine(a: Subagent): string {
  if (a.status === "running") {
    if (a.employee) return "Working in their own session…";
    const s = a.steps.find((x) => x.running) ?? a.steps[a.steps.length - 1];
    if (!s) return "Starting…";
    const arg = String(
      s.input.command ?? s.input.path ?? s.input.pattern ?? s.input.query ?? "",
    );
    return `${s.tool} ${arg}`.trim();
  }
  const first = (a.result ?? "").split("\n").find((l) => l.trim()) ?? "";
  return inline(first) || a.status;
}

export function SubagentRow({
  a,
  emp,
  onOpenSession,
}: {
  a: Subagent;
  emp: EmpFn;
  onOpenSession?: (employeeId: string, session: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const helper = a.employee ? emp(a.employee.id) : undefined;
  const running = a.status === "running";
  const line = nowLine(a);
  const head = (
    <>
      <span className="grid size-5 shrink-0 place-items-center">
        {helper ? (
          <HermesAvatar name={helper.name} className="size-5" />
        ) : (
          STATUS_ICON[a.status]
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium text-[13px] text-foreground">
            {helper ? `${helper.name} · ${a.name}` : a.name}
          </span>
          {helper && STATUS_ICON[a.status]}
        </span>
        {running ? (
          <Shimmer
            as="span"
            duration={1.5}
            className={cn(
              "block truncate text-[12px]",
              !a.employee && "font-mono",
            )}
          >
            {line}
          </Shimmer>
        ) : (
          <span
            className={cn(
              "block truncate text-[12.5px] text-muted-foreground",
              a.status === "failed" && "text-red-600",
            )}
          >
            {line}
          </span>
        )}
      </span>
      <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
        {a.dur !== undefined && `${a.dur}s`}
      </span>
    </>
  );

  if (a.employee) {
    return (
      <div
        data-subagent={a.id}
        data-status={a.status}
        className="flex items-center gap-2.5 rounded-lg px-2 py-1.5"
      >
        {head}
        {onOpenSession && (
          <button
            type="button"
            onClick={() => onOpenSession(a.employee!.id, a.employee!.session)}
            className="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Open session
            <ArrowUpRightIcon className="size-3" />
          </button>
        )}
      </div>
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-subagent={a.id}
      data-status={a.status}
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-muted/60">
        {head}
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1 pr-1 pb-2 pl-9">
        <p className="mb-1.5 text-[12.5px] text-muted-foreground">
          <span className="font-medium text-foreground/80">Brief · </span>
          {a.task}
        </p>
        {a.steps.map((s, i) => (
          <StepRow key={i} s={s} />
        ))}
        {a.result && (
          <div className="mt-2 rounded-lg bg-muted/50 px-3 py-2 text-[13px]">
            <MessageResponse className="lilos-prose break-words">
              {a.result}
            </MessageResponse>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function TurnSubagents({
  agents,
  emp,
  onOpenSession,
  openKey,
}: {
  agents: Subagent[];
  emp: EmpFn;
  onOpenSession?: (employeeId: string, session: string) => void;
  /* Conv-scoped persist key — survives card remounts (#320). */
  openKey?: string;
}) {
  /* #320: same rule as TurnSteps — running opens the block by default; the
     first user click wins for the rest of the turn, and an untouched block
     folds back to "N subagents" when the run ends. */
  const [userSet, setUserSet] = useTurnBlockState<boolean | undefined>(
    openKey,
    undefined,
  );
  const running = agents.filter((a) => a.status === "running").length;
  const failed = agents.filter((a) => a.status === "failed").length;
  const title = running
    ? `${running} of ${plural(agents.length, "subagent")} running`
    : plural(agents.length, "subagent");
  return (
    <Task
      className="mb-1 w-full"
      open={userSet ?? running > 0}
      onOpenChange={setUserSet}
      data-subagents
    >
      <TaskTrigger title={title}>
        <div className="flex w-fit cursor-pointer items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground">
          <NetworkIcon
            className={cn(
              "size-3.5",
              running ? "animate-pulse text-work" : "text-emerald-600",
            )}
          />
          <span>{title}</span>
          {failed > 0 && (
            <span className="text-red-600">· {failed} failed</span>
          )}
          <ChevronDownIcon className="size-3.5 transition-transform group-data-[panel-open]:rotate-180" />
        </div>
      </TaskTrigger>
      <TaskContent className="[&>div]:mt-2 [&>div]:space-y-0.5 [&>div]:pl-2">
        {agents.map((a) => (
          <SubagentRow
            key={a.id}
            a={a}
            emp={emp}
            onOpenSession={onOpenSession}
          />
        ))}
      </TaskContent>
    </Task>
  );
}

/* The turn's one-line pointer to Workbench → Subagents (#317): "3 subagents · 2 running · Open". */
export function SubagentsLink({
  agents,
  onOpen,
}: {
  agents: Subagent[];
  onOpen: () => void;
}) {
  const running = agents.filter((a) => a.status === "running").length;
  const failed = agents.filter((a) => a.status === "failed").length;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-subagents-link
      className="mb-1 flex w-fit items-center gap-1.5 rounded-md text-muted-foreground text-xs transition-colors hover:text-foreground"
    >
      <NetworkIcon
        className={cn(
          "size-3.5",
          running ? "animate-pulse text-work" : "text-emerald-600",
        )}
      />
      <span>{plural(agents.length, "subagent")}</span>
      {running > 0 && <span className="text-work">· {running} running</span>}
      {failed > 0 && <span className="text-red-600">· {failed} failed</span>}
      <span className="flex items-center gap-0.5 font-medium">
        · Open
        <ChevronRightIcon className="size-3.5" />
      </span>
    </button>
  );
}
