import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Tabs, TabsContent } from "../components/ui/tabs";
import {
  diffCommentsMessage,
  diffSendRoute,
  useDiffComments,
} from "../lib/diff-comments";
import { plural, prettyPath } from "../lib/helpers";
import { patchWbCache } from "../lib/wb-probe-cache";
import type {
  Diff,
  EmpFn,
  Employee,
  HostAccessors,
  HumanFn,
  MergeMethod,
  OsApp,
  OsEditor,
  PullRequest,
  ShipBar,
  ShipHandlers,
  Thread,
  WbSpot,
  WbTab,
  Work,
} from "../types";
import { sessionArtifacts } from "./artifacts";
import { BackgroundPanel } from "./background-panel";
import { openPaths } from "./diff-view";
import { LivePreview, type LiveSurfaces, LiveTerminal } from "./live";
import { PlanPanel, threadPlans } from "./plan-panel";
import { PrFailure } from "./pr-failure";
import { PrPanel } from "./pr-panel";
import { SubagentsPanel, sessionSubagents } from "./subagents-panel";
import { useFileTree } from "./use-file-tree";
import { useShipBar } from "./use-ship-bar";
import { useTabFit } from "./use-tab-fit";
import { useWbProbe, WB_PR_SIG_MARK } from "./use-wb-probe";
import { WbEmpty } from "./wb-bits";
import { ChangesTab } from "./wb-changes";
import { DetailsPanel } from "./wb-details";
import { FilesTab } from "./wb-files";
import { IdlePreview, StepTerminal } from "./wb-surfaces";
import { TAB_ORDER, WbTabStrip } from "./wb-tab-strip";

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
  sendPending,
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
  /* `{error:true}` marks a failed action — the host toasts it with the
     destructive accent instead of a neutral note (#423). */
  say?: (t: string, opts?: { error?: boolean }) => void;
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
  /** A user send is relay-accepted but the feed hasn't surfaced a turn for
      it yet (#315's waiting tray). The ship bar hides Suggest across that
      gap — turn start lags the relay message that already renders (#396). */
  sendPending?: boolean;
  /** The engine declares `steer`: Send-to-agent labels the mid-turn route
      (issue #108); absent → plain "Send". */
  steer?: boolean;
  /* os.editors + a bound os.open (issue #110, same pair ThreadView takes):
     the caller probes `host.describe` — onOpenPath={null} means os.open was
     absent, so rows show no open menu even when the accessors object
     statically carries the method (D-#19). Undefined keeps the component's
     own host.osEditors/osOpen path (prototype). */
  editors?: OsEditor[];
  onOpenPath?: ((path: string, app: OsApp, line?: number) => void) | null;
  /** Stops a background process (issue #170); absent = no Stop button. */
  onStopJob?: (id: string) => void;
  /** This thread's own browser tabs (the LilOS Browser in thread mode,
      issue #214). When passed, the Preview tab becomes **Browser** and shows it. */
  browser?: React.ReactNode;
  /** Resolves employee helpers on the Subagents tab (#317); absent = no Subagents tab. */
  emp?: EmpFn;
  /** Opens an employee helper's own session from its Subagents row (issue #170). */
  onOpenSession?: (employeeId: string, session: string) => void;
  /** The session's `workbench_open` request (issue #340): the panel opens on
      the target's tab — a changed file's diff or a file view at its line,
      the changes view, the PR tab, the preview (a URL the caller navigates
      its Browser surface to), or an engine tab (#543's `tab` targets — the
      only kind a folderless session accepts). */
  spot?: WbSpot;
  /** Reports the settled tab set — null while the first probe is still in
      flight — so the caller can hide the toggle when there's nothing to
      show (D-#19, #543 AC-5). */
  onAllowed?: (tabs: WbTab[] | null) => void;
  /** Engine capability flags for the engine-owned tabs (#587 AC-1): the
      caller reads them off `describe` — `true` makes the tab a fixed
      member of the strip (greyed while empty), so content arriving only
      unmutes it, never moves it. Absent = content/emp fallback (mock). */
  caps?: { plan?: boolean; subagents?: boolean; background?: boolean };
  /** The commit-message Suggest (#584): a side ask the app forwards to
      the engine's `session.ask` — no transcript entry. Gets the checked
      file paths; resolves with the suggested message, which the bar
      writes into `message` through `onMessage`. */
  onSuggest?: (files: string[]) => Promise<string | void> | string | void;
  /** Live `forge.pr` truth reported upward (#579): the header's "PR #N"
      chip reads it, so a just-created or merged PR shows without waiting
      for the next `conversations.prs` refresh. */
  onPr?: (pr: PullRequest | null) => void;
  /** The commit → push → Create PR bar's mock seam (issue #107/#359): the
     prototype/app supplies state overrides + the action handlers here; a
     missing handler hides its control (D-#19). In live mode the same bar
     is built from the host's git.* + forge.* accessors instead. */
  ship?: Partial<ShipBar> & ShipHandlers;
}) {
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
  /* #108: pinned review comments on the Changes diff, keyed by session so
     tab switches and Focus remounts keep them (module store, D-#320
     rationale). `prune` re-runs whenever the shown diffs' patches move —
     resolved markers whose file changed drop off (AC-4), pending notes
     whose file or anchor vanished drop too. It only runs on real reads:
     live mode's `probe` is null until the first host read lands, and an
     empty list then would wipe every note on a panel remount. */
  const dc = useDiffComments(thread.session);
  const diffsReady = liveMode ? probe?.diffs != null : true;
  const diffsKey = diffsReady
    ? diffs.map((d) => `${d.path}\n${d.patch}`).join("\n\n")
    : null;
  useEffect(() => {
    if (diffsReady) dc.prune(diffs);
  }, [diffsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const pendingComments = dc.comments.filter((c) => !c.resolved);
  const sendComments = () => {
    if (!onSend || pendingComments.length === 0) return;
    const route = diffSendRoute(!!running, !!steer);
    const sent = dc.resolveAll(
      new Map(diffs.map((d) => [d.path, d.patch])),
      route,
    );
    onSend(diffCommentsMessage(sent));
    say?.(
      route === "steer"
        ? `Sent ${plural(sent.length, "comment")} — steered into the running turn`
        : route === "queue"
          ? `Sent ${plural(sent.length, "comment")} — queued as the next prompt`
          : `Sent ${plural(sent.length, "comment")} to the agent`,
    );
  };
  /* #340 AC-2b: the session's `workbench_open` — open the panel on the
     target's tab. A changed file shows its diff; an unchanged one opens the
     file view (at `line` when given). The URL's navigation is the caller's
     (its Browser surface) — here it only lands on the preview tab. Keyed on
     `at` so a repeated open of the same target re-fires. */
  const spotAt = spot?.at;
  useEffect(() => {
    if (!spot) return;
    const t = spot.target;
    if (t.tab !== undefined) {
      /* An engine tab (#543) — Subagents/Background/Plan exist with or
         without a folder. */
      setTab(t.tab);
      return;
    }
    if (t.file !== undefined) {
      const file = t.file;
      if (changed.has(file)) {
        setSel(file);
        setTab("changes");
        return;
      }
      setTab("files");
      if (host && liveCwd)
        void host
          .read(liveCwd, file)
          .then((r) => r && setViewFile({ path: file, ...r, line: t.line }));
      return;
    }
    if (t.diff === true) {
      setSel(t.path ?? null);
      setTab("changes");
      return;
    }
    setTab(t.pr === true ? "pr" : "preview");
  }, [spotAt]); // eslint-disable-line react-hooks/exhaustive-deps
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
  /* #547 AC-2: per-tab scroll offsets ride the cache entry — restored
     in a layout effect below (before paint) and re-applied while the
     tree window still grows, since rows mount under the scrollport. */
  const scrollsRef = useRef<Partial<Record<WbTab, number>>>(
    restored?.scrolls ?? {},
  );
  const wbRootRef = useRef<HTMLDivElement>(null);
  const cwd =
    work?.path ??
    (work?.branch ? `.lilos/wt/${work.ticket.toLowerCase()}` : "main");
  const shown = sel ? diffs.filter((d) => d.path === sel) : diffs;
  /* Which of the shown files start open (a huge working tree starts mostly
     collapsed — see `openPaths`). */
  const startOpen = useMemo(() => openPaths(shown), [shown]);

  /* PR tab (issue #37): in live mode the forge's answer is authoritative —
     `{pr}` shows it, `{pr:null}` shows a plain "no PR on this branch" state,
     `{error}` reads the `gh` failure plainly (#114 AC-5). A silent method
     (outer null) hides the tab. Without a host the session-carried
     thread.pr stays (mock). */
  const prShown = liveMode ? (probe?.pr?.pr ?? null) : thread.pr;
  const prError = liveMode ? probe?.pr?.error : undefined;
  const liveForge = liveMode && prShown != null && liveCwd != null;
  /* #579 AC-1: the live forge read is the header's "PR #N" truth — report
     it upward once the probe answers so a just-created/merged PR reaches
     the chip without a reload. An unanswered probe reports nothing. */
  const probePr = probe?.pr;
  useEffect(() => {
    if (!liveMode || !probePr) return;
    onPr?.(probePr.pr ?? null);
  }, [probePr, liveMode, onPr]);
  /* Tabs render only when their host method answered (#114 AC-6) — and the
     folder-bound ones only when the session has a folder (#543). Terminal /
     Preview are surface-bound, not folder-bound: they render wherever live
     surfaces (or the LilOS Browser) are wired (slice B, #119) — a live
     attach means a real host exists even when `work` doesn't.
     #587 AC-1 — the strip is a FIXED membership: the engine-owned tabs
     (Plan/Background/Subagents) gate on their declared capability (the
     caller's `caps`), never on content arriving; a capable-but-empty tab
     renders greyed (data-wb-empty) instead of popping in mid-session.
     Content still forces a tab on (a job/plan/helper that arrived on an
     engine which never declared it is shown rather than lost), and the
     folder tabs keep their answered-probe / has-folder gating. */
  const changesOn = liveMode ? probe?.diffs != null : !folderless;
  const filesOn = liveMode ? probe?.files != null : !folderless;
  const surfacesOn = live != null || (!liveMode && !folderless);
  const previewOn = surfacesOn;
  /* The thread's own browser sits on its own tab (next to Preview), not in
     place of it — the dev-server preview stays reachable on desktop. */
  const browserOn = !!browser;
  const prOn = liveMode ? probe?.pr != null : !folderless;
  const bgOn =
    (caps ? !!caps.background : !folderless || !!emp || onStopJob != null) ||
    jobs.length > 0;
  /* A `?tab=subagents` deep link lands on the tab's empty state on a
     capable session (#319) — covered by the capability flag itself. */
  const subOn = (caps ? !!caps.subagents : !!emp) || helpers.length > 0;
  const planOn = (caps ? !!caps.plan : isDM && !!emp) || plans.length > 0;
  /* Greyed-while-empty markers (#587 AC-1): the tab stays put and clickable
     — its empty state is the "nothing yet" answer (the `data-wb-empty`
     triggers below). */
  const allowed: Record<WbTab, boolean> = {
    changes: changesOn,
    files: filesOn,
    terminal: surfacesOn,
    preview: previewOn,
    browser: browserOn,
    background: bgOn,
    subagents: subOn,
    plan: planOn,
    pr: prOn,
    /* Details reads only what the thread carries, so it is always there —
       but it never counts as "something to show": the toggle and the
       "nothing to show" line gate on the tabs above (D-#19, #543 AC-5). */
    details: true,
  };
  /* Reports the settled tab set so the caller can hide the toggle when
     there's nothing to show (D-#19, #543 AC-5); null = still probing —
     the first full read round hasn't landed (a cache hit counts). */
  const probing = liveMode && !firstSettled;
  const allowedKey = TAB_ORDER.filter(
    (t) => t !== "details" && allowed[t],
  ).join(",");
  useEffect(() => {
    onAllowed?.(
      probing ? null : (allowedKey.split(",").filter(Boolean) as WbTab[]),
    );
  }, [allowedKey, probing, onAllowed]);
  /* The caller's tab choice yields to availability: when its method never
     answers the first allowed tab shows instead. */
  const shownTab = allowed[tab]
    ? tab
    : (
        [
          "changes",
          "files",
          "pr",
          "terminal",
          "preview",
          "browser",
          "subagents",
          "background",
          "plan",
        ] as WbTab[]
      ).find((t) => allowed[t]);
  useLayoutEffect(() => {
    if (!liveMode || !host || !liveCwd || !shownTab) return;
    const holder = wbRootRef.current?.querySelector(
      `[data-wb-scroll="${shownTab}"]`,
    );
    const vp = holder?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!vp) return;
    const saved = scrollsRef.current[shownTab];
    if (saved) vp.scrollTop = saved;
    const t = shownTab;
    const onScroll = () => {
      scrollsRef.current[t] = vp.scrollTop;
      patchWbCache(host, liveCwd, (e) => ({
        ...e,
        scrolls: { ...e.scrolls, [t]: vp.scrollTop },
      }));
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => vp.removeEventListener("scroll", onScroll);
  }, [shownTab, liveMode, liveCwd, host, fileTree.win]);
  /* #429 AC-2: landing on the PR tab signals a fresh forge read — the
     scheduler coalesces repeat visits (and the OS-window-focus signal)
     into one `gh` call. */
  const prTabShown = shownTab === "pr";
  const wasPrTab = useRef(false);
  useEffect(() => {
    const became = prTabShown && !wasPrTab.current;
    wasPrTab.current = prTabShown;
    if (became) prPoll.current?.signal();
  }, [prTabShown]);

  const ghError = (e: unknown) =>
    (e instanceof Error ? e.message : String(e)).slice(0, 160);
  /* One bound "open this path" for every workbench surface: `line` opens at
     the diff row's new-file line when the editor takes one; "finder" reveals. */
  const openPath = useMemo(
    () =>
      onOpenPath && liveCwd
        ? (path: string, app: OsApp, line?: number) =>
            onOpenPath(path, app, line)
        : onOpenPath === undefined && host?.osOpen && liveCwd
          ? (path: string, app: OsApp, line?: number) => {
              void host
                .osOpen?.(liveCwd, path, app, line)
                .catch((e) =>
                  say?.(`Open failed — ${ghError(e)}`, { error: true }),
                );
            }
          : undefined,
    [onOpenPath, liveCwd, host, say],
  );
  const treeOpenPath = useMemo(
    () =>
      openPath
        ? { editors, onOpen: (p: string, app: OsApp) => openPath(p, app) }
        : undefined,
    [openPath, editors],
  );

  const prComment =
    liveForge && host?.prComment && liveCwd
      ? async (t: string) => {
          try {
            await host.prComment?.(liveCwd, t);
            await reloadPr();
            say?.("Comment posted via gh");
          } catch (e) {
            say?.(`Comment failed — ${ghError(e)}`, { error: true });
          }
        }
      : onPrComment;
  const prMerge =
    liveForge && host?.prMerge && liveCwd
      ? async (m: MergeMethod) => {
          try {
            const pr = await host.prMerge?.(liveCwd, m);
            if (pr) landPr({ pr });
            if (pr?.status === "merged")
              say?.(
                `Merged #${pr.number} into ${pr.base} · gh pr merge --${m}`,
              );
            else
              say?.(`gh pr merge returned but the PR is ${pr?.status}`, {
                error: true,
              });
          } catch (e) {
            say?.(`Merge failed — ${ghError(e)}`, { error: true });
          }
        }
      : onPrMerge;

  /* Fold/scroll fit of the tab strip (issue #326) — see `useTabFit`. */
  const listRef = useTabFit(shownTab);

  /* First round still in flight on a cold mount → hold the aside (a
     cache hit skips this — its rows paint the first frame, #544); a
     settled round with no answered method gets one plain line instead
     of an empty tab strip. `pr` is not in the round — `gh` never gates
     this wait (AC-2). */
  if (liveMode && !firstSettled) {
    return (
      <div
        data-wb-probing
        className="flex min-h-0 flex-1 items-center justify-center gap-1.5 p-6 text-center text-muted-foreground text-xs"
      >
        Reading <span className="font-mono">{prettyPath(cwd)}</span>…
      </div>
    );
  }
  if (
    !changesOn &&
    !filesOn &&
    !previewOn &&
    !prOn &&
    !bgOn &&
    !subOn &&
    !planOn
  ) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-muted-foreground text-xs">
        {folderless ? (
          <p>
            Nothing to show — a process, helper or plan lists here once the
            session has one.
          </p>
        ) : (
          <p>
            Nothing to show — the host has no answer for{" "}
            <span className="font-mono">{prettyPath(cwd)}</span>.
          </p>
        )}
      </div>
    );
  }

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
          pendingCount={pendingComments.length}
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
        {live ? (
          <LiveTerminal live={live} cwd={cwd} agentName={lead?.name} />
        ) : (
          <StepTerminal
            output={a.termOut}
            running={a.termRunning}
            cwd={cwd}
            readOnly={!work?.branch}
          />
        )}
      </TabsContent>

      <TabsContent value="preview" className="flex min-h-0 flex-1 flex-col">
        {live ? (
          <LivePreview live={live} />
        ) : (
          <IdlePreview
            cwd={cwd}
            employeeName={lead?.name}
            onReload={say && (() => say("Reload (prototype)"))}
            onAskDevServer={
              onSend &&
              (() =>
                onSend(
                  "Start the dev server in the background and give me the URL",
                ))
            }
          />
        )}
      </TabsContent>

      {prOn && (
        <TabsContent
          value="pr"
          className="min-h-0 flex-1"
          data-pr-sig-mark={WB_PR_SIG_MARK ? prSigMark : undefined}
        >
          {prShown ? (
            <PrPanel
              pr={prShown}
              diffs={diffs}
              commits={a.commits}
              lead={lead}
              human={human}
              onComment={prComment}
              onMerge={prMerge}
              say={say}
            />
          ) : prError ? (
            /* `gh` failed — plain copy per reason with one next step; raw
               stderr stays behind Details (#114 AC-5). */
            <PrFailure
              error={prError}
              onRetry={reloadPr}
              employeeName={lead?.name}
            />
          ) : (
            <WbEmpty>
              No pull request on{" "}
              <span className="font-mono">
                ⎇ {probe?.pr?.branch || work?.branch || "this branch"}
              </span>{" "}
              yet.
            </WbEmpty>
          )}
        </TabsContent>
      )}

      {bgOn && (
        <TabsContent value="background" className="min-h-0 flex-1">
          <BackgroundPanel jobs={jobs} onStop={onStopJob} />
        </TabsContent>
      )}

      {plan && (
        <TabsContent value="plan" className="min-h-0 flex-1">
          <PlanPanel plans={plans} />
        </TabsContent>
      )}

      {subOn && emp && (
        <TabsContent value="subagents" className="min-h-0 flex-1">
          <SubagentsPanel
            thread={thread}
            emp={emp}
            onOpenSession={onOpenSession}
          />
        </TabsContent>
      )}

      {browserOn && (
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
