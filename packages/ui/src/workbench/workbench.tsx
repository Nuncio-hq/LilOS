import {
  CircleDotIcon,
  EyeIcon,
  FileDiffIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
  GlobeIcon,
  PanelRightCloseIcon,
  PlayIcon,
  RefreshCcwIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
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
import { FileTree } from "../components/ai-elements/file-tree";
import { Shimmer } from "../components/ai-elements/shimmer";
import {
  Terminal,
  TerminalActions,
  TerminalContent,
  TerminalCopyButton,
  TerminalHeader,
  TerminalStatus,
  TerminalTitle,
} from "../components/ai-elements/terminal";
import {
  WebPreview,
  WebPreviewNavigation,
  WebPreviewNavigationButton,
  WebPreviewUrl,
} from "../components/ai-elements/web-preview";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
import { plural } from "../lib/helpers";
import type {
  Diff,
  Employee,
  HostAccessors,
  HumanFn,
  MergeMethod,
  OsApp,
  OsEditor,
  PrError,
  PullRequest,
  Thread,
  WbTab,
  Work,
} from "../types";
import type { TreeNode } from "./artifacts";
import { buildTree, sessionArtifacts } from "./artifacts";
import { DiffView } from "./diff-view";
import { TreeNodes } from "./file-tree-nodes";
import { LivePreview, type LiveSurfaces, LiveTerminal } from "./live";
import { OpenPathButton } from "./open-path";
import { PrFailure } from "./pr-failure";
import { PrPanel } from "./pr-panel";

/* Right-hand workbench of Focus, derived from the session's steps, or — when the session
   runs in a real folder on this machine (work.path) and host accessors are wired — from the
   live fs/git host API: Files = fs.tree, Changes = git.diff, file view = fs.read.
   repoFiles is the app's mock repo listing (fallback when no host answers). */
export function Workbench({
  thread,
  work,
  isDM,
  lead,
  tab,
  setTab,
  onClose,
  onStart,
  startYields,
  onSend,
  say,
  repoFiles,
  host,
  human,
  onPrComment,
  onPrMerge,
  live,
  running,
  editors: editorsProp,
  onOpenPath,
}: {
  thread: Thread;
  work: Work | null;
  isDM: boolean;
  lead?: Employee;
  tab: WbTab;
  setTab: (t: WbTab) => void;
  onClose: () => void;
  onStart?: () => void;
  /** True while the "asks to start work" card is open: it is the single entry point (issue #15). */
  startYields?: boolean;
  onSend?: (t: string) => void;
  say?: (t: string) => void;
  repoFiles?: string[];
  /** Live host accessors for the session's real cwd (issue #11 fs/git, #37 forge). */
  host?: HostAccessors;
  human: HumanFn;
  onPrComment?: (t: string) => void | Promise<void>;
  onPrMerge?: (method: MergeMethod) => void | Promise<void>;
  /** Live harness surfaces (issue #36): replaces the mock Terminal/Preview tabs. */
  live?: LiveSurfaces;
  /** A turn is running — Changes/Files poll while the agent edits (#114 AC-3). */
  running?: boolean;
  /* os.editors + a bound os.open (issue #110, same pair ThreadView takes):
     the caller probes `host.describe` — onOpenPath={null} means os.open was
     absent, so rows show no open menu even when the accessors object
     statically carries the method (D-#19). Undefined keeps the component's
     own host.osEditors/osOpen path (prototype). */
  editors?: OsEditor[];
  onOpenPath?: ((path: string, app: OsApp, line?: number) => void) | null;
}) {
  const a = sessionArtifacts(thread);
  const [sel, setSel] = useState<string | null>(null);
  const [viewFile, setViewFile] = useState<{
    path: string;
    content: string;
    binary: boolean;
    truncated: boolean;
  } | null>(null);
  const liveCwd = work?.path;
  /* Live mode = host accessors + a real session folder. In it each tab
     renders only when its host method answered (D-#19, #114 AC-6): `null`
     fields mean "didn't answer" — fs unreachable, path not a repo, `gh`
     missing — never an unlucky mock fallback. `probe` is null until the
     first round lands. */
  const liveMode = !!host && liveCwd != null;
  const [probe, setProbe] = useState<{
    files: string[] | null;
    diffs: Diff[] | null;
    pr: { pr: PullRequest | null; branch?: string; error?: PrError } | null;
  } | null>(null);
  /* Open-in-editor affordances (issue #110): editors detected on this host
     (os.editors) + one bound os.open call. No os.open → no controls (D-#19);
     no editors → the menus offer Reveal in Finder only. */
  const [hostEditors, setHostEditors] = useState<OsEditor[]>([]);
  useEffect(() => {
    let off = false;
    if (editorsProp === undefined && host?.osEditors && liveCwd)
      void host
        .osEditors()
        .then((e) => !off && setHostEditors(e))
        .catch(() => {});
    else setHostEditors([]);
    return () => {
      off = true;
    };
  }, [liveCwd, editorsProp]);
  const editors = editorsProp ?? hostEditors;
  const reloadPr = async () => {
    if (!host?.pr || !liveCwd) return;
    const r = await host.pr(liveCwd).catch(() => null);
    if (r) setProbe((p) => (p ? { ...p, pr: r } : p));
  };
  // Read the session folder live. While a turn runs the agent is editing —
  // a short poll keeps Changes/Files current (#114 AC-3); the effect's
  // re-run on `running` flips lands a fresh read at turn end.
  useEffect(() => {
    setViewFile(null);
    if (!liveMode || !host || !liveCwd) {
      setProbe(null);
      return;
    }
    const cwd = liveCwd;
    let off = false;
    const update = () =>
      Promise.all([host.tree(cwd), host.diff(cwd), host.pr?.(cwd)]).then(
        ([files, d, pr]) => {
          if (off) return;
          setProbe({ files, diffs: d ?? null, pr: pr ?? null });
        },
      );
    void update();
    const poll = running ? setInterval(update, 1500) : undefined;
    return () => {
      off = true;
      if (poll) clearInterval(poll);
    };
  }, [liveMode, liveCwd, running, host]);
  const diffs = liveMode ? (probe?.diffs ?? []) : a.diffs;
  const changed = new Map(diffs.map((d) => [d.path, d]));
  const tree = buildTree([
    ...new Set([...(probe?.files ?? repoFiles ?? []), ...changed.keys()]),
  ]);
  const folders = new Set<string>();
  diffs.forEach((d) => {
    d.path
      .split("/")
      .slice(0, -1)
      .forEach((_, i, arr) => {
        folders.add(arr.slice(0, i + 1).join("/"));
      });
  });
  // Folder names expand the tree, file names read the file (or open its diff).
  const dirs = new Set<string>();
  const walkDirs = (n: TreeNode) => {
    for (const c of n.children.values())
      if (c.children.size > 0) {
        dirs.add(c.path);
        walkDirs(c);
      }
  };
  walkDirs(tree);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const expandedSeed = new Set(["packages", "apps", ...folders]);
  /* Newly seen folders expand — keyed on the seed's contents, not the probe
     object, so the poll never re-expands folders the user collapsed. */
  const expandedKey = [...expandedSeed].sort().join("\n");
  useEffect(() => {
    setExpanded((e) => {
      const n = new Set(e);
      for (const f of expandedSeed) n.add(f);
      return n;
    });
  }, [expandedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const cwd =
    work?.path ??
    (work?.branch ? `.lilos/wt/${work.ticket.toLowerCase()}` : "main");
  const shown = sel ? diffs.filter((d) => d.path === sel) : diffs;
  const addT = diffs.reduce((s, d) => s + d.add, 0);
  const delT = diffs.reduce((s, d) => s + d.del, 0);
  const count = (n: number) =>
    n > 0 && (
      <span className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
        {n}
      </span>
    );

  /* PR tab (issue #37): in live mode the forge's answer is authoritative —
     `{pr}` shows it, `{pr:null}` shows a plain "no PR on this branch" state,
     `{error}` reads the `gh` failure plainly (#114 AC-5). A silent method
     (outer null) hides the tab. Without a host the session-carried
     thread.pr stays (mock). */
  const prShown = liveMode ? (probe?.pr?.pr ?? null) : thread.pr;
  const prError = liveMode ? probe?.pr?.error : undefined;
  const liveForge = liveMode && prShown != null && liveCwd != null;
  /* Tabs render only when their host method answered (#114 AC-6). Terminal /
     Preview exist only where live surfaces are wired (slice B, #119). */
  const changesOn = !liveMode || probe?.diffs != null;
  const filesOn = !liveMode || probe?.files != null;
  const surfacesOn = !liveMode || live != null;
  const prOn = !liveMode ? prShown != null : probe?.pr != null;
  const allowed: Record<WbTab, boolean> = {
    changes: changesOn,
    files: filesOn,
    terminal: surfacesOn,
    preview: surfacesOn,
    pr: prOn,
  };
  /* The caller's tab choice yields to availability: when its method never
     answers the first allowed tab shows instead. */
  const shownTab = allowed[tab]
    ? tab
    : (["changes", "files", "pr", "terminal", "preview"] as WbTab[]).find(
        (t) => allowed[t],
      );
  const ghError = (e: unknown) =>
    (e instanceof Error ? e.message : String(e)).slice(0, 160);
  /* One bound "open this path" for every workbench surface: `line` opens at
     the diff row's new-file line when the editor takes one; "finder" reveals. */
  const openPath =
    onOpenPath && liveCwd
      ? (path: string, app: OsApp, line?: number) => onOpenPath(path, app, line)
      : onOpenPath === undefined && host?.osOpen && liveCwd
        ? (path: string, app: OsApp, line?: number) => {
            void host
              .osOpen?.(liveCwd, path, app, line)
              .catch((e) => say?.(`Open failed — ${ghError(e)}`));
          }
        : undefined;
  const prComment =
    liveForge && host?.prComment && liveCwd
      ? async (t: string) => {
          try {
            await host.prComment?.(liveCwd, t);
            await reloadPr();
            say?.("Comment posted via gh");
          } catch (e) {
            say?.(`Comment failed — ${ghError(e)}`);
          }
        }
      : onPrComment;
  const prMerge =
    liveForge && host?.prMerge && liveCwd
      ? async (m: MergeMethod) => {
          try {
            const pr = await host.prMerge?.(liveCwd, m);
            if (pr) setProbe((p) => (p ? { ...p, pr: { pr } } : p));
            say?.(
              pr?.status === "merged"
                ? `Merged #${pr.number} into ${pr.base} · gh pr merge --${m}`
                : `gh pr merge returned but the PR is ${pr?.status}`,
            );
          } catch (e) {
            say?.(`Merge failed — ${ghError(e)}`);
          }
        }
      : onPrMerge;
  /* First probe still in flight → hold the aside; a landed probe with no
     answered method gets one plain line instead of an empty tab strip. */
  if (liveMode && probe === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-1.5 p-6 text-center text-muted-foreground text-xs">
        Reading <span className="font-mono">{cwd}</span>…
      </div>
    );
  }
  if (liveMode && !changesOn && !filesOn && !surfacesOn && !prOn) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-muted-foreground text-xs">
        <p>
          Nothing to show — the host has no answer for{" "}
          <span className="font-mono">{cwd}</span>.
        </p>
      </div>
    );
  }

  return (
    <Tabs
      value={shownTab ?? "changes"}
      onValueChange={(v) => setTab(v as WbTab)}
      className="flex min-h-0 flex-1 flex-col gap-0"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <TabsList
          variant="line"
          className="no-scrollbar h-full min-w-0 overflow-x-auto"
        >
          {changesOn && (
            <TabsTrigger value="changes">
              <FileDiffIcon />
              Changes{count(diffs.length)}
            </TabsTrigger>
          )}
          {filesOn && (
            <TabsTrigger value="files">
              <FolderGit2Icon />
              Files
            </TabsTrigger>
          )}
          {surfacesOn && (
            <TabsTrigger value="terminal">
              <SquareTerminalIcon />
              Terminal
              {a.termRunning && (
                <CircleDotIcon className="size-3 animate-pulse text-amber-500" />
              )}
            </TabsTrigger>
          )}
          {surfacesOn && (
            <TabsTrigger value="preview">
              <GlobeIcon />
              Preview
            </TabsTrigger>
          )}
          {prOn && (
            <TabsTrigger value="pr">
              <GitPullRequestIcon
                className={
                  prShown?.status === "merged"
                    ? "text-violet-600"
                    : prShown?.status === "closed"
                      ? "text-zinc-500"
                      : "text-emerald-600"
                }
              />
              {prShown ? `PR #${prShown.number}` : "PR"}
            </TabsTrigger>
          )}
        </TabsList>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          onClick={onClose}
          title="Hide workbench"
        >
          <PanelRightCloseIcon />
        </Button>
      </div>

      <TabsContent value="changes" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          {diffs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-8 text-center text-muted-foreground text-xs">
              <EyeIcon className="size-5" />
              {liveMode ? (
                <p>
                  Clean working tree in <span className="font-mono">{cwd}</span>
                  .
                </p>
              ) : work?.branch ? (
                <p>
                  No edits yet on{" "}
                  <span className="font-mono">⎇ {work.branch}</span>.
                </p>
              ) : isDM ? (
                <p>
                  Read-only session. {lead?.name ?? "The employee"} reads code
                  but can't edit here.
                  <br />
                  Edits happen on a ticket in a channel with a repo.
                </p>
              ) : (
                <>
                  <p>
                    Read-only on <span className="font-mono">main</span>. Start
                    work gives {lead?.name ?? "the employee"} a ticket +
                    worktree.
                  </p>
                  {onStart && (
                    <span
                      className="inline-flex"
                      title={
                        startYields ? "Answer the request below" : undefined
                      }
                    >
                      <Button
                        size="sm"
                        onClick={onStart}
                        disabled={startYields}
                      >
                        <PlayIcon />
                        Start work
                      </Button>
                    </span>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="space-y-3 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">
                  {plural(diffs.length, "file")} changed
                </span>
                <span className="font-mono text-emerald-600">+{addT}</span>
                <span className="font-mono text-red-600">−{delT}</span>
                {work?.branch && (
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <GitBranchIcon className="size-3" />
                    <span className="font-mono">{work.branch}</span>
                  </span>
                )}
                {sel && (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setSel(null)}
                  >
                    Show all
                  </Button>
                )}
              </div>
              {shown.map((d) => (
                <DiffView
                  key={d.path}
                  d={d}
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
              ))}
              {a.commits.length > 0 && (
                <div className="space-y-2 pt-2">
                  <div className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs">
                    <GitCommitHorizontalIcon className="size-3.5" />
                    Commits on this branch
                  </div>
                  {a.commits.map((c) => (
                    <Commit key={c.hash}>
                      <CommitHeader nativeButton={false}>
                        <CommitInfo className="min-w-0">
                          <CommitMessage className="truncate">
                            {c.message}
                          </CommitMessage>
                          <CommitMetadata>
                            <CommitHash>{c.hash}</CommitHash>
                            <CommitSeparator />
                            {lead?.name}
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
              )}
            </div>
          )}
        </ScrollArea>
      </TabsContent>

      <TabsContent value="files" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="p-3">
            <div className="mb-2 flex items-center gap-1.5 text-muted-foreground text-xs">
              <FolderGit2Icon className="size-3.5" />
              <span className="font-mono">{cwd}</span>
              {openPath && (
                <OpenPathButton
                  editors={editors}
                  onOpen={(app) => openPath(".", app)}
                  label="Open this folder in an editor or Finder"
                />
              )}
              {diffs.length > 0 && (
                <span>
                  · {plural(diffs.length, "file")}{" "}
                  {liveMode ? "changed" : "touched by this session"}
                </span>
              )}
            </div>
            {liveMode && probe === null ? (
              <div className="py-6 text-center text-muted-foreground text-xs">
                Reading <span className="font-mono">{cwd}</span>…
              </div>
            ) : viewFile ? (
              <div data-fileview className="space-y-2">
                <div className="flex items-center gap-2 text-xs">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setViewFile(null)}
                  >
                    ← Files
                  </Button>
                  <span className="min-w-0 truncate font-mono text-muted-foreground">
                    {viewFile.path}
                  </span>
                  {openPath && (
                    <OpenPathButton
                      editors={editors}
                      onOpen={(app) => openPath(viewFile.path, app)}
                      label={`Open ${viewFile.path} in an editor or Finder`}
                    />
                  )}
                </div>
                {viewFile.binary ? (
                  <p className="py-4 text-center text-muted-foreground text-xs">
                    Binary file — not shown.
                  </p>
                ) : (
                  <pre className="max-h-[60vh] overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-[11px] leading-5">
                    {viewFile.content}
                    {viewFile.truncated && (
                      <div className="pt-2 text-muted-foreground">
                        … truncated
                      </div>
                    )}
                  </pre>
                )}
              </div>
            ) : (
              <FileTree
                expanded={expanded}
                onExpandedChange={setExpanded}
                selectedPath={sel ?? undefined}
                onSelect={(p) => {
                  if (dirs.has(p)) {
                    setExpanded((e) => {
                      const n = new Set(e);
                      if (n.has(p)) n.delete(p);
                      else n.add(p);
                      return n;
                    });
                  } else if (changed.has(p)) {
                    setSel(p);
                    setTab("changes");
                  } else if (host && liveCwd) {
                    void host.read(liveCwd, p).then((r) =>
                      setViewFile(
                        r
                          ? { path: p, ...r }
                          : {
                              path: p,
                              content: "",
                              binary: true,
                              truncated: false,
                            },
                      ),
                    );
                  } else say?.(`${p} · unchanged in this session`);
                }}
                className="border-0 text-xs"
              >
                <TreeNodes
                  node={tree}
                  changed={changed}
                  openPath={
                    openPath
                      ? { editors, onOpen: (p, app) => openPath(p, app) }
                      : undefined
                  }
                />
              </FileTree>
            )}
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="terminal" className="flex min-h-0 flex-1 flex-col">
        {live ? (
          <LiveTerminal live={live} cwd={cwd} agentName={lead?.name} />
        ) : (
          <Terminal
            output={
              a.termOut || "\u001b[90mNo commands yet in this session.\u001b[0m"
            }
            isStreaming={a.termRunning}
            className="min-h-0 flex-1 rounded-none border-0"
          >
            <TerminalHeader className="py-1.5">
              <TerminalTitle className="text-xs">
                <span className="font-mono">{cwd}</span>
                {!work?.branch && (
                  <span className="rounded bg-zinc-800 px-1 text-[10px]">
                    read-only
                  </span>
                )}
              </TerminalTitle>
              <div className="flex items-center gap-1">
                <TerminalStatus>
                  <Shimmer as="span" duration={1}>
                    running
                  </Shimmer>
                </TerminalStatus>
                <TerminalActions>
                  <TerminalCopyButton />
                </TerminalActions>
              </div>
            </TerminalHeader>
            <TerminalContent className="max-h-none min-h-0 flex-1 text-xs" />
          </Terminal>
        )}
      </TabsContent>

      <TabsContent value="preview" className="flex min-h-0 flex-1 flex-col">
        {live ? (
          <LivePreview live={live} />
        ) : (
          <WebPreview
            defaultUrl="http://localhost:5173"
            className="rounded-none border-0"
          >
            <WebPreviewNavigation className="p-1.5">
              {say && (
                <WebPreviewNavigationButton
                  tooltip="Reload"
                  onClick={() => say("Reload (prototype)")}
                >
                  <RefreshCcwIcon className="size-4" />
                </WebPreviewNavigationButton>
              )}
              <WebPreviewUrl />
            </WebPreviewNavigation>
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground text-xs">
              <GlobeIcon className="size-5" />
              <p>
                No dev server running in{" "}
                <span className="font-mono">{cwd}</span>.
              </p>
              {onSend && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onSend(
                      "Start the dev server in the background and give me the URL",
                    )
                  }
                >
                  Ask {lead?.name ?? "employee"} to run pnpm dev
                </Button>
              )}
            </div>
          </WebPreview>
        )}
      </TabsContent>

      {prOn && (
        <TabsContent value="pr" className="min-h-0 flex-1">
          {prShown ? (
            <PrPanel
              pr={prShown}
              diffs={diffs}
              commits={a.commits}
              lead={lead}
              session={thread.session}
              human={human}
              onComment={prComment}
              onMerge={prMerge}
              say={say}
            />
          ) : (
            /* No PR on the branch, or `gh` failed — plain copy per reason
               with one next step; raw stderr stays behind Details (#114 AC-5). */
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground text-xs">
              {prError ? (
                <PrFailure error={prError} onRetry={reloadPr} />
              ) : (
                <>
                  <EyeIcon className="size-5" />
                  <p>
                    No pull request on{" "}
                    <span className="font-mono">
                      ⎇ {probe?.pr?.branch || work?.branch || "this branch"}
                    </span>{" "}
                    yet.
                  </p>
                </>
              )}
            </div>
          )}
        </TabsContent>
      )}
    </Tabs>
  );
}
