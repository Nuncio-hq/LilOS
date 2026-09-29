import { Terminal, TerminalContent } from "../components/ai-elements/terminal";
import { stripAnsi } from "../lib/helpers";
import type { Step } from "../types";
import { DiffView } from "../workbench/diff-view";

/* What an expanded tool step shows — the thing itself, not its raw JSON:
   an edit is its coloured diff, a command is a small terminal with its
   output, a read or search is the path/pattern and what came back. Any
   other tool lists its inputs as plain key/value lines. */

const LOOKED_AT: Record<string, string> = {
  read_file: "Read",
  search_files: "Searched for",
  web_search: "Searched the web for",
  view_image: "Looked at",
};

export function StepDetail({ s }: { s: Step }) {
  if (s.diff) return <DiffView d={s.diff} collapsible={false} />;

  const command = s.input.command;
  if (typeof command === "string")
    return (
      <Terminal
        output={`\u001b[36m$ ${command}\u001b[0m${s.output ? `\n${s.output}` : ""}`}
        isStreaming={!!s.running}
        className="rounded-xl border-0"
      >
        <TerminalContent className="max-h-64 p-3 text-[12px] leading-5" />
      </Terminal>
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
          <code className="min-w-0 truncate rounded-md bg-accent px-1.5 py-0.5 font-mono text-[12px]">
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
        <p className="whitespace-pre-wrap text-muted-foreground">
          {stripAnsi(s.output)}
        </p>
      )}
    </div>
  );
}
