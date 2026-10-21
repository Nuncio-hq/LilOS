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
    that tab. Two places, two shapes:
    - `header` (default) sits on the header's facts line (the `line`
      container, thread-header.tsx): wide, the right of that line, labels
      stepping aside to icons (a count like Changes 2 stays beside its icon;
      the name is still the button's name and its tooltip); narrow, a row of
      its own below, labels back, wrapping if it must.
    - `bar` is the sticky bar's strip: one row that never wraps, labels
      stepping aside to icons until the bar is wide enough — the bar is the
      `bar` container. */
export function WorkStrip({
  tabs,
  onOpen,
  placement = "header",
}: {
  tabs: HeaderTab[];
  onOpen: (tab: WbTab) => void;
  placement?: "header" | "bar";
}) {
  const bar = placement === "bar";
  return (
    <nav
      aria-label="Thread work"
      data-work-strip
      className={cn(
        "flex items-center gap-x-0.5",
        bar
          ? "no-scrollbar min-w-0 shrink overflow-x-auto"
          : "-ml-2 order-last w-full flex-wrap gap-y-1 @[30rem]/line:order-none @[30rem]/line:ml-0 @[30rem]/line:w-auto @[30rem]/line:shrink-0 @[30rem]/line:flex-nowrap @[30rem]/line:gap-x-0",
      )}
    >
      {tabs.map((t) => {
        const Icon = ICON[t.id];
        /* A bare number is a count and stays by the icon in the header;
           "#12 · merged" is a label and steps aside with the name. */
        const count = !bar && !!t.meta && /^\d+$/.test(t.meta);
        const quiet = bar
          ? "sr-only @[38rem]/bar:not-sr-only"
          : "@[30rem]/line:sr-only";
        return (
          <button
            key={t.id}
            type="button"
            data-work-tab={t.id}
            title={`Open ${t.label} beside the chat`}
            onClick={() => onOpen(t.id)}
            className={cn(
              "inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground",
              !bar && "@[30rem]/line:gap-1 @[30rem]/line:px-1",
            )}
          >
            {t.icon ?? <Icon className="size-3.5" />}
            <span className={quiet}>{t.label}</span>
            {t.meta && (
              <span
                className={cn(
                  "text-muted-foreground/70 tabular-nums",
                  !count && quiet,
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
