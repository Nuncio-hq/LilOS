import { ChevronRightIcon, ExternalLinkIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import {
  Terminal,
  TerminalActions,
  TerminalContent,
  TerminalCopyButton,
} from "../components/ai-elements/terminal";
import { ScrollArea } from "../components/ui/scroll-area";
import { cn } from "../lib/utils";
import type { BackgroundJob } from "../types";
import { CARD, WbBtn, WbEmpty, WbHead } from "./wb-bits";

/* Workbench → Background (issue #170): the processes the agent left running for this
   session — dev servers, watchers, builds. Each row: status, command, since when / how long,
   its URL when it serves one; open it for the output tail. Stop renders only when the app
   passes onStop (D-#19). */

const DOT: Record<BackgroundJob["status"], string> = {
  running: "animate-pulse bg-emerald-500",
  exited: "bg-zinc-400",
  failed: "bg-red-500",
  stopped: "bg-zinc-400",
};
const LABEL: Record<BackgroundJob["status"], string> = {
  running: "running",
  exited: "exited",
  failed: "failed",
  stopped: "stopped by you",
};
/* Colour is for status only: running emerald, failed red, the rest muted. */
const TONE: Record<BackgroundJob["status"], string> = {
  running: "text-emerald-600 dark:text-emerald-400",
  exited: "text-muted-foreground",
  failed: "text-red-600 dark:text-red-400",
  stopped: "text-muted-foreground",
};

function JobRow({
  j,
  onStop,
}: {
  j: BackgroundJob;
  onStop?: (id: string) => void;
}) {
  const [open, setOpen] = useState(j.status === "failed");
  const running = j.status === "running";
  return (
    <div data-job={j.id} data-status={j.status}>
      <div className="flex items-start gap-3 px-3.5 py-3">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
        >
          <span
            className={cn(
              "mt-[7px] size-2 shrink-0 rounded-full",
              DOT[j.status],
            )}
          />
          <span className="min-w-0 flex-1">
            <code className="block break-all font-mono text-[12.5px] text-foreground">
              {j.command}
            </code>
            <span className="mt-1 block truncate font-mono text-[12px] text-muted-foreground">
              <span className={TONE[j.status]}>
                {LABEL[j.status]}
                {j.exitCode !== undefined && ` (exit ${j.exitCode})`}
              </span>
              {" · "}
              {running ? `up ${j.uptime}` : `ran ${j.uptime}`}
              {" · since "}
              {j.started}
              {j.by && ` · ${j.by}`}
            </span>
          </span>
          <ChevronRightIcon
            className={cn(
              "mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        </button>
        {j.url && running && (
          <a
            href={j.url}
            target="_blank"
            rel="noreferrer"
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[12px] text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground"
          >
            {j.url.replace(/^https?:\/\//, "")}
            <ExternalLinkIcon className="size-3" />
          </a>
        )}
        {running && onStop && (
          <WbBtn onClick={() => onStop(j.id)}>
            <SquareIcon className="size-3 fill-current" />
            Stop
          </WbBtn>
        )}
      </div>
      {open && (
        <Terminal
          output={j.log || "\u001b[90mNo output yet.\u001b[0m"}
          isStreaming={running}
          className="rounded-none border-0 border-t border-t-[var(--v3-line)]"
        >
          <div className="relative">
            <TerminalActions className="absolute top-1.5 right-1.5 z-10">
              <TerminalCopyButton />
            </TerminalActions>
            <TerminalContent className="max-h-56 text-[12px]" />
          </div>
        </Terminal>
      )}
    </div>
  );
}

export function BackgroundPanel({
  jobs,
  onStop,
}: {
  jobs: BackgroundJob[];
  onStop?: (id: string) => void;
}) {
  if (!jobs.length)
    return (
      <WbEmpty>Nothing running in the background for this thread.</WbEmpty>
    );
  const running = jobs.filter((j) => j.status === "running");
  const ended = jobs.filter((j) => j.status !== "running");
  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 px-5 pt-5 pb-8" data-background>
        {[
          { label: "Running", rows: running },
          { label: "Finished", rows: ended },
        ].map(
          (g) =>
            g.rows.length > 0 && (
              <section key={g.label}>
                <WbHead count={String(g.rows.length)}>{g.label}</WbHead>
                <div
                  className={cn(
                    CARD,
                    "divide-y divide-[var(--v3-line)] overflow-hidden",
                  )}
                >
                  {g.rows.map((j) => (
                    <JobRow key={j.id} j={j} onStop={onStop} />
                  ))}
                </div>
              </section>
            ),
        )}
      </div>
    </ScrollArea>
  );
}
