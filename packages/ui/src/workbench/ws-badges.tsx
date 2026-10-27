import {
  ChevronDownIcon,
  EyeIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  PencilLineIcon,
} from "lucide-react";
import { DropdownMenuItem } from "../components/ui/dropdown-menu";
import type { OsApp, OsEditor, Work, Workspace } from "../types";
import { OpenPathMenu } from "./open-path";

/* The props a surface needs to offer open/reveal for one path (issue #110). */
export type OpenMenuFor = {
  editors: OsEditor[];
  onOpen: (app: OsApp) => void;
};

/* The badge says where inside the folder the session works (branch, mode),
   not the folder's name: a thread's project is the peek's trail right above
   (D-#771, D-#769: one place for it), and the full path is the tooltip. */
function WsBadgeContent({ ws }: { ws: Workspace }) {
  return (
    <>
      <FolderIcon className="size-3 shrink-0" />
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
      <span className="shrink-0 opacity-70">
        {ws.branch && "· "}
        {ws.mode === "direct" ? "direct" : "worktree"}
      </span>
    </>
  );
}

/* Quiet, inline: the badge sits in the thread header's kicker line, so it
   reads as text (folder · branch), not a coloured chip — colour is for status. */
const badgeClass =
  "inline-flex min-w-0 max-w-full items-center gap-1 align-bottom text-muted-foreground";

/* Workspace pill in the thread header: which folder/branch this session runs in.
   With `openMenu` (host os.open) the badge is also the Open-in-editor /
   Reveal-in-Finder menu for the folder itself; `onAddAsProject` adds the
   one-click "Add as project" a folder that is no project offers (#854);
   with neither, a plain label. */
export function WsBadge({
  ws,
  openMenu,
  onAddAsProject,
}: {
  ws: Workspace;
  openMenu?: OpenMenuFor;
  onAddAsProject?: () => void;
}) {
  if (openMenu || onAddAsProject)
    return (
      <OpenPathMenu
        editors={openMenu?.editors ?? []}
        onOpen={openMenu?.onOpen}
        extra={
          onAddAsProject && (
            <DropdownMenuItem onClick={onAddAsProject} data-add-as-project>
              <FolderPlusIcon />
              Add as project
            </DropdownMenuItem>
          )
        }
        trigger={
          <button
            type="button"
            className={`${badgeClass} cursor-pointer hover:text-foreground`}
            aria-label={
              openMenu
                ? `${ws.cwd} — open in an editor or reveal in Finder`
                : ws.cwd
            }
            title={ws.cwd}
            data-wsbadge
          />
        }
      >
        <WsBadgeContent ws={ws} />
        <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
      </OpenPathMenu>
    );
  return (
    <span className={badgeClass} title={ws.cwd} data-wsbadge>
      <WsBadgeContent ws={ws} />
    </span>
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
      <span className={badgeClass}>
        <GitBranchIcon className="size-3 shrink-0" />
        <span className="truncate font-mono">{work.branch}</span>
        <span className="shrink-0">· can edit</span>
      </span>
    );
  if (work) return <span className={badgeClass}>ticket · no repo</span>;
  return (
    <span className={badgeClass}>
      <EyeIcon className="size-3" />
      {repo ? (
        <span className="font-mono">main · read-only</span>
      ) : (
        "discussion"
      )}
    </span>
  );
}
