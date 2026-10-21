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
    <div>
      <button
        type="button"
        disabled={!hasBody}
        onClick={() => setOpen(!open)}
        className="group/step flex min-h-[30px] w-full min-w-0 items-center gap-2.5 rounded-[7px] px-1.5 text-left text-[13.5px] transition-colors hover:bg-[var(--v3-hover)] disabled:hover:bg-transparent"
      >
        <span
          className={cn(
            "size-[7px] shrink-0 rounded-full",
            s.running ? "animate-pulse bg-work" : "bg-muted-foreground/40",
          )}
        />
        {s.running ? (
          <Shimmer as="span" duration={1} className="shrink-0 font-medium">
            {verb}
          </Shimmer>
        ) : (
          <span className="shrink-0 text-muted-foreground">{verb}</span>
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
                "size-3.5 text-muted-foreground/70 transition-transform",
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
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-[7px] bg-[var(--v3-soft)] px-3 py-2 font-mono text-[12px] text-muted-foreground leading-[1.7]">
              {stripAnsi(s.output)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
