import {
  FileDiffIcon,
  FolderTreeIcon,
  GitPullRequestIcon,
  GlobeIcon,
  InfoIcon,
  type LucideIcon,
  MonitorPlayIcon,
  PanelRightCloseIcon,
  SquareTerminalIcon,
  TimerIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import { agentOf, projectOf } from "./v3-model";
import { SessionBrowser } from "./v3-session-browser";
import { ThreadDetails } from "./v3-thread-rail";
import type { V3Data, V3PageProps, V3Thread } from "./v3-types";
import { WorkbenchTab } from "./v3-workbench";
import type { SessionTab } from "./v3-workbench-bits";

/* A thread's work, beside its chat. Two faces of the same list: the quiet
   strip under the header (the chat beside the list) opens the session; the
   work panel (the session) shows the picked tab on the right. */

const ICON: Record<SessionTab, LucideIcon> = {
  browser: GlobeIcon,
  changes: FileDiffIcon,
  files: FolderTreeIcon,
  terminal: SquareTerminalIcon,
  preview: MonitorPlayIcon,
  pr: GitPullRequestIcon,
  background: TimerIcon,
  details: InfoIcon,
};

export type WorkTab = {
  id: SessionTab;
  label: string;
  /** A count or a number that sits quietly after the label. */
  meta?: string;
};

/** The tabs this thread's work has, in order. Browser and Details are always
   there; Preview, PR and Background appear once the agent has something in
   them. */
export function workTabs(data: V3Data, t: V3Thread): WorkTab[] {
  const wb = t.workbench;
  const open = data.browser.tabs.filter((b) => b.threadId === t.id).length;
  const tabs: WorkTab[] = [
    { id: "browser", label: "Browser", meta: open ? String(open) : undefined },
  ];
  if (wb) {
    tabs.push(
      {
        id: "changes",
        label: "Changes",
        meta: wb.diffs.length ? String(wb.diffs.length) : undefined,
      },
      { id: "files", label: "Files" },
      { id: "terminal", label: "Terminal" },
    );
    if (wb.preview) tabs.push({ id: "preview", label: "Preview" });
    if (wb.pr) tabs.push({ id: "pr", label: "PR", meta: `#${wb.pr.num}` });
    if (wb.jobs.length)
      tabs.push({
        id: "background",
        label: "Background",
        meta: String(wb.jobs.length),
      });
  }
  tabs.push({ id: "details", label: "Details" });
  return tabs;
}

/** Under the thread's header while the chat sits beside the list: one small
   button per kind of work; any of them opens the session on that tab. */
export function WorkStrip({
  tabs,
  onOpen,
}: {
  tabs: WorkTab[];
  onOpen: (tab: SessionTab) => void;
}) {
  return (
    <nav
      aria-label="Session work"
      className="mt-4 flex flex-wrap items-center gap-x-0.5 gap-y-1 border-[var(--v3-line)] border-b pb-3"
    >
      {tabs.map((t) => {
        const Icon = ICON[t.id];
        return (
          <button
            key={t.id}
            type="button"
            title={`Open ${t.label} beside the chat`}
            onClick={() => onOpen(t.id)}
            className="inline-flex h-[26px] items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground"
          >
            <Icon className="size-3.5" />
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

/** The session's right side: the tab row, the picked tab, and the way back to
   the list. The browser stays mounted while another tab is on show, so its
   tabs and place are where you left them. */
export function WorkPanel({
  data,
  go,
  act,
  thread,
  tabs,
  tab,
  onTab,
  onAsk,
  onClose,
}: V3PageProps & {
  thread: V3Thread;
  tabs: WorkTab[];
  tab: SessionTab;
  onTab: (tab: SessionTab) => void;
  /** Focus the chat's composer. */
  onAsk: () => void;
  /** Back to the list: the chat narrows to its width beside it. */
  onClose: () => void;
}) {
  return (
    <section
      aria-label="Work"
      className="@container flex min-w-0 flex-1 flex-col"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-[var(--v3-line)] border-b pr-2 pl-2">
        <div
          role="tablist"
          aria-label="Work"
          className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          {tabs.map((t) => {
            const Icon = ICON[t.id];
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onTab(t.id)}
                className={cn(
                  "relative flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[13px] transition-colors",
                  active
                    ? "font-medium text-foreground after:absolute after:right-2.5 after:-bottom-[7px] after:left-2.5 after:h-0.5 after:rounded-full after:bg-foreground"
                    : "text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {/* Narrow panels keep every tab in view: the others fold to
                    their icon (and count); the open one keeps its name. */}
                <span className={cn(!active && "@max-[760px]:sr-only")}>
                  {t.label}
                </span>
                {t.meta && (
                  <span className="font-normal text-muted-foreground/70 tabular-nums">
                    {t.meta}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          aria-label="Close work"
          title="Close work"
          onClick={onClose}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground [&_svg]:size-4"
        >
          <PanelRightCloseIcon />
        </button>
      </div>

      <div className={cn("min-h-0 flex-1", tab !== "browser" && "hidden")}>
        <SessionBrowser data={data} go={go} act={act} thread={thread} />
      </div>
      {tab !== "browser" && (
        // A new key per tab: each opens at its top.
        <div key={tab} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {tab === "details" ? (
            <ThreadDetails
              data={data}
              t={thread}
              agent={agentOf(data, thread.agentId)}
              project={
                thread.projectId ? projectOf(data, thread.projectId) : undefined
              }
              go={go}
            />
          ) : (
            <WorkbenchTab
              thread={thread}
              tab={tab}
              data={data}
              go={go}
              act={act}
              onTab={onTab}
              onAsk={onAsk}
            />
          )}
        </div>
      )}
    </section>
  );
}
