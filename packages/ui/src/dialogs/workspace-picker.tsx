import {
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  GitBranchPlusIcon,
  MessageSquareIcon,
  PencilLineIcon,
} from "lucide-react";
import { PromptInputButton } from "../components/ai-elements/prompt-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { folderLabel, NO_WS } from "../lib/helpers";
import { cn } from "../lib/utils";
import type { Folder, WsPick } from "../types";

/* Folder → branch → workstream, picked before the first message (Codex / Claude Code "where does this run").
   Hermes: projects.list/for_cwd for folders + branch; the engine runs `git worktree add` for a new workstream,
   then session.create { cwd }. The session keeps that cwd; switching later = session.cwd.set while idle. */
export function WorkspacePicker({
  folders,
  pick,
  setPick,
  onAddFolder,
  onWorktree,
}: {
  folders: Folder[];
  pick: WsPick;
  setPick: (p: WsPick) => void;
  onAddFolder?: () => void;
  /* Workstream/worktree picks (#10) render only when this handler is passed
     (D-#19); without it the picker is direct-mode only and folders pick
     `mode: "direct"` (issue #113). */
  onWorktree?: (p: WsPick) => void;
}) {
  const f = folders.find((x) => x.id === pick.folder);
  /* Chips compress + truncate when the composer's one-row tools strip is
     tight: shrink-0 children used to overflow the (shrunk) picker box and
     end up painted under the next control — clickable by nobody (e2e:
     the model picker's label intercepted the branch chip's clicks). */
  const chip =
    "h-7 max-w-64 min-w-0 shrink gap-1.5 rounded-md px-2 text-xs font-normal text-foreground/80 hover:text-foreground data-[popup-open]:bg-muted [&>span]:min-w-0 [&>span]:truncate";
  const modeLabel =
    pick.mode === "new"
      ? "new workstream"
      : pick.mode === "direct"
        ? "direct"
        : "workstream";
  return (
    <div
      className="flex min-w-0 items-center gap-0.5 overflow-hidden"
      data-wspicker
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <PromptInputButton size="sm" className={chip} data-ws="folder" />
          }
        >
          <FolderIcon className="size-3.5" />
          <span className={cn(!f && "text-foreground/70")}>
            {f ? folderLabel(f, folders) : "No folder"}
          </span>
          <ChevronDownIcon className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-72" side="top">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Run this thread in</DropdownMenuLabel>
            {folders.map((x) => (
              <DropdownMenuItem
                key={x.id}
                disabled={x.missing}
                data-wsfolder={x.id}
                {...(x.missing ? { "data-missing": "" } : {})}
                onClick={() =>
                  setPick({
                    folder: x.id,
                    base: x.branches[0] ?? "",
                    mode: onWorktree && x.branches.length ? "new" : "direct",
                  })
                }
                className="items-start"
              >
                <FolderIcon className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    {folderLabel(x, folders)}
                    {x.missing && (
                      <span className="ml-1.5 font-normal text-muted-foreground text-xs">
                        · missing
                      </span>
                    )}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {x.path}
                  </span>
                </span>
                {pick.folder === x.id && <CheckIcon className="mt-0.5" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setPick(NO_WS)}>
            <MessageSquareIcon />
            No folder · just chat
            {!pick.folder && <CheckIcon className="ml-auto" />}
          </DropdownMenuItem>
          {onAddFolder && (
            <DropdownMenuItem onClick={onAddFolder}>
              <FolderPlusIcon />
              Add a folder…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {f && !f.branches.length && (
        <span
          className="flex h-7 min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap px-2 text-foreground/70 text-xs"
          data-ws="nogit"
          title="Not a git repo: no branches or worktrees, edits land in the folder"
        >
          <PencilLineIcon className="size-3.5" />
          direct · no git
        </span>
      )}
      {f && f.branches.length > 0 && !onWorktree && (
        <span
          className="flex h-7 min-w-0 items-center gap-1.5 overflow-hidden px-2 text-foreground/70 text-xs"
          data-ws="branch"
          title="Direct mode: edits land on the checked-out branch"
        >
          <PencilLineIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate font-mono">{f.branches[0]}</span>
          <span className="hidden shrink-0 lg:inline">· direct</span>
        </span>
      )}
      {f && f.branches.length > 0 && onWorktree && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <PromptInputButton size="sm" className={chip} data-ws="branch" />
            }
          >
            {pick.mode === "existing" ? (
              <GitBranchIcon className="size-3.5" />
            ) : pick.mode === "direct" ? (
              <PencilLineIcon className="size-3.5" />
            ) : (
              <GitBranchPlusIcon className="size-3.5" />
            )}
            <span className="font-mono">
              {pick.mode === "existing" ? pick.existing : pick.base}
            </span>
            <span className="hidden text-foreground/70 lg:inline">
              · {modeLabel}
            </span>
            <ChevronDownIcon className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-80" side="top">
            <DropdownMenuGroup>
              <DropdownMenuLabel>New workstream from</DropdownMenuLabel>
              {f.branches.map((b) => (
                <DropdownMenuItem
                  key={`n-${b}`}
                  onClick={() =>
                    onWorktree({
                      ...pick,
                      mode: "new",
                      base: b,
                      existing: undefined,
                    })
                  }
                >
                  <GitBranchPlusIcon />
                  <span className="font-mono">{b}</span>
                  <span className="text-muted-foreground text-xs">
                    new branch + worktree
                  </span>
                  {pick.mode === "new" && pick.base === b && (
                    <CheckIcon className="ml-auto" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            {f.workstreams.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Continue a workstream</DropdownMenuLabel>
                  {f.workstreams.map((w) => (
                    <DropdownMenuItem
                      key={`w-${w.branch}`}
                      onClick={() =>
                        onWorktree({
                          ...pick,
                          mode: "existing",
                          existing: w.branch,
                          base: w.from,
                        })
                      }
                    >
                      <GitBranchIcon />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono">
                          {w.branch}
                        </span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {w.path} · from {w.from}
                        </span>
                      </span>
                      {pick.mode === "existing" &&
                        pick.existing === w.branch && <CheckIcon />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>No worktree</DropdownMenuLabel>
              {f.branches.map((b) => (
                <DropdownMenuItem
                  key={`d-${b}`}
                  onClick={() =>
                    setPick({
                      ...pick,
                      mode: "direct",
                      base: b,
                      existing: undefined,
                    })
                  }
                >
                  <PencilLineIcon />
                  <span>
                    Edit <span className="font-mono">{b}</span> directly
                  </span>
                  {pick.mode === "direct" && pick.base === b && (
                    <CheckIcon className="ml-auto" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export const wsHint = (f: Folder | undefined, p: WsPick, directOnly = false) =>
  !f
    ? "Chat only · no folder. Enter opens a new thread"
    : !f.branches.length
      ? `Enter opens a thread in ${f.path} · edits land there directly`
      : p.mode === "new"
        ? `Enter opens a thread in a new worktree off ${p.base}`
        : p.mode === "existing"
          ? `Enter opens a thread in ${f.workstreams.find((w) => w.branch === p.existing)?.path ?? "the worktree"}`
          : directOnly
            ? `Enter opens a thread in ${f.path} · edits land on the checked-out branch (${p.base})`
            : `Enter opens a thread in ${f.path} · edits land on ${p.base} directly`;
