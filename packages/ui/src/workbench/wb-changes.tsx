import {
  GitBranchIcon,
  GitCommitHorizontalIcon,
  MessageSquareTextIcon,
  PlayIcon,
  SendIcon,
} from "lucide-react";
import {
  Commit,
  CommitActions,
  CommitContent,
  CommitCopyButton,
  CommitFile,
  CommitFileAdditions,
  CommitFileChanges,
  CommitFileDeletions,
  CommitFileIcon,
  CommitFileInfo,
  CommitFilePath,
  CommitFileStatus,
  CommitFiles,
  CommitHash,
  CommitHeader,
  CommitInfo,
  CommitMessage,
  CommitMetadata,
  CommitSeparator,
} from "../components/ai-elements/commit";
import { Checkbox } from "../components/ui/checkbox";
import { ScrollArea } from "../components/ui/scroll-area";
import type { DiffCommentsStore } from "../lib/diff-comments";
import { plural, prettyPath } from "../lib/helpers";
import type {
  Diff,
  Employee,
  GitCommit,
  OsApp,
  OsEditor,
  ShipBar,
  ShipHandlers,
  Work,
} from "../types";
import { CommitBar } from "./commit-bar";
import { DiffView } from "./diff-view";
import { AddDel, PANEL, WbBtn, WbEmpty, WbHead } from "./wb-bits";

/* Workbench → Changes: the files this thread changed, each a hairline card,
   a sticky ship bar underneath. Empty states are one quiet sentence. */

