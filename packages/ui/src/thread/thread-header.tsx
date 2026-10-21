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
  PlayIcon,
  SquareTerminalIcon,
  TimerIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type { PullRequest, Thread, WbTab } from "../types";
import { StatusPill } from "../v3/v3-marks";
import type { V3Status } from "../v3/v3-types";
import { turnChangedFiles } from "../workbench/artifacts";

/* The head of a conversation — shared by the panel (ThreadView, beside the
   list) and the session view (FocusView), drawn once so the two can't drift:
   kicker line, serif title, status line, and in the panel the work strip.
   It is the first child of the conversation's scroller, so it scrolls away
   with the thread instead of holding a bar over it. */

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

/** Under the header while the chat sits beside the list: one quiet button
    per kind of work; any of them opens the session view on that tab. */
export function WorkStrip({
  tabs,
  onOpen,
}: {
  tabs: HeaderTab[];
  onOpen: (tab: WbTab) => void;
}) {
  return (
    <nav
      aria-label="Thread work"
      data-work-strip
      className="mt-4 flex flex-wrap items-center gap-x-0.5 gap-y-1 border-[var(--v3-line)] border-b pb-3"
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
            className="inline-flex h-[26px] items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground"
          >
            {t.icon ?? <Icon className="size-3.5" />}
            {t.label}
            {t.meta && (
              <span className="text-muted-foreground/70 tabular-nums">
                {t.meta}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/** How many messages the person has sent — root included; system notes and
    the agent's own turns don't count. */
export function sentTurns(
  rootFrom: string,
  thread: Thread,
  human: (id: string) => unknown,
): number {
  return (
    (human(rootFrom) ? 1 : 0) +
    thread.replies.filter((r) => !r.system && human(r.from)).length
  );
}

/** Start work — one entry point for both frames (issue #15): while the
    request card in the conversation is open the button yields to it,
    disabled + a tooltip. The title lives on the wrapper because a disabled
    button ignores pointer events and would swallow the hover. */
export function StartWork({
  onStart,
  yields,
}: {
  onStart: () => void;
  yields: boolean;
}) {
  return (
    <span
      className="ml-1 inline-flex shrink-0"
      title={
        yields
          ? "Answer the request below"
          : "New ticket + worktree for this thread"
      }
    >
      <Button
        size="sm"
        onClick={onStart}
        disabled={yields}
        data-startwork-header
      >
        <PlayIcon />
        Start work
      </Button>
    </span>
  );
}

export function ThreadHeader({
  session,
  title,
  titleInput,
  kicker,
  status,
  started,
  turns,
  note,
  aside,
  strip,
}: {
  /** The session view's narrower column: the title is 24px, not 30px. */
  session: boolean;
  title: string;
  /** Replaces the title while it is being renamed. */
  titleInput?: ReactNode;
  kicker?: ReactNode;
  status?: V3Status;
  /** When the thread began ("11:02"); empty = not known. */
  started?: string;
  turns?: number;
  /** A live note after the facts ("1 running in background"). */
  note?: ReactNode;
  /** The right of the status line: the context meter, Start work, ⋯. */
  aside?: ReactNode;
  strip?: ReactNode;
}) {
  return (
    <header data-thread-header className="pt-7">
      {kicker && (
        <div
          className={cn(
            "text-muted-foreground",
            session ? "mb-1.5 text-[13px]" : "mb-2 text-[13.5px]",
          )}
        >
          {kicker}
        </div>
      )}
      {titleInput ? (
        <div className={cn("flex", session ? "mb-3" : "mb-3.5")}>
          {titleInput}
        </div>
      ) : (
        <h1
          data-session-title
          title={title}
          className={cn(
            "lilos-v3-serif break-words font-bold text-foreground leading-[1.15]",
            session ? "mb-3 text-[24px] leading-[1.2]" : "mb-3.5 text-[30px]",
          )}
        >
          {title}
        </h1>
      )}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[13.5px] text-muted-foreground">
        {status && (
          <StatusPill
            status={status}
            label={status === "done" ? "Finished" : undefined}
          />
        )}
        <span>
          {started ? `Started ${started}` : null}
          {turns
            ? `${started ? " · " : ""}${turns} ${turns === 1 ? "turn" : "turns"}`
            : null}
          {note}
        </span>
        {aside && (
          <span className="ml-auto flex items-center gap-1">{aside}</span>
        )}
      </div>
      {strip}
    </header>
  );
}
