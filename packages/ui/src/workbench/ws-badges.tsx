import {
  ChevronDownIcon,
  EyeIcon,
  FolderIcon,
  GitBranchIcon,
  PencilLineIcon,
} from "lucide-react";
import type { OsApp, OsEditor, Work, Workspace } from "../types";
import { OpenPathMenu } from "./open-path";

/* The props a surface needs to offer open/reveal for one path (issue #110). */
export type OpenMenuFor = {
  editors: OsEditor[];
  onOpen: (app: OsApp) => void;
};

function WsBadgeContent({ ws }: { ws: Workspace }) {
  const f = { project: ws.project };
  return (
    <>
      <FolderIcon className="size-3 shrink-0" />
      <span className="shrink-0">{f?.project}</span>
      {ws.branch && (
        <>
          {ws.mode === "direct" ? (
            <PencilLineIcon className="size-3 shrink-0" />
          ) : (
            <GitBranchIcon className="size-3 shrink-0" />
          )}
          <span className="truncate font-mono">{ws.branch}</span>
        </>
      )}
      <span className="shrink-0 text-emerald-700/80">
        · {ws.mode === "direct" ? "direct" : "worktree"}
      </span>
    </>
  );
}

const badgeClass =
  "mt-1 flex w-fit max-w-full items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-800 text-xs";

/* Workspace pill in the thread header: which folder/branch this session runs in.
   With `openMenu` (host os.open) the badge is also the Open-in-editor /
   Reveal-in-Finder menu for the folder itself; without it, a plain label. */
export function WsBadge({
  ws,
  openMenu,
}: {
  ws: Workspace;
  openMenu?: OpenMenuFor;
}) {
  if (openMenu)
    return (
      <OpenPathMenu
        editors={openMenu.editors}
        onOpen={openMenu.onOpen}
        trigger={
          <button
            type="button"
            className={`${badgeClass} cursor-pointer hover:bg-emerald-100`}
            aria-label={`${ws.cwd} — open in an editor or reveal in Finder`}
            data-wsbadge
          />
        }
      >
        <WsBadgeContent ws={ws} />
        <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
      </OpenPathMenu>
    );
  return (
    <div className={badgeClass} title={ws.cwd} data-wsbadge>
      <WsBadgeContent ws={ws} />
    </div>
  );
}

export function WorkspaceBadge({
  work,
  repo,
}: {
  work: Work | null;
  repo?: string;
}) {
  if (work?.branch)
    return (
      <div className="mt-1 flex w-fit max-w-full items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-800 text-xs">
        <GitBranchIcon className="size-3 shrink-0" />
        <span className="truncate font-mono">{work.branch}</span>
        <span className="shrink-0">· can edit</span>
      </div>
    );
  if (work)
    return (
      <div className="mt-1 w-fit rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
        ticket · no repo
      </div>
    );
  return (
    <div className="mt-1 flex w-fit items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
      <EyeIcon className="size-3" />
      {repo ? (
        <span className="font-mono">main · read-only</span>
      ) : (
        "discussion"
      )}
    </div>
  );
}
