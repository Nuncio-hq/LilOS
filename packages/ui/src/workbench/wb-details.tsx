import { WorkflowIcon } from "lucide-react";
import type { ReactNode } from "react";
import { effortLabel } from "../chat/model-picker";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  contextShare,
  contextUsedOf,
  contextWindowOf,
} from "../lib/context-window";
import { prettyPath } from "../lib/helpers";
import { cn } from "../lib/utils";
import type { Employee, ModelOption, Thread } from "../types";
import { threadPlans } from "./plan-panel";
import { sessionSubagents } from "./subagents-panel";
import { PlanDot, WbHead } from "./wb-bits";

/* Workbench → Details (the prototype's last tab): where the thread runs, the
   plan, its helpers — read only from what the thread already carries, so a
   field the engine never reported simply has no row. */

function Kv({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[32px] items-center justify-between gap-3 text-[13px]">
      <span className="text-muted-foreground">{k}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-right">
        {children}
      </span>
    </div>
  );
}

const mono = "truncate font-mono text-[12px]";

/** The plan steps to list: the current plan's, else the engine's own todo
    list when it kept one without proposing a plan. */
function planRows(thread: Thread) {
  const plans = threadPlans(thread);
  const current = plans[plans.length - 1];
  if (current)
    return current.steps.map((s) => ({ text: s.text, status: s.status }));
  return (thread.todos ?? []).map((t) => ({
    text: t.content,
    status: t.status,
  }));
}

export function DetailsPanel({
  thread,
  lead,
  folder,
  branch,
  startedAt,
  model,
  models,
}: {
  thread: Thread;
  lead?: Employee;
  /** The session's real folder (work.path / workspace cwd), when it has one. */
  folder?: string;
  branch?: string;
  /** Clock time of the thread's first message. */
  startedAt?: string;
  /** The thread's resolved model id (`sessionModelId` at the call site) —
      the one the header meter reads, so both surfaces agree (#294). Absent
      = the thread's own pick. */
  model?: string;
  /** Catalog to resolve the model's display name + its reported window. */
  models?: ModelOption[];
}) {
  const plan = planRows(thread);
  const done = plan.filter((p) => p.status === "completed").length;
  const helpers = sessionSubagents(thread);
  const modelId = model ?? thread.model;
  const used = contextUsedOf(thread.usage);
  /* Same inputs as the header meter's `SessionUsage`: the resolved model
     and the catalog, so one thread never reads two percentages (#294). */
  const { tokens: window } = contextWindowOf(thread.usage, modelId, models);
  const share = thread.usage ? Math.round(contextShare(used, window) * 100) : 0;
  /* The catalog's display name, never the wire id; effort reads as the
     picker and the agent turn word it ("Extra high", not `xhigh`). */
  const modelRow = modelId
    ? [
        models?.find((m) => m.id === modelId)?.name ?? modelId,
        thread.effort ? effortLabel(thread.effort) : undefined,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  /* The current step is the first one not yet done — only one at a time. */
  const stepState = (s: string, i: number) =>
    s === "completed"
      ? ("done" as const)
      : s === "in_progress" || (s === "pending" && i === done)
        ? ("current" as const)
        : ("todo" as const);
  return (
    <ScrollArea className="h-full" data-wb-scroll="details">
      <div
        data-wb-details
        className="mx-auto w-full max-w-[560px] px-6 pt-4 pb-10 text-[13px]"
      >
        {lead && <Kv k="Agent">{lead.name}</Kv>}
        {modelRow && <Kv k="Model">{modelRow}</Kv>}
        {folder && (
          <Kv k="Folder">
            <span className={mono} dir="rtl" title={folder}>
              {prettyPath(folder)}
            </span>
          </Kv>
        )}
        {branch && (
          <Kv k="Branch">
            <span className={mono}>{branch}</span>
          </Kv>
        )}
        {startedAt && <Kv k="Started">{startedAt}</Kv>}
        {thread.usage && used > 0 && (
          <Kv k="Context">
            <span className="block h-1 w-[60px] overflow-hidden rounded-full bg-[var(--v3-line)]">
              <span
                className="block h-full rounded-full bg-foreground/85 transition-[width] duration-500"
                style={{ width: `${share}%` }}
              />
            </span>
            {share}%
          </Kv>
        )}

        {plan.length > 0 && (
          <section className="mt-6">
            <WbHead count={`${done} of ${plan.length}`}>Plan</WbHead>
            <ul className="space-y-2">
              {plan.map((p, i) => (
                <li
                  key={`${i}:${p.text}`}
                  className={cn(
                    "flex items-center gap-2",
                    stepState(p.status, i) === "todo" &&
                      "text-muted-foreground/70",
                  )}
                >
                  <PlanDot state={stepState(p.status, i)} />
                  {p.text}
                </li>
              ))}
            </ul>
          </section>
        )}

        {helpers.length > 0 && (
          <section className="mt-6">
            <WbHead count={String(helpers.length)}>Helpers</WbHead>
            {helpers.map(({ a }) => (
              <div
                key={a.id}
                className="flex min-h-[29px] items-center justify-between gap-3"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{a.name}</span>
                </span>
                <span className="text-[12.5px] text-muted-foreground/70">
                  {a.status === "running"
                    ? "Working"
                    : a.dur != null
                      ? `${a.dur}s`
                      : a.status}
                </span>
              </div>
            ))}
          </section>
        )}
      </div>
    </ScrollArea>
  );
}
