import { useMemo } from "react";
import { Tabs, TabsContent } from "../components/ui/tabs";
import { prettyPath } from "../lib/helpers";
import type { Diff, WbTab } from "../types";
import { sessionArtifacts } from "./artifacts";
import { BackgroundPanel } from "./background-panel";
import { openPaths } from "./diff-rows";
import { PlanPanel, threadPlans } from "./plan-panel";
import { PrTabBody } from "./pr-panel";
import { SubagentsPanel, sessionSubagents } from "./subagents-panel";
import { useFileTree } from "./use-file-tree";
import { useShipBar } from "./use-ship-bar";
import { useTabFit } from "./use-tab-fit";
import { useWbForge } from "./use-wb-forge";
import { useWbOpen } from "./use-wb-open";
import { useWbProbe, WB_PR_SIG_MARK } from "./use-wb-probe";
import { useWbReview } from "./use-wb-review";
import { useWbScroll } from "./use-wb-scroll";
import { useWbSpot } from "./use-wb-spot";
import { useWbTabs } from "./use-wb-tabs";
import { WbNothingToShow, WbReading } from "./wb-bits";
import { ChangesTab } from "./wb-changes";
import { DetailsPanel } from "./wb-details";
import { FilesTab } from "./wb-files";
import { PreviewSurface, TerminalSurface } from "./wb-surfaces";
import { WbTabStrip } from "./wb-tab-strip";
import type { WorkbenchProps } from "./workbench-props";

