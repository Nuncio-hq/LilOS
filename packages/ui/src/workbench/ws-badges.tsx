import {
  EyeIcon,
  FolderIcon,
  GitBranchIcon,
  PencilLineIcon,
} from "lucide-react";
import type { Work, Workspace } from "../types";

/* Workspace pill in the thread header: which folder/branch this session runs in. */
export function WsBadge({ ws }: { ws: Workspace }) {
  const f = { project: ws.project };
  return (
    <div
      className="mt-1 flex w-fit max-w-full items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-800 text-xs"
      title={ws.cwd}
      data-wsbadge
    >
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
