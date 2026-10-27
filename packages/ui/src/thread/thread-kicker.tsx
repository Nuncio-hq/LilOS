import { EyeIcon, FolderIcon, GitBranchIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Thread, Work } from "../types";
import {
  type OpenMenuFor,
  WorkspaceBadge,
  WsBadge,
} from "../workbench/ws-badges";

/* The header's kicker line: where the thread works — `Thread · #channel` for
   a channel thread, then the folder/branch. Who it is with and what it is
   filed under (its ticket, its project, or "Chat" for a plain chat) are the
   side peek's breadcrumb right above ("Builder · LIL-81", "Default · LilOS",
   "Default · Chat"), so the line never says them again, not even the
   project's name (D-#771). No channel and no folder: no line at all. The
   folder part is the same quiet badge the panel and the session view always
   had (it keeps the open-in-editor menu); only the surrounding chrome is
   gone. */

export function threadKicker({
  channel,
  folder,
  title,
}: {
  /** A thread in a channel (not a one-to-one chat) names it — "#engineering". */
  channel?: string;
  /** The folder/branch part, already drawn; absent = none to show. */
  folder?: ReactNode;
  /** The hover text: where the next edit lands (`idleHint`), then the
      thread's own number. */
  title?: string;
}): ReactNode {
  if (!channel && !folder) return undefined;
  return (
    <span title={title} data-thread-kicker>
      {channel && `Thread · ${channel}`}
      {channel && folder && " · "}
      {folder}
    </span>
  );
}

/** The panel's folder part: the session's folder badge; a folder-less thread
    (a plain chat) gets the quiet "Add a folder" link instead (#581 AC-2 —
    picking one moves the thread there, and the relay files it under that
    folder's project; none at all when the host can't move). */
export function panelFolder({
  thread,
  work,
  repo,
  isDM,
  onAddFolder,
  openMenu,
  onAddAsProject,
}: {
  thread: Thread;
  work: Work | null;
  repo?: string;
  isDM: boolean;
  onAddFolder?: () => void;
  openMenu?: OpenMenuFor;
  /** The folder is no project's: the badge's menu offers "Add as project"
     (#854). Absent (or the folder already is one): no such row. */
  onAddAsProject?: () => void;
}): ReactNode {
  if (thread.ws)
    return (
      <WsBadge
        ws={thread.ws}
        openMenu={openMenu}
        onAddAsProject={onAddAsProject}
      />
    );
  /* A folder-less thread is a plain chat — no folder label at all (#196). */
  if (isDM && !work && !repo)
    return onAddFolder ? <AddFolder onClick={onAddFolder} /> : null;
  return <WorkspaceBadge work={work} repo={repo} />;
}

export function AddFolder({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-add-folder
      className="underline decoration-dotted underline-offset-2 hover:text-foreground"
    >
      Add a folder
    </button>
  );
}

/** The session view's folder part — same badge, with its own wording where
    there is no workspace record (a branch only, a folder that isn't a git
    checkout, or a channel thread that can only read). */
export function focusFolder({
  thread,
  work,
  isDM,
  openMenu,
  onAddAsProject,
}: {
  thread: Thread;
  work: Work | null;
  isDM: boolean;
  openMenu?: OpenMenuFor;
  /** Same "Add as project" row the panel's badge offers (#854). */
  onAddAsProject?: () => void;
}): ReactNode {
  if (thread.ws)
    return (
      <WsBadge
        ws={thread.ws}
        openMenu={openMenu}
        onAddAsProject={onAddAsProject}
      />
    );
  if (work?.branch)
    return (
      <span className="inline-flex items-center gap-1">
        <GitBranchIcon className="size-3" />
        <span className="font-mono">{work.branch}</span>
      </span>
    );
  if (work)
    return (
      <span className="inline-flex items-center gap-1">
        <FolderIcon className="size-3" />
        no git repo
      </span>
    );
  /* A folder-less thread is a plain chat — no repo exists to be read-only
     on, so no label at all (#196). */
  if (isDM) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <EyeIcon className="size-3" />
      read-only
    </span>
  );
}