export function ChangesTab({
  diffs,
  shown,
  sel,
  onShowAll,
  startOpen,
  liveMode,
  cwd,
  work,
  isDM,
  lead,
  onStart,
  startYields,
  onSend,
  pendingCount,
  onSendComments,
  running,
  steer,
  shipBar,
  unchecked,
  onToggleFile,
  dc,
  openPath,
  editors,
  commits,
}: {
  diffs: Diff[];
  /** The files on show: all of them, or the one picked in the Files tree. */
  shown: Diff[];
  sel: string | null;
  onShowAll: () => void;
  startOpen: ReadonlySet<string>;
  liveMode: boolean;
  cwd: string;
  work: Work | null;
  isDM: boolean;
  lead?: Employee;
  onStart?: () => void;
  startYields?: boolean;
  onSend?: (t: string) => void;
  pendingCount: number;
  onSendComments: () => void;
  running?: boolean;
  steer?: boolean;
  shipBar: (ShipBar & ShipHandlers) | null;
  unchecked: ReadonlySet<string>;
  onToggleFile: (path: string, on: boolean) => void;
  dc: DiffCommentsStore;
  openPath?: (path: string, app: OsApp, line?: number) => void;
  editors: OsEditor[];
  commits: GitCommit[];
}) {
  const addT = diffs.reduce((s, d) => s + d.add, 0);
  const delT = diffs.reduce((s, d) => s + d.del, 0);
  const name = lead?.name ?? "the agent";
  return (
    <>
      {/* #393 AC-9: a fade where the list scrolls under the sticky ship
          bar — no hard cut on the commit list. */}
      <div className="relative min-h-0 flex-1">
        <ScrollArea className="h-full" data-wb-scroll="changes">
          {diffs.length === 0 ? (
            liveMode ? (
              <WbEmpty>
                Clean working tree in{" "}
                <span className="font-mono">{prettyPath(cwd)}</span>.
              </WbEmpty>
            ) : work?.branch ? (
              <WbEmpty>
                No edits yet on{" "}
                <span className="font-mono">⎇ {work.branch}</span>.
              </WbEmpty>
            ) : isDM ? (
              <WbEmpty>
                Read-only thread. {lead?.name ?? "The agent"} reads code but
                can't edit here. Edits happen on a ticket in a channel with a
                repo.
              </WbEmpty>
            ) : (
              <WbEmpty
                action={
                  onStart && (
                    <span
                      className="inline-flex"
                      title={
                        startYields ? "Answer the request below" : undefined
                      }
                    >
                      <WbBtn primary onClick={onStart} disabled={startYields}>
                        <PlayIcon />
                        Start work
                      </WbBtn>
                    </span>
                  )
                }
              >
                Read-only on <span className="font-mono">main</span>. Start work
                gives {name} a ticket + worktree.
              </WbEmpty>
            )
          ) : (
            <div className={PANEL}>
              <div className="mb-3 flex flex-wrap items-center gap-2.5 text-[13px] text-muted-foreground">
                <span>{plural(diffs.length, "file")} changed</span>
                <AddDel add={addT} del={delT} />
                {work?.branch && (
                  <span className="flex items-center gap-1">
                    <GitBranchIcon className="size-3.5" />
                    <span className="font-mono text-[12px]">{work.branch}</span>
                  </span>
                )}
                {sel && (
                  <button
                    type="button"
                    onClick={onShowAll}
                    className="hover:text-foreground"
                  >
                    Show all
                  </button>
                )}
                {/* #108: pending review comments + the Codex-style send.
                    Both render only while comments exist and a send handler
                    is wired (D-#19). */}
                {onSend && pendingCount > 0 && (
                  <span className="ml-auto flex items-center gap-2">
                    <span
                      data-diff-pending
                      className="flex items-center gap-1 text-amber-700 dark:text-amber-400"
                    >
                      <MessageSquareTextIcon className="size-3" />
                      {pendingCount} pending
                    </span>
                    <WbBtn
                      primary
                      data-diff-send
                      onClick={onSendComments}
                      title={
                        running
                          ? steer
                            ? "Send as a steer into the running turn"
                            : "Send — queues as the next prompt"
                          : "Send comments to the agent"
                      }
                    >
                      <SendIcon />
                      Send to agent
                    </WbBtn>
                  </span>
                )}
              </div>
              <div className="space-y-3">
                {shown.map((d) => (
                  <div
                    /* A file picked from the Files tab remounts open, even if
                       the list started it collapsed. */
                    key={sel ? `${d.path}#picked` : d.path}
                    className="flex items-start gap-2"
                  >
                    {/* Stage checkbox — the ship bar commits the checked set
                        (issue #107 AC-1; all checked by default). */}
                    {shipBar && (
                      <Checkbox
                        data-stagecheck
                        className="mt-3 shrink-0"
                        checked={!unchecked.has(d.path)}
                        onCheckedChange={(c) =>
                          onToggleFile(d.path, c === true)
                        }
                        title={`Stage ${d.path}`}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <DiffView
                        d={d}
                        defaultOpen={startOpen.has(d.path)}
                        comments={{
                          list: dc.comments.filter((c) => c.path === d.path),
                          onAdd: dc.add,
                          onEdit: dc.edit,
                          onDelete: dc.remove,
                        }}
                        openMenu={
                          openPath
                            ? {
                                editors,
                                onOpen: (app) => openPath(d.path, app),
                              }
                            : undefined
                        }
                        onOpenLine={
                          openPath && editors.length
                            ? (line) => openPath(d.path, editors[0]!.id, line)
                            : undefined
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* Commits on this branch — outside the clean/dirty ternary: they
              still matter once every change is committed (issue #107). */}
          {commits.length > 0 && (
            <div className="px-5 pb-6">
              <WbHead className="gap-1.5 justify-start">
                <GitCommitHorizontalIcon className="size-3.5" />
                Commits on this branch
              </WbHead>
              <div className="space-y-2">
                {commits.map((c) => (
                  <Commit key={c.hash}>
                    <CommitHeader nativeButton={false}>
                      <CommitInfo className="min-w-0">
                        <CommitMessage className="truncate">
                          {c.message}
                        </CommitMessage>
                        <CommitMetadata>
                          <CommitHash>{c.hash}</CommitHash>
                          <CommitSeparator />
                          {/* #587 AC-3: the real git author — mock rows (no
                              `author`) keep the employee fallback. */}
                          {c.author || lead?.name}
                          <CommitSeparator />
                          {plural(c.files.length, "file")}
                        </CommitMetadata>
                      </CommitInfo>
                      <CommitActions>
                        <CommitCopyButton hash={c.hash} />
                      </CommitActions>
                    </CommitHeader>
                    <CommitContent>
                      <CommitFiles>
                        {c.files.map((f) => (
                          <CommitFile key={f.path}>
                            <CommitFileInfo>
                              <CommitFileStatus status={f.status} />
                              <CommitFileIcon />
                              <CommitFilePath>{f.path}</CommitFilePath>
                            </CommitFileInfo>
                            <CommitFileChanges>
                              <CommitFileAdditions count={f.add} />
                              <CommitFileDeletions count={f.del} />
                            </CommitFileChanges>
                          </CommitFile>
                        ))}
                      </CommitFiles>
                    </CommitContent>
                  </Commit>
                ))}
              </div>
            </div>
          )}
        </ScrollArea>
        {shipBar && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-[var(--v3-main)] to-transparent" />
        )}
      </div>
      {/* The commit → push → Create PR bar (issue #107/#359). */}
      {shipBar && <CommitBar {...shipBar} />}
    </>
  );
}
