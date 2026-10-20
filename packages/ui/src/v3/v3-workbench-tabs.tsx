import {
  CircleCheckIcon,
  CircleXIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  RotateCwIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { INK, Spinner, StatusPill } from "./v3-bits";
import type { V3Data, V3Status, V3Workbench } from "./v3-types";
import {
  CARD,
  Panel,
  Quiet,
  WbBtn,
  type WbPanelProps,
} from "./v3-workbench-bits";

/* Preview, PR and Background: the Workbench tabs that exist only once the
   agent has started a dev server, opened a pull request or left a command
   running. */

/** Opens a page in this session's browser and shows it. */
function openInBrowser({ act, thread, onTab }: WbPanelProps, url: string) {
  act.browserOpen(url, thread.id);
  onTab("browser");
}

export function PreviewTab(p: WbPanelProps) {
  const { preview } = p.wb;
  // Reload remounts the page, so it visibly paints again.
  const [loads, setLoads] = useState(0);
  if (!preview)
    return (
      <Panel>
        <Quiet>The agent has not started a dev server.</Quiet>
      </Panel>
    );
  return (
    <Panel>
      <div className={cn(CARD, "overflow-hidden")}>
        <div className="flex items-center gap-2 border-[var(--v3-line)] border-b px-2.5 py-2">
          <button
            type="button"
            title="Reload"
            aria-label="Reload"
            onClick={() => setLoads((n) => n + 1)}
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground"
          >
            <RotateCwIcon className="size-3.5" />
          </button>
          <span
            title={preview.url}
            className="min-w-0 flex-1 truncate rounded-md bg-[var(--v3-soft)] px-2.5 py-1 font-mono text-[12px] text-muted-foreground"
          >
            {preview.url}
          </span>
          <WbBtn onClick={() => openInBrowser(p, preview.url)}>
            <ExternalLinkIcon className="size-3.5" />
            Open in browser
          </WbBtn>
        </div>
        <div
          key={loads}
          className="lilos-v3-line-in grid h-[320px] place-items-center bg-background px-6 text-center"
        >
          <div>
            <div className="font-medium text-[15px] text-foreground">
              {preview.title}
            </div>
            <div className="mt-1 text-[12.5px] text-muted-foreground/70">
              Served from {p.thread.folder}
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}

const PR_STATE: Record<
  NonNullable<V3Workbench["pr"]>["state"],
  { status: V3Status; label: string }
> = {
  draft: { status: "planned", label: "Draft" },
  open: { status: "working", label: "Open" },
  merged: { status: "done", label: "Merged" },
};

/** The pull request's address: from the agent's own output when it printed
   one (here or in a sibling thread on the same branch), else GitHub's list. */
function prUrl(data: V3Data, wb: V3Workbench, num: number): string {
  const re = new RegExp(`https?://\\S+/pull/${num}\\b`);
  const lines = [wb, ...data.threads.map((t) => t.workbench)].flatMap((w) =>
    (w?.terminal ?? []).flatMap((b) => b.lines),
  );
  for (const l of lines) {
    const hit = re.exec(l);
    if (hit) return hit[0];
  }
  return "https://github.com/pulls";
}

export function PrTab(p: WbPanelProps) {
  const { pr } = p.wb;
  if (!pr)
    return (
      <Panel>
        <Quiet>No pull request yet.</Quiet>
      </Panel>
    );
  const state = PR_STATE[pr.state];
  const checks =
    pr.checks === "running" ? (
      <>
        <Spinner />
        Checks running
      </>
    ) : pr.checks === "passing" ? (
      <>
        <CircleCheckIcon className={cn("size-4", INK.done)} />
        All checks passing
      </>
    ) : (
      <>
        <CircleXIcon className={cn("size-4", INK.failed)} />
        Checks failing
      </>
    );
  return (
    <Panel>
      <div className={cn(CARD, "px-4 py-3.5")}>
        <div className="flex items-start gap-2.5">
          <GitPullRequestIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] text-foreground leading-snug">
              <span className="font-medium">{pr.title}</span>{" "}
              <span className="text-muted-foreground/70">#{pr.num}</span>
            </div>
            {p.thread.branch && (
              <div className="mt-1 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                <GitBranchIcon className="size-3.5 shrink-0" />
                <span className="truncate font-mono text-[12px]">
                  {p.thread.branch}
                </span>
              </div>
            )}
          </div>
          <StatusPill status={state.status} label={state.label} />
        </div>
        <div className="mt-3.5 flex items-center gap-1.5 text-[13.5px] text-foreground">
          {checks}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <WbBtn
            primary={pr.checks !== "failing"}
            onClick={() => openInBrowser(p, prUrl(p.data, p.wb, pr.num))}
          >
            <ExternalLinkIcon className="size-3.5" />
            Open in Browser
          </WbBtn>
          {pr.checks === "failing" && (
            <WbBtn
              primary
              onClick={() =>
                p.act.message(
                  p.thread.id,
                  `Fix the failing checks on PR #${pr.num}`,
                )
              }
            >
              Ask the agent to fix
            </WbBtn>
          )}
          <WbBtn onClick={() => p.onTab("changes")}>View changes</WbBtn>
        </div>
      </div>
    </Panel>
  );
}

const JOB: Record<
  V3Workbench["jobs"][number]["state"],
  { status: V3Status; label: string }
> = {
  running: { status: "working", label: "Running" },
  done: { status: "done", label: "Done" },
  failed: { status: "failed", label: "Failed" },
};

export function BackgroundTab({ thread, wb, act }: WbPanelProps) {
  // Stop goes to the agent; the button settles so it is not sent twice.
  const [stopping, setStopping] = useState<string[]>([]);
  if (wb.jobs.length === 0)
    return (
      <Panel>
        <Quiet>Nothing is running in the background.</Quiet>
      </Panel>
    );
  return (
    <Panel>
      <div className={cn(CARD, "divide-y divide-[var(--v3-line)]")}>
        {wb.jobs.map((j) => {
          const s = JOB[j.state];
          const asked = stopping.includes(j.cmd);
          return (
            <div key={j.cmd} className="flex items-start gap-3 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <div className="break-all font-mono text-[12.5px] text-foreground">
                  {j.cmd}
                </div>
                {j.tail && (
                  <div className="mt-1 truncate font-mono text-[12px] text-muted-foreground">
                    {j.tail}
                  </div>
                )}
              </div>
              <StatusPill status={s.status} label={s.label} />
              {j.state === "running" && (
                <WbBtn
                  disabled={asked}
                  onClick={() => {
                    act.message(thread.id, `Stop ${j.cmd}`);
                    setStopping((l) => [...l, j.cmd]);
                  }}
                >
                  {asked ? "Stopping…" : "Stop"}
                </WbBtn>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
