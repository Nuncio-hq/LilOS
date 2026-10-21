import {
  CircleDashedIcon,
  FileDiffIcon,
  FolderTreeIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  GlobeIcon,
  InfoIcon,
  ListChecksIcon,
  type LucideIcon,
  MonitorPlayIcon,
  NetworkIcon,
  SquareTerminalIcon,
  TimerIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import type { PullRequest, Thread, WbTab } from "../types";
import { turnChangedFiles } from "../workbench/artifacts";

/* The thread's work strip: one quiet button per kind of work the thread
   has. It lives in the thread header and, once the header has scrolled away,
   in the sticky bar (thread-header.tsx) — never in both at once. */

export type HeaderTab = {
  id: WbTab;
  label: string;
  meta?: string;
  /** Stands in for the kind's own icon — the PR tab wears its state. */
  icon?: ReactNode;
};

const ICON: Record<WbTab, LucideIcon> = {
  browser: GlobeIcon,
  changes: FileDiffIcon,
  files: FolderTreeIcon,
  terminal: SquareTerminalIcon,
  preview: MonitorPlayIcon,
  pr: GitPullRequestIcon,
  background: TimerIcon,
  plan: ListChecksIcon,
  subagents: NetworkIcon,
  details: InfoIcon,
};

/* The PR as the one word and icon its state reads: merged, closed, checks
   running, draft, or ready. The strip's PR tab carries it — the header has
   no chip of its own, so the PR is named once. */
function prState(
  pr: PullRequest,
  pending: boolean,
): { word: string; icon: ReactNode } {
  const cls = "size-3.5";
  if (pr.status === "merged")
    return {
      word: "merged",
      icon: <GitMergeIcon className={cn(cls, "text-violet-600")} />,
    };
  if (pr.status === "closed")
    return {
      word: "closed",
      icon: <GitPullRequestIcon className={cn(cls, "text-zinc-500")} />,
    };
  if (pending)
    return {
      word: "checks",
      icon: (
        <CircleDashedIcon
          className={cn(cls, "animate-spin text-work [animation-duration:3s]")}
        />
      ),
    };
  return {
    word: pr.draft ? "draft" : "ready",
    icon: <GitPullRequestIcon className={cn(cls, "text-emerald-600")} />,
  };
}

/* The kinds of work this thread has, in the strip's order. Folder work
   (Changes, Files, Terminal, Preview) needs a folder; PR and Background
   appear once the session has one; the Browser only where the app can open
   pages (desktop); Details is always there. `prPending`: the PR's checks
   are still running. */
export function workTabs(
  thread: Pick<Thread, "replies" | "pr" | "jobs">,
  opts: { folder: boolean; browser: boolean; prPending?: boolean },
): HeaderTab[] {
  const tabs: HeaderTab[] = [];
  if (opts.folder) {
    const changed = new Set(
      thread.replies.flatMap((r) => [...turnChangedFiles(r)]),
    ).size;
    tabs.push(
      {
        id: "changes",
        label: "Changes",
        meta: changed ? String(changed) : undefined,
      },
      { id: "files", label: "Files" },
      { id: "terminal", label: "Terminal" },
      { id: "preview", label: "Preview" },
    );
  }
  if (thread.pr) {
    const { word, icon } = prState(thread.pr, !!opts.prPending);
    tabs.push({
      id: "pr",
      label: "PR",
      meta: `#${thread.pr.number} · ${word}`,
      icon,
    });
  }
  if (thread.jobs?.length)
    tabs.push({
      id: "background",
      label: "Background",
      meta: String(thread.jobs.length),
    });
  if (opts.browser) tabs.push({ id: "browser", label: "Browser" });
  tabs.push({ id: "details", label: "Details" });
  return tabs;
}

/** One quiet button per kind of work; any of them opens the session view on
    that tab. `compact` is the sticky bar's strip: one row that never wraps,
    labels stepping aside to icons (still the buttons' names, and their
    tooltips) until the bar is wide enough — the bar is the `bar` container. */
export function WorkStrip({
  tabs,
  onOpen,
  compact = false,
}: {
  tabs: HeaderTab[];
  onOpen: (tab: WbTab) => void;
  compact?: boolean;
}) {
  return (
    <nav
      aria-label="Thread work"
      data-work-strip
      className={cn(
        "flex items-center gap-x-0.5",
        compact
          ? "no-scrollbar min-w-0 shrink overflow-x-auto"
          : "mt-4 flex-wrap gap-y-1 border-[var(--v3-line)] border-b pb-3",
      )}
    >
      {tabs.map((t) => {
        const Icon = ICON[t.id];
        return (
          <button
            key={t.id}
            type="button"
            data-work-tab={t.id}
            title={`Open ${t.label} beside the chat`}
            onClick={() => onOpen(t.id)}
            className="inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground"
          >
            {t.icon ?? <Icon className="size-3.5" />}
            <span className={cn(compact && "sr-only @[38rem]/bar:not-sr-only")}>
              {t.label}
            </span>
            {t.meta && (
              <span
                className={cn(
                  "text-muted-foreground/70 tabular-nums",
                  compact && "sr-only @[38rem]/bar:not-sr-only",
                )}
              >
                {t.meta}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
