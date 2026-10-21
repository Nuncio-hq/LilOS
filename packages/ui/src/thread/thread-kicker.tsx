import { EyeIcon, FolderIcon, GitBranchIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Thread, Work } from "../types";
import {
  type OpenMenuFor,
  WorkspaceBadge,
  WsBadge,
} from "../workbench/ws-badges";

/* The header's kicker line: `Chat · {agent} · {folder}`, or
   `Thread · {agent} on {ticket}` for a ticketed thread. The folder part is
   the same quiet badge the panel and the session view always had (it keeps
   the open-in-editor menu); only the surrounding chrome is gone. */

export function Kicker({
  agent,
  ticket,
  channel,
  folder,
  title,
}: {
  agent?: string;
  ticket?: string;
  /** A thread in a channel (not a one-to-one chat) names it — "#engineering". */
  channel?: string;
  /** The folder/branch part, already drawn; absent = none to show. */
  folder?: ReactNode;
  title?: string;
}) {
  return (
    <span title={title}>
      {ticket || channel ? "Thread" : "Chat"}
      {channel && ` · ${channel}`}
      {agent && ` · ${agent}`}
      {ticket && (
        <>
          {" on "}
          <span className="font-mono">{ticket}</span>
        </>
      )}
      {folder && <> · {folder}</>}
    </span>
  );
}

/** The panel's folder part: the session's folder badge; a folder-less DM
    gets the quiet "Add a folder" link instead (#581 AC-2 — picking one moves
    the session there; none at all when the host can't move). */
export function panelFolder({
  thread,
  work,
  repo,
  isDM,
  onAddFolder,
  openMenu,
}: {
  thread: Thread;
  work: Work | null;
  repo?: string;
  isDM: boolean;
  onAddFolder?: () => void;
  openMenu?: OpenMenuFor;
}): ReactNode {
  if (thread.ws) return <WsBadge ws={thread.ws} openMenu={openMenu} />;
  /* A folder-less DM session is a plain chat — no folder label at all
     (#196). */
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
}: {
  thread: Thread;
  work: Work | null;
  isDM: boolean;
  openMenu?: OpenMenuFor;
}): ReactNode {
  if (thread.ws) return <WsBadge ws={thread.ws} openMenu={openMenu} />;
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
  /* A folder-less DM session is a plain chat — no repo exists to be
     read-only on, so no label at all (#196). */
  if (isDM) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <EyeIcon className="size-3" />
      read-only
    </span>
  );
}
