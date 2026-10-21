import { stripAnsi } from "../lib/helpers";
import type { Step } from "../types";
import { DiffView } from "../workbench/diff-view";

/* What an expanded step shows — the thing itself, not its raw JSON:
   an edit is its coloured diff, a command is its line and output in a quiet
   mono box, a read or search is the path/pattern and what came back. Any
   other tool lists its inputs as plain key/value lines. Output boxes are
   height-bounded with their own scroll (#305) and wrap long unbroken tokens
   instead of spilling out of the column. */

const LOOKED_AT: Record<string, string> = {
  read_file: "Read",
  search_files: "Searched for",
  web_search: "Searched the web for",
  view_image: "Looked at",
};

const OUTPUT =
  "max-h-64 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-all rounded-[7px] bg-[var(--v3-soft)] px-3 py-2 font-mono text-[12px] text-muted-foreground leading-[1.7]";

export function StepDetail({ s }: { s: Step }) {
  if (s.diff) return <DiffView d={s.diff} collapsible={false} />;

  const command = s.input.command;
  if (typeof command === "string")
    return (
      <div className={OUTPUT}>
        <div className="text-foreground">$ {command}</div>
        {s.output && stripAnsi(s.output)}
      </div>
    );

  const subject = s.input.path ?? s.input.pattern ?? s.input.query;
  const rest = Object.entries(s.input).filter(
    ([k]) => !["path", "pattern", "query"].includes(k),
  );
  return (
    <div className="space-y-1.5 text-[12.5px]">
      {subject !== undefined && (
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-muted-foreground">
            {LOOKED_AT[s.tool] ?? "On"}
          </span>
          <code className="min-w-0 truncate rounded-[5px] bg-[var(--v3-soft)] px-1.5 py-0.5 font-mono text-[12px]">
            {String(subject)}
          </code>
        </div>
      )}
      {rest.map(([k, v]) => (
        <div key={k} className="flex min-w-0 gap-2">
          <span className="shrink-0 text-muted-foreground">{k}</span>
          <span className="min-w-0 truncate font-mono text-[12px]">
            {typeof v === "string" ? v : JSON.stringify(v)}
          </span>
        </div>
      ))}
      {s.output && (
        <div className="max-h-64 overflow-y-auto">
          <p className="wrap-anywhere whitespace-pre-wrap text-muted-foreground">
            {stripAnsi(s.output)}
          </p>
        </div>
      )}
    </div>
  );
}
