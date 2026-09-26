import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { Shimmer } from "../components/ai-elements/shimmer";
import { stripAnsi } from "../lib/helpers";
import { cn } from "../lib/utils";
import type { Step } from "../types";
import { DiffStat, DiffView } from "./diff-view";

const STEP_VERB: Record<string, string> = {
  terminal: "Ran",
  read_file: "Read",
  write_file: "Wrote",
  patch: "Edited",
  search_files: "Searched",
  web_search: "Searched web",
};

/* One tool call in the Focus transcript: verb + arg line, expandable to its diff or output. */
export function StepRow({ s }: { s: Step }) {
  const [open, setOpen] = useState(false);
  const arg = String(
    s.input.command ?? s.input.path ?? s.input.pattern ?? s.input.query ?? "",
  );
  const verb =
    s.diff?.status === "added" ? "Created" : (STEP_VERB[s.tool] ?? s.tool);
  const hasBody = !s.running && (!!s.diff || !!s.output);
  return (
    <div className="relative pl-4 before:absolute before:top-0 before:bottom-0 before:left-[5px] before:w-px before:bg-border last:before:bottom-1/2">
      <span
        className={cn(
          "absolute top-[11px] left-[2px] size-[7px] rounded-full",
          s.running ? "animate-pulse bg-amber-500" : "bg-emerald-500",
        )}
      />
      <button
        type="button"
        disabled={!hasBody}
        onClick={() => setOpen(!open)}
        className="group/step flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-muted/60 disabled:hover:bg-transparent"
      >
        {s.running ? (
          <Shimmer as="span" duration={1} className="shrink-0 font-medium">
            {verb}
          </Shimmer>
        ) : (
          <span className="shrink-0 font-medium text-foreground">{verb}</span>
        )}
        <code className="min-w-0 truncate font-mono text-[12.5px] text-foreground/70">
          {arg}
        </code>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[12px]">
          {s.diff && <DiffStat add={s.diff.add} del={s.diff.del} />}
          {s.commit && (
            <span className="text-muted-foreground">{s.commit.hash}</span>
          )}
          {hasBody && (
            <ChevronRightIcon
              className={cn(
                "size-3.5 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
          )}
        </span>
      </button>
      {open && hasBody && (
        <div className="mt-1 mb-2 ml-1.5">
          {s.diff ? (
            <DiffView d={s.diff} collapsible={false} />
          ) : (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-950 p-3 font-mono text-[12px] leading-5 text-zinc-100">
              {stripAnsi(s.output)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