const NO_DIFFS: Diff[] = [];

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
  steer,
  editors: editorsProp,
  onOpenPath,
  onStopJob,
  browser,
  emp,
  onOpenSession,
  spot,
  onAllowed,
  ship,
  caps,
  onSuggest,
  onPr,
}: WorkbenchProps) {
  const a = useMemo(() => sessionArtifacts(thread), [thread]);
  const jobs = thread.jobs ?? [];
  const jobsRunning = jobs.filter((j) => j.status === "running").length;
  const helpers = sessionSubagents(thread);
  const helpersRunning = helpers.filter((h) => h.a.status === "running").length;
  const plans = threadPlans(thread);
  const plan = plans[plans.length - 1];
  const liveCwd = work?.path;
  /* Live mode = host accessors + a real session folder. In it each tab
     renders only when its host method answered (D-#19, #114 AC-6): `null`
     fields mean "didn't answer" — fs unreachable, path not a repo, `gh`
     missing — never an unlucky mock fallback. */
  const liveMode = !!host && liveCwd != null;
  /* D-#114 (#543): the Workbench exists for EVERY session and lives only
     in Focus; opening a session goes to the thread panel first, whose ↗
     is the way into Focus. A DM session started with no folder (`work`
     null) still gets the engine tabs (Subagents/Background/Plan); the
     folder-bound ones (Changes/Files/Terminal/Preview/PR) stay hidden
     (D-#19 per tab). Changes = uncommitted files vs HEAD, untracked
     included. A channel thread (`isDM` false, read-only — the app never
     Focuses one) keeps its mock tabs. Not: straight to Focus, a Workbench
     only where a folder exists, or a Workbench in the thread panel. */
  const folderless = work == null && isDM;
  const {
    probe,
    restored,
    sel,
    setSel,
    viewFile,
    setViewFile,
    firstSettled,
    revalidating,
    prSigMark,
    landPr,
    reloadPr,
    updateProbe,
    prPoll,
  } = useWbProbe({ host, liveMode, liveCwd, running, tab });
  const { editors, openPath, treeOpenPath } = useWbOpen({
    host,
    liveCwd,
    editors: editorsProp,
    onOpenPath,
    say,
  });
  /* Memoized so the file tree's memo boundary sees stable props between
     feed-event renders — a per-render Map/array would reconcile all rows
     (#547 AC-5). */
  const diffs = useMemo(
    () => (liveMode ? (probe?.diffs ?? NO_DIFFS) : a.diffs),
    [liveMode, probe?.diffs, a],
  );
  const changed = useMemo(
    () => new Map(diffs.map((d) => [d.path, d])),
    [diffs],
  );

  /* The commit → push → Create PR bar's state (issue #107/#359). */
  const {
    shipBar,
    unchecked,
    toggleFile,
    commits: liveCommits,
  } = useShipBar({
    thread,
    work,
    lead,
    liveMode,
    host,
    liveCwd,
    probe,
    diffs,
    stepCommits: a.commits,
    ship,
    onSend,
    onSuggest,
    setTab,
    updateProbe,
  });
  const { dc, pendingCount, sendComments } = useWbReview({
    thread,
    diffs,
    liveMode,
    probe,
    running,
    steer,
    onSend,
    say,
  });
  useWbSpot({ spot, changed, host, liveCwd, setSel, setTab, setViewFile });
  const fileTree = useFileTree({
    files: probe?.files,
    repoFiles,
    changed,
    diffs,
    host,
    liveCwd,
    say,
    setSel,
    setTab,
    setViewFile,
  });
  const cwd =
    work?.path ??
    (work?.branch ? `.lilos/wt/${work.ticket.toLowerCase()}` : "main");
  const shown = sel ? diffs.filter((d) => d.path === sel) : diffs;
  /* Which of the shown files start open (a huge working tree starts mostly
     collapsed — see `openPaths`). */
  const startOpen = useMemo(() => openPaths(shown), [shown]);

  const { allowed, shownTab } = useWbTabs({
    tab,
    liveMode,
    firstSettled,
    probe,
    folderless,
    isDM,
    hasSurfaces: live != null,
    hasBrowser: !!browser,
    hasEmp: !!emp,
    canStopJobs: onStopJob != null,
    caps,
    jobs: jobs.length,
    helpers: helpers.length,
    plans: plans.length,
    onAllowed,
  });
  const wbRootRef = useWbScroll({
    restored,
    shownTab,
    liveMode,
    host,
    liveCwd,
    win: fileTree.win,
  });
  const { prShown, prError, prComment, prMerge } = useWbForge({
    thread,
    host,
    liveMode,
    liveCwd,
    probe,
    shownTab,
    reloadPr,
    landPr,
    prPoll,
    onPrComment,
    onPrMerge,
    onPr,
    say,
  });

  /* Fold/scroll fit of the tab strip (issue #326) — see `useTabFit`. */
  const listRef = useTabFit(shownTab);

  /* First round still in flight on a cold mount → hold the aside (a
     cache hit skips this — its rows paint the first frame, #544); a
     settled round with no answered method gets one plain line instead
     of an empty tab strip. `pr` is not in the round — `gh` never gates
     this wait (AC-2). */
  if (liveMode && !firstSettled) return <WbReading cwd={prettyPath(cwd)} />;
  if (
    !allowed.changes &&
    !allowed.files &&
    !allowed.preview &&
    !allowed.pr &&
    !allowed.background &&
    !allowed.subagents &&
    !allowed.plan
  )
    return <WbNothingToShow folderless={folderless} cwd={prettyPath(cwd)} />;

  return (
    <Tabs
      ref={wbRootRef}
      value={shownTab ?? "changes"}
      onValueChange={(v) => setTab(v as WbTab)}
      className="flex min-h-0 flex-1 flex-col gap-0"
    >
      <WbTabStrip
        listRef={listRef}
        s={{
          on: allowed,
          changes: diffs.length,
          termRunning: a.termRunning,
          plan,
          jobs: jobs.length,
          jobsRunning,
          helpers: helpers.length,
          helpersRunning,
          pr: prShown,
        }}
        revalidating={revalidating}
        onClose={onClose}
      />

      <TabsContent value="changes" className="flex min-h-0 flex-1 flex-col">
        <ChangesTab
          diffs={diffs}
          shown={shown}
          sel={sel}
          onShowAll={() => setSel(null)}
          startOpen={startOpen}
          liveMode={liveMode}
          cwd={cwd}
          work={work}
          isDM={isDM}
          lead={lead}
          onStart={onStart}
          startYields={startYields}
          onSend={onSend}
          pendingCount={pendingCount}
          onSendComments={sendComments}
          running={running}
          steer={steer}
          shipBar={shipBar}
          unchecked={unchecked}
          onToggleFile={toggleFile}
          dc={dc}
          openPath={openPath}
          editors={editors}
          commits={liveCommits}
        />
      </TabsContent>

      <TabsContent value="files" className="min-h-0 flex-1">
        <FilesTab
          cwd={cwd}
          diffs={diffs}
          liveMode={liveMode}
          probing={liveMode && probe === null}
          viewFile={viewFile}
          onCloseFile={() => setViewFile(null)}
          openPath={openPath}
          editors={editors}
          expanded={fileTree.expanded}
          onExpandedChange={fileTree.setExpanded}
          sel={sel}
          onSelect={fileTree.onSelect}
          tree={fileTree.tree}
          changed={changed}
          included={fileTree.included}
          treeOpenPath={treeOpenPath}
        />
      </TabsContent>

      <TabsContent value="terminal" className="flex min-h-0 flex-1 flex-col">
        <TerminalSurface
          live={live}
          cwd={cwd}
          agentName={lead?.name}
          output={a.termOut}
          running={a.termRunning}
          readOnly={!work?.branch}
        />
      </TabsContent>

      <TabsContent value="preview" className="flex min-h-0 flex-1 flex-col">
        <PreviewSurface
          live={live}
          cwd={cwd}
          agentName={lead?.name}
          say={say}
          onSend={onSend}
        />
      </TabsContent>

      {allowed.pr && (
        <TabsContent
          value="pr"
          className="min-h-0 flex-1"
          data-pr-sig-mark={WB_PR_SIG_MARK ? prSigMark : undefined}
        >
          <PrTabBody
            pr={prShown}
            error={prError}
            branch={probe?.pr?.branch || work?.branch || "this branch"}
            onRetry={reloadPr}
            diffs={diffs}
            commits={a.commits}
            lead={lead}
            human={human}
            onComment={prComment}
            onMerge={prMerge}
            say={say}
          />
        </TabsContent>
      )}

      {allowed.background && (
        <TabsContent value="background" className="min-h-0 flex-1">
          <BackgroundPanel jobs={jobs} onStop={onStopJob} />
        </TabsContent>
      )}

      {plan && (
        <TabsContent value="plan" className="min-h-0 flex-1">
          <PlanPanel plans={plans} />
        </TabsContent>
      )}

      {allowed.subagents && emp && (
        <TabsContent value="subagents" className="min-h-0 flex-1">
          <SubagentsPanel
            thread={thread}
            emp={emp}
            onOpenSession={onOpenSession}
          />
        </TabsContent>
      )}

      {allowed.browser && (
        <TabsContent value="browser" className="flex min-h-0 flex-1 flex-col">
          {browser}
        </TabsContent>
      )}

      <TabsContent value="details" className="min-h-0 flex-1">
        <DetailsPanel
          thread={thread}
          lead={lead}
          folder={liveCwd ?? thread.ws?.cwd}
          branch={
            probe?.status?.branch ??
            work?.branch ??
            thread.ws?.branch ??
            thread.branch
          }
          startedAt={thread.replies[0]?.time}
        />
      </TabsContent>
    </Tabs>
  );
}
