import {
  CircleDotIcon,
  CpuIcon,
  EyeIcon,
  FileDiffIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
  GlobeIcon,
  ListChecksIcon,
  MessageSquareTextIcon,
  NetworkIcon,
  PanelRightCloseIcon,
  PlayIcon,
  RefreshCcwIcon,
  SendIcon,
  SquareTerminalIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { Checkbox } from "../components/ui/checkbox";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
import {
  diffCommentsMessage,
  diffSendRoute,
  useDiffComments,
} from "../lib/diff-comments";
import { draftKey, useDraft } from "../lib/drafts";
import { plural, prettyPath } from "../lib/helpers";
import {
  EMPTY_WB_PROBE,
  patchWbCache,
  readWbCache,
  type WbProbeData,
  type WbViewFile,
} from "../lib/wb-probe-cache";
import type {
  Diff,
  EmpFn,
  Employee,
  GitCommit,
  HostAccessors,
  HumanFn,
  MergeMethod,
  OsApp,
  OsEditor,
  PullRequest,
  ShipBar,
  ShipBusy,
  ShipError,
  ShipHandlers,
  Thread,
  WbSpot,
  WbTab,
  Work,
} from "../types";
import type { TreeNode } from "./artifacts";
import {
  buildTree,
  countTreeRows,
  sessionArtifacts,
  windowedTreePaths,
} from "./artifacts";
import { BackgroundPanel } from "./background-panel";
import { CommitBar } from "./commit-bar";
import { DiffView } from "./diff-view";
import { TreeNodes } from "./file-tree-nodes";
import { LivePreview, type LiveSurfaces, LiveTerminal } from "./live";
import { OpenPathButton } from "./open-path";
import { PlanPanel, threadPlans } from "./plan-panel";
import { PrFailure } from "./pr-failure";
import { PrPanel } from "./pr-panel";
import { createPrPoll, type PrPoll } from "./pr-poll";
import { SubagentsPanel, sessionSubagents } from "./subagents-panel";

/* When the tab strip runs out of room, labels fold to icons least-used first —
   the situational tabs (Background, Subagents, Plan, PR) before the working set
   (Files, Preview, Terminal, Changes). The active tab always keeps its label;
   only when even icons overflow does the strip scroll (issue #326). */
const NO_DIFFS: Diff[] = [];

const COMPACT_ORDER: WbTab[] = [
  "background",
  "subagents",
  "plan",
  "pr",
  "preview",
  "files",
  "terminal",
  "changes",
];

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
  /* #543: the Workbench exists for EVERY session — a DM session started
     with no folder (`work` null) still gets the engine tabs; the
     folder-bound ones (Changes/Files/Terminal/Preview/PR) stay hidden
     (D-#19 per tab). A channel thread (`isDM` false, read-only — the app
     never Focuses one) keeps its mock tabs. */
  const folderless = work == null && isDM;
  /* #544: the per-folder cache (host+cwd) keeps the last-known reads
     outside this component — a remount after a panel close, an Esc out of
     Focus or a session switch paints them on the first frame while the
     mount's fresh round revalidates behind (stale-while-revalidate).
     `firstSettled` is the probe/report gate ("still probing" = the first
     full read round hasn't landed; a cache hit counts as a landed set);
     `revalidating` drives the "updating…" cue — only ever true when
     cached rows showed before the fresh round settled. */
  const [restored] = useState(() =>
    liveMode && host ? readWbCache(host, liveCwd) : undefined,
  );
  const [sel, setSel] = useState<string | null>(restored?.sel ?? null);
  const [viewFile, setViewFile] = useState<WbViewFile | null>(
    restored?.viewFile ?? null,
  );
  /* `probe` fields: files/diffs feed the Files/Changes tabs; status null =
     not a repo (AC-6 hides the ship bar); branches carries the remote
     default for the branch-name ask; log feeds Commits + the PR prefill. */
  const [probe, setProbe] = useState<WbProbeData | null>(
    restored?.probe ?? null,
  );
  /* #685: the last answer each probe key actually landed (cache-seeded) —
     a live read that answers nothing keeps it instead of blanking the
     panel it gates. Lives in a ref: `merge` runs inside an effect whose
     closure re-seats on every `running` flip. `nullStreak` bounds the
     keep: one flap rides last-known, a second consecutive null lands so
     a folder that stays gone still hides its tabs. */
  const landedProbe = useRef<Partial<WbProbeData>>({
    ...(restored?.probe ?? {}),
  });
  const landedCwd = useRef(liveCwd);
  const nullStreak = useRef<Partial<Record<keyof WbProbeData, number>>>({});
  const [firstSettled, setFirstSettled] = useState(restored != null);
  const [revalidating, setRevalidating] = useState(restored != null);
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
    if (r) {
      patchWbCache(host, liveCwd, (e) => ({
        ...e,
        probe: { ...e.probe, pr: r },
        updatedAt: Date.now(),
      }));
      setProbe((p) => (p ? { ...p, pr: r } : p));
    }
  };
  /* Which host methods exist — the ship bar's controls render only for the
     ones in this set (D-#19, AC-6); null while host.describe hasn't answered. */
  const [shipMethods, setShipMethods] = useState<Set<string> | null>(null);
  useEffect(() => {
    let off = false;
    if (liveMode && host?.methods) {
      void host
        .methods()
        .then((m) => !off && setShipMethods(m))
        .catch(() => {});
    } else setShipMethods(null);
    return () => {
      off = true;
    };
  }, [liveMode, host]);
  const shipHas = (m: string) => shipMethods?.has(m) ?? false;
  // Read the session folder live. While a turn runs the agent is editing —
  // a short poll keeps Changes/Files/Commits current (#114 AC-3, #107 AC-5);
  // the effect's re-run on `running` flips lands a fresh read at turn end.
  const updateProbe = useRef<(() => Promise<void>) | null>(null);
  const prPoll = useRef<PrPoll | null>(null);
  /* A different folder under the same mount drops folder-scoped state
     (open file view, selected change). #547 AC-4: the reset must NOT
     reach the NEW folder's cache entry — the write-back would push the
     outgoing selection (then the reset nulls) into it, erasing its own
     cached selection. `skipFolderWrites` counts the commits to skip: this
     one plus, when there was state to reset, the one the reset queues. */
  const prevCwd = useRef(liveCwd);
  const selRef = useRef(sel);
  selRef.current = sel;
  const viewFileRef = useRef(viewFile);
  viewFileRef.current = viewFile;
  const skipFolderWrites = useRef(0);
  useEffect(() => {
    if (prevCwd.current === liveCwd) return;
    prevCwd.current = liveCwd;
    skipFolderWrites.current =
      selRef.current != null || viewFileRef.current != null ? 2 : 1;
    setViewFile(null);
    setSel(null);
  }, [liveCwd]);
  useEffect(() => {
    if (!liveMode || !host || !liveCwd) {
      setProbe(null);
      return;
    }
    const cwd = liveCwd;
    let off = false;
    /* A folder switch under one mount drops the outgoing folder's lands —
       its answers mustn't keep the NEW folder's first-read nulls from
       landing (a dead folder still hides its tabs). Late lands from the
       stale run are guarded out of the keep bookkeeping below (their
       `patchWbCache` write stays — it lands on the right folder's entry). */
    if (landedCwd.current !== cwd) {
      landedCwd.current = cwd;
      landedProbe.current = {};
      nullStreak.current = {};
    }
    /* #544: reads land independently — every merge also writes the
       per-folder cache, so a land that resolves after unmount still warms
       the next mount's first frame. `pr` stays on the #429 funnel below:
       its ~1s `gh` subprocess never gates the folder tabs (AC-2). */
    /* #685: `files`/`diffs` gate their panels — a read that answers nothing
       (a transient fs/git failure; the accessor collapses errors to null)
       must NOT overwrite a landed answer. A null flap unmounts the panel —
       its scroll offset dies with the viewport — and poisons the folder
       cache (`files` null reads as "never answered", so the whole entry —
       scrolls, selection, picked tab — misses on the next mount). Same
       keep-last-known rule `forge.pr` follows below; a null FIRST read
       still lands so a dead folder hides its tab as before. */
    const merge = (patch: Partial<WbProbeData>) => {
      if (landedCwd.current === cwd) Object.assign(landedProbe.current, patch);
      patchWbCache(host, cwd, (e) => ({
        ...e,
        probe: { ...e.probe, ...patch },
        updatedAt: Date.now(),
      }));
      if (!off) setProbe((p) => ({ ...(p ?? EMPTY_WB_PROBE), ...patch }));
    };
    const keepLastKnown = (key: keyof WbProbeData) => {
      if (
        (key !== "files" && key !== "diffs") ||
        landedCwd.current !== cwd ||
        landedProbe.current[key] == null
      )
        return false;
      const streak = nullStreak.current[key] ?? 0;
      nullStreak.current[key] = streak + 1;
      return streak === 0;
    };
    const land = <K extends keyof WbProbeData>(
      key: K,
      read: Promise<WbProbeData[K] | null> | undefined,
    ) =>
      (read ?? Promise.resolve(null))
        .then((v) => {
          if (v != null) {
            if (
              (key === "files" || key === "diffs") &&
              landedCwd.current === cwd
            )
              nullStreak.current[key] = 0;
          } else if (keepLastKnown(key)) return;
          merge({ [key]: v ?? null } as Partial<WbProbeData>);
        })
        .catch(() => {
          if (keepLastKnown(key)) return;
          merge({ [key]: null } as Partial<WbProbeData>);
        });
    const round = () =>
      Promise.all([
        land("files", host.tree(cwd)),
        land("diffs", host.diff(cwd)),
        land("status", host.status?.(cwd)),
        land("branches", host.branches?.(cwd)),
        land("log", host.log?.(cwd)),
      ]);
    const updatePr = () =>
      host.pr?.(cwd)?.then((r) => {
        /* An unanswered `forge.pr` (outer null — unreachable, not "no
           PR") keeps the last known answer. */
        if (r) merge({ pr: r });
      });
    const poll = createPrPoll(() => updatePr());
    prPoll.current = poll;
    updateProbe.current = () => {
      poll.signal();
      return round().then(() => {});
    };
    /* The mount round revalidates behind whatever the cache painted;
       the report (`onAllowed`) holds until this first full round lands. */
    void round().then(() => {
      if (off) return;
      setFirstSettled(true);
      setRevalidating(false);
    });
    poll.signal(); // the initial `forge.pr` read through the same funnel
    poll.setRunning(!!running);
    const onWindowFocus = () => poll.signal();
    window.addEventListener("focus", onWindowFocus);
    const gitPoll = running ? setInterval(round, 3000) : undefined;
    /* A cached open file view re-reads behind — it stays open on
       last-known content until the fresh read lands (AC-4). */
    if (restored?.viewFile) {
      const p = restored.viewFile.path;
      void host
        .read(cwd, p)
        .then(
          (r) =>
            !off &&
            r &&
            setViewFile((v) => (v?.path === p ? { path: p, ...r } : v)),
        )
        .catch(() => {});
    }
    return () => {
      updateProbe.current = null;
      prPoll.current = null;
      poll.dispose();
      off = true;
      window.removeEventListener("focus", onWindowFocus);
      if (gitPoll) clearInterval(gitPoll);
    };
  }, [liveMode, liveCwd, running, host, restored]);
  /* The open file view + selected change + picked tab are folder state —
     write them back so a panel close/reopen (or a Focus remount, #547
     AC-1) restores them (AC-4). Skipped while a folder switch resets
     them (#547 AC-4). */
  useEffect(() => {
    if (!liveMode || !host || !liveCwd) return;
    if (skipFolderWrites.current > 0) {
      skipFolderWrites.current -= 1;
      return;
    }
    patchWbCache(host, liveCwd, (e) => ({ ...e, sel, viewFile, tab }));
  }, [sel, viewFile, tab, liveMode, liveCwd, host]);
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

  /* ── Ship bar state (issue #107/#359) — the app owns it; the bar is
     presentational. `unchecked` keys on Diff.path: all checked by default. */
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  /* The commit-message box is a `lilos:` draft keyed on the session (#584
     AC-2): a Suggest answer (or typed text) survives a reload exactly like
     a composer draft. */
  const [commitMsg, setCommitMsg] = useDraft(
    thread.session ? draftKey.commit(thread.session) : undefined,
  );
  const [shipBusy, setShipBusy] = useState<ShipBusy>(null);
  const [shipError, setShipError] = useState<ShipError | null>(null);
  /* Upstream a push in this view landed on — the bar's ↑ chip (issue #393
     AC-6; a fresh mount leaves the chip off until the next push). */
  const [pushedUp, setPushedUp] = useState<string | null>(null);
  const checkedPaths = diffs
    .map((d) => d.path)
    .filter((p) => !unchecked.has(p));
  const toggleFile = (path: string, on: boolean) =>
    setUnchecked((s) => {
      const n = new Set(s);
      if (on) n.delete(path);
      else n.add(path);
      return n;
    });
  const shipErrorOf = (e: unknown): ShipError => {
    const d = (
      e as { data?: { reason?: ShipError["reason"]; detail?: string } }
    )?.data;
    return {
      reason: d?.reason,
      detail: d?.detail,
      text: e instanceof Error ? e.message : String(e),
    };
  };
  /* Runs a ship action: busy + error state, then a probe refresh so the list
     / Commits / PR tab reflect the write without waiting for a turn flip.
     The action's own value (e.g. a Suggest answer) is returned to the bar. */
  const shipCall = async <T,>(
    stage: ShipBusy,
    fn: () => Promise<T>,
  ): Promise<T> => {
    setShipBusy(stage);
    setShipError(null);
    try {
      const v = await fn();
      await updateProbe.current?.();
      return v;
    } catch (e) {
      setShipError(shipErrorOf(e));
      throw e;
    } finally {
      setShipBusy(null);
    }
  };
  /* #584: Suggest is a side ask, not a send — the app forwards it to the
     engine's `session.ask`; shipCall's funnel gives it the same busy/error
     surface as the other actions. */
  const suggest =
    onSuggest != null
      ? () =>
          shipCall("suggest", () => Promise.resolve(onSuggest(checkedPaths)))
      : undefined;

  /* Live-mode ship handlers — one per host method that answered (D-#19). */
  const liveShip: ShipHandlers = {};
  if (liveMode && host && liveCwd) {
    const cwd = liveCwd;
    if (shipHas("git.commit") && host.commit) {
      liveShip.onCommit = (files, message) =>
        shipCall("commit", async () => {
          await host.commit?.(cwd, files, message);
          setCommitMsg("");
          setUnchecked(new Set());
        });
    }
    if (shipHas("git.push") && host.push) {
      const push = host.push;
      liveShip.onPush = () =>
        shipCall("push", async () => {
          setPushedUp((await push(cwd)).upstream);
        });
    }
    /* #393 AC-5: git.pull (`pull --ff-only`) is the fix the rejected-push
       copy names; a diverged history surfaces its typed reason plainly. */
    if (shipHas("git.pull") && host.pull) {
      const pull = host.pull;
      liveShip.onPull = () => shipCall("pull", () => pull(cwd));
    }
    if (onSend != null) {
      liveShip.onAskAgent = () =>
        onSend(
          `The push was rejected — the remote has newer commits on ${probe?.status?.branch ?? "this branch"}. Please update the branch with the remote's latest commits, then push again.`,
        );
    }
    if (suggest != null) liveShip.onSuggest = suggest;
    if (shipHas("forge.create") && host.prCreate) {
      liveShip.onCreatePr = (p) =>
        shipCall("pr", async () => {
          /* On the default branch the form supplied a new branch name —
             branch first (carrying the commits), then push, then create. */
          if (p.branch) {
            if (!(shipHas("git.createBranch") && host.createBranch)) {
              throw new Error(
                "this host can't create branches — git.createBranch is not advertised",
              );
            }
            await host.createBranch(cwd, p.branch);
          }
          if (shipHas("git.push") && host.push)
            setPushedUp((await host.push(cwd)).upstream);
          await host.prCreate?.(cwd, {
            title: p.title,
            body: p.body,
            base: probe?.branches?.default ?? undefined,
          });
          /* No extra re-read: shipCall's trailing `update()` lands the
             fresh PR, and landing on the PR tab signals its own read —
             a reloadPr here would double-call `gh pr view` (#429). */
          setTab("pr");
        });
    }
  }

  /* Commits for the Commits section + PR prefill: the live `git.log`
     supersedes step-derived commits once it answers (AC-5); a mock
     override arrives via `ship.commits`. */
  const liveCommits: GitCommit[] = liveMode
    ? (probe?.log ?? a.commits)
    : (ship?.commits ?? a.commits);

  const shipBar: (ShipBar & ShipHandlers) | null = (() => {
    const shipFiles = diffs.map((d) => ({
      path: d.path,
      checked: !unchecked.has(d.path),
    }));
    if (liveMode) {
      /* AC-6: only in a repo (status answered) and only where a handler
         exists — a partial host surfaces just the controls it supports. */
      if (probe?.status == null) return null;
      if (!liveShip.onCommit && !liveShip.onPush && !liveShip.onCreatePr) {
        return null;
      }
      return {
        isRepo: true,
        branch: probe.status.branch,
        defaultBranch: probe.branches?.default ?? null,
        remote: probe.branches?.remote ?? null,
        files: shipFiles,
        commits: liveCommits,
        message: commitMsg,
        busy: shipBusy,
        error: shipError,
        running: !!running || !!sendPending,
        upstream: pushedUp,
        employeeName: lead?.name,
        onMessage: setCommitMsg,
        onSuggest: suggest,
        ...liveShip,
      };
    }
    /* #393 AC-7: a read-only thread (no session folder yet) with no
       changes keeps Start work as the single path — no dead ship bar. */
    if (!work && diffs.length === 0) return null;
    if (!ship) return null;
    return {
      isRepo: ship.isRepo ?? true,
      branch: ship.branch ?? work?.branch ?? null,
      defaultBranch: ship.defaultBranch ?? null,
      remote: ship.remote,
      files: shipFiles,
      commits: ship.commits ?? a.commits,
      message: commitMsg,
      busy: shipBusy,
      error: shipError,
      running: !!running || !!sendPending,
      upstream: ship.upstream ?? null,
      accessory: ship.accessory,
      employeeName: ship.employeeName ?? lead?.name,
      onMessage: setCommitMsg,
      onSuggest:
        (ship.onSuggest &&
          (() =>
            shipCall("suggest", () => Promise.resolve(ship.onSuggest!())))) ??
        suggest,
      onCommit: ship.onCommit
        ? (files, message) =>
            shipCall("commit", async () => {
              await ship.onCommit!(files, message);
              setCommitMsg("");
              setUnchecked(new Set());
            })
        : undefined,
      onPush: ship.onPush
        ? () => shipCall("push", () => ship.onPush!())
        : undefined,
      onPull: ship.onPull
        ? () => shipCall("pull", () => ship.onPull!())
        : undefined,
      onAskAgent:
        ship.onAskAgent ??
        (onSend
          ? () =>
              onSend(
                "The push was rejected — the remote has newer commits on this branch. Please update the branch with the remote's latest commits, then push again.",
              )
          : undefined),
      onCreatePr: ship.onCreatePr
        ? (p) => shipCall("pr", () => ship.onCreatePr!(p))
        : undefined,
    };
  })();
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
  const fileList = useMemo(
    () => [
      ...new Set([...(probe?.files ?? repoFiles ?? []), ...changed.keys()]),
    ],
    [probe?.files, repoFiles, changed],
  );
  const tree = useMemo(() => buildTree(fileList), [fileList]);
  /* #547 AC-5: a big repo's tree mounts in slices — the first ~160 rows
     paint on the first frame (reopen→row <50 ms on repos like LilOS
     itself, measured 114 ms before), the rest lands over the next frames
     instead of one ~100 ms commit. -1 = fully revealed. */
  const [treeWin, setTreeWin] = useState(160);
  const treeRows = countTreeRows(tree);
  /* The window is a pure Set of paths — computed per render, checked by
     membership — because a mutable counter in render is drained twice by
     StrictMode's double-invoke and the tree comes out empty (#547). */
  const treeIncluded = useMemo(
    () => windowedTreePaths(tree, treeWin),
    [tree, treeWin],
  );
  useLayoutEffect(() => {
    if (treeWin < 0 || treeWin >= treeRows) return;
    const id = window.requestAnimationFrame(() =>
      setTreeWin((n) => (n + 500 >= treeRows ? -1 : n + 500)),
    );
    return () => cancelAnimationFrame(id);
  }, [treeWin, treeRows]);
  /* #547 AC-2: per-tab scroll offsets ride the cache entry — restored
     in a layout effect below (before paint) and re-applied while the
     tree window still grows, since rows mount under the scrollport. */
  const scrollsRef = useRef<Partial<Record<WbTab, number>>>(
    restored?.scrolls ?? {},
  );
  const wbRootRef = useRef<HTMLDivElement>(null);
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
  const dirs = useMemo(() => {
    const out = new Set<string>();
    const walk = (n: TreeNode) => {
      for (const c of n.children.values())
        if (c.children.size > 0) {
          out.add(c.path);
          walk(c);
        }
    };
    walk(tree);
    return out;
  }, [tree]);
  /* Stable row-select — the FileTree context value memoizes on it, so a
     fresh closure per render would re-render every row consumer (#547). */
  const onTreeSelect = useCallback(
    (p: string) => {
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
        void host
          .read(liveCwd, p)
          .then((r) =>
            setViewFile(
              r
                ? { path: p, ...r }
                : { path: p, content: "", binary: true, truncated: false },
            ),
          );
      } else say?.(`${p} · unchanged in this thread`);
    },
    [dirs, changed, host, liveCwd, say],
  );
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
  const previewOn = surfacesOn || !!browser;
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
    background: bgOn,
    subagents: subOn,
    plan: planOn,
    pr: prOn,
  };
  /* Reports the settled tab set so the caller can hide the toggle when
     there's nothing to show (D-#19, #543 AC-5); null = still probing —
     the first full read round hasn't landed (a cache hit counts). */
  const probing = liveMode && !firstSettled;
  const allowedKey = (Object.keys(allowed) as WbTab[])
    .filter((t) => allowed[t])
    .join(",");
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
  }, [shownTab, liveMode, liveCwd, host, treeWin]);
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
            if (pr) {
              patchWbCache(host, liveCwd, (e) => ({
                ...e,
                probe: { ...e.probe, pr: { pr } },
                updatedAt: Date.now(),
              }));
              setProbe((p) => (p ? { ...p, pr: { pr } } : p));
            }
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

  /* Tab strip fit (issue #326): when the strip can't show every label, tabs
     fold to icon + count — least-used first, the active tab never. When even
     all-icons overflows, the strip scrolls left-anchored with an edge fade
     and the active tab scrolls into view. Fold/scroll apply imperatively
     inside this layout pass (`.wb-fold` class + a11y attrs, mask on the
     list), so no intermediate committed frame can carry a clipped tab. */
  const listRef = useRef<HTMLDivElement | null>(null);
  const stepRef = useRef<() => void>(() => {});
  const maskRef = useRef<() => void>(() => {});
  /* Attached once, the first time the list exists — re-created only if the
     list element itself is replaced. */
  const fitRef = useRef<{
    ro: ResizeObserver;
    el: HTMLElement;
    onScroll: () => void;
  } | null>(null);
  /* Each tab's label width + its flex gap, cached while expanded — folding a
     tab saves exactly its own measured label. */
  const labelsRef = useRef(new Map<WbTab, number>());
  /* Scroll-into-view fires on entering scroll mode or switching the active
     tab — not on every layout pass, so a manual scroll isn't snapped back. */
  const scrolledForRef = useRef<WbTab | null>(null);
  useLayoutEffect(() => {
    const el = listRef.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const px = (s: string) => {
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : 0;
    };
    /* Fade whichever edge hides overflowed tabs; solid where content fits. */
    const updateMask = () => {
      if (!el.classList.contains("wb-scroll")) {
        el.style.maskImage = "";
        return;
      }
      const l = el.scrollLeft > 2;
      const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      const stops: string[] = l ? ["transparent", "#000 24px"] : ["#000 24px"];
      stops.push(`#000 calc(100% - ${r ? 24 : 0}px)`);
      if (r) stops.push("transparent");
      el.style.maskImage = `linear-gradient(to right, ${stops.join(", ")})`;
    };
    const step = () => {
      const trigs = new Map<WbTab, HTMLElement>();
      for (const t of el.querySelectorAll<HTMLElement>("[data-wb-tab]"))
        if (t.dataset.wbTab) trigs.set(t.dataset.wbTab as WbTab, t);
      const labels = labelsRef.current;
      for (const [t, trg] of trigs) {
        const sp = trg.querySelector<HTMLElement>("[data-wb-label]");
        if (sp && sp.offsetWidth > 0) labels.set(t, sp.offsetWidth + 6);
      }
      const widthOf = (t: WbTab, folded: boolean) => {
        const trg = trigs.get(t)!;
        const lw = labels.get(t) ?? 60;
        const full = trg.classList.contains("wb-fold")
          ? trg.offsetWidth + lw
          : trg.offsetWidth;
        return folded ? full - lw : full;
      };
      const ps = getComputedStyle(parent);
      const ls = getComputedStyle(el);
      /* Free room the strip may still grow into: the parent's content box
         minus siblings (the close button), gaps, and the list's own chrome —
         padding included, which is what the triggers' content box sees. */
      const avail =
        parent.clientWidth -
        px(ps.paddingLeft) -
        px(ps.paddingRight) -
        px(ps.columnGap) * (parent.children.length - 1) -
        [...parent.children].reduce(
          (w, c) => (c === el ? w : w + (c as HTMLElement).offsetWidth),
          0,
        ) -
        (el.offsetWidth - el.clientWidth) -
        px(ls.paddingLeft) -
        px(ls.paddingRight);
      let total =
        [...trigs.keys()].reduce((w, t) => w + widthOf(t, false), 0) +
        px(ls.columnGap) * Math.max(trigs.size - 1, 0);
      const next = new Set<WbTab>();
      for (const t of COMPACT_ORDER) {
        if (total <= avail + 1) break;
        if (t === shownTab || !trigs.has(t)) continue;
        next.add(t);
        total -= widthOf(t, false) - widthOf(t, true);
      }
      const fits = total <= avail + 1;
      el.classList.toggle("wb-scroll", !fits);
      updateMask();
      for (const [t, trg] of trigs) {
        const fold = next.has(t);
        trg.classList.toggle("wb-fold", fold);
        const name = trg.dataset.wbName ?? "";
        if (fold) {
          /* aria-label replaces the subtree — keep the visible count in it. */
          const badge = trg.querySelector<HTMLElement>(
            "[data-bg-running],[data-subagents-running]",
          );
          trg.setAttribute(
            "aria-label",
            badge ? `${name} ${badge.textContent?.trim()}` : name,
          );
          trg.title = name;
        } else {
          trg.removeAttribute("aria-label");
          trg.removeAttribute("title");
        }
      }
      /* Scroll mode: keep the active tab in view — on entering scroll or on
         tab switch only, so a manual scroll sticks. */
      if (!fits && shownTab) {
        if (scrolledForRef.current !== shownTab) {
          trigs
            .get(shownTab)
            ?.scrollIntoView({ inline: "nearest", block: "nearest" });
          scrolledForRef.current = shownTab;
        }
      } else {
        scrolledForRef.current = null;
      }
    };
    stepRef.current = step;
    maskRef.current = updateMask;
    step();
    if (fitRef.current?.el !== el) {
      fitRef.current?.ro.disconnect();
      fitRef.current?.el.removeEventListener("scroll", fitRef.current.onScroll);
      const onScroll = () => maskRef.current();
      const ro = new ResizeObserver(() => stepRef.current());
      ro.observe(parent);
      ro.observe(el);
      el.addEventListener("scroll", onScroll);
      fitRef.current = { ro, el, onScroll };
    }
  });
  useEffect(
    () => () => {
      fitRef.current?.ro.disconnect();
      fitRef.current?.el.removeEventListener("scroll", fitRef.current.onScroll);
      fitRef.current = null;
    },
    [],
  );
  const wbTab = (t: WbTab, label: string) =>
    ({ "data-wb-tab": t, "data-wb-name": label }) as const;
  const wbLabel = (label: string) => (
    <span data-wb-label className="in-[.wb-fold]:hidden">
      {label}
    </span>
  );

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
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <TabsList
          ref={listRef}
          variant="line"
          /* justify-start, not the variant's center: centered overflow clips
             the leftmost tab off the strip's edge (issue #326). */
          className="no-scrollbar h-full min-w-0 justify-start overflow-x-auto"
        >
          {changesOn && (
            <TabsTrigger value="changes" {...wbTab("changes", "Changes")}>
              <FileDiffIcon />
              {wbLabel("Changes")}
              {count(diffs.length)}
            </TabsTrigger>
          )}
          {filesOn && (
            <TabsTrigger value="files" {...wbTab("files", "Files")}>
              <FolderGit2Icon />
              {wbLabel("Files")}
            </TabsTrigger>
          )}
          {surfacesOn && (
            <TabsTrigger value="terminal" {...wbTab("terminal", "Terminal")}>
              <SquareTerminalIcon />
              {wbLabel("Terminal")}
              {a.termRunning && (
                <CircleDotIcon className="size-3 animate-pulse text-work" />
              )}
            </TabsTrigger>
          )}
          {previewOn && (
            <TabsTrigger
              value="preview"
              data-wb-browser={!!browser || undefined}
              {...wbTab("preview", browser ? "Browser" : "Preview")}
            >
              <GlobeIcon />
              {wbLabel(browser ? "Browser" : "Preview")}
            </TabsTrigger>
          )}
          {planOn && (
            <TabsTrigger
              value="plan"
              data-wb-empty={plans.length === 0 || undefined}
              className={plans.length === 0 ? "opacity-40" : undefined}
              {...wbTab("plan", "Plan")}
            >
              <ListChecksIcon />
              {wbLabel("Plan")}
              {plan?.status === "proposed" ? (
                <span className="size-1.5 animate-pulse rounded-full bg-work" />
              ) : (
                plan?.status === "approved" && (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {plan.steps.filter((s) => s.status === "completed").length}/
                    {plan.steps.length}
                  </span>
                )
              )}
            </TabsTrigger>
          )}
          {bgOn && (
            <TabsTrigger
              value="background"
              data-wb-empty={jobs.length === 0 || undefined}
              className={jobs.length === 0 ? "opacity-40" : undefined}
              {...wbTab("background", "Background")}
            >
              <CpuIcon />
              {wbLabel("Background")}
              {jobsRunning > 0 && (
                <span
                  className="flex items-center gap-1 font-mono text-[11px] text-emerald-600"
                  data-bg-running={jobsRunning}
                >
                  <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                  {jobsRunning}
                </span>
              )}
            </TabsTrigger>
          )}
          {subOn && (
            <TabsTrigger
              value="subagents"
              data-wb-empty={helpers.length === 0 || undefined}
              className={helpers.length === 0 ? "opacity-40" : undefined}
              {...wbTab("subagents", "Subagents")}
            >
              <NetworkIcon />
              {wbLabel("Subagents")}
              {helpersRunning > 0 && (
                <span
                  className="flex items-center gap-1 font-mono text-[11px] text-work"
                  data-subagents-running={helpersRunning}
                >
                  <span className="size-1.5 animate-pulse rounded-full bg-work" />
                  {helpersRunning}
                </span>
              )}
            </TabsTrigger>
          )}
          {prOn && (
            <TabsTrigger
              value="pr"
              data-wb-empty={prShown == null || undefined}
              className={prShown == null ? "opacity-40" : undefined}
              {...wbTab("pr", prShown ? `PR #${prShown.number}` : "PR")}
            >
              <GitPullRequestIcon
                className={
                  prShown?.status === "merged"
                    ? "text-violet-600"
                    : prShown?.status === "closed"
                      ? "text-zinc-500"
                      : "text-emerald-600"
                }
              />
              {wbLabel(prShown ? `PR #${prShown.number}` : "PR")}
            </TabsTrigger>
          )}
        </TabsList>
        {revalidating && (
          <span
            data-wb-revalidating
            className="shrink-0 pl-2 font-mono text-[10px] text-muted-foreground"
          >
            updating…
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto shrink-0"
          onClick={onClose}
          title="Hide workbench"
        >
          <PanelRightCloseIcon />
        </Button>
      </div>

      <TabsContent value="changes" className="min-h-0 flex-1 flex flex-col">
        {/* #393 AC-9: a fade where the list scrolls under the sticky ship
            bar — no hard cut on the commit list. */}
        <div className="relative min-h-0 flex-1">
          <ScrollArea className="h-full" data-wb-scroll="changes">
            {diffs.length === 0 ? (
              <div className="flex flex-col items-center gap-2 p-8 text-center text-muted-foreground text-xs">
                <EyeIcon className="size-5" />
                {liveMode ? (
                  <p>
                    Clean working tree in{" "}
                    <span className="font-mono">{prettyPath(cwd)}</span>.
                  </p>
                ) : work?.branch ? (
                  <p>
                    No edits yet on{" "}
                    <span className="font-mono">⎇ {work.branch}</span>.
                  </p>
                ) : isDM ? (
                  <p>
                    Read-only thread. {lead?.name ?? "The employee"} reads code
                    but can't edit here.
                    <br />
                    Edits happen on a ticket in a channel with a repo.
                  </p>
                ) : (
                  <>
                    <p>
                      Read-only on <span className="font-mono">main</span>.
                      Start work gives {lead?.name ?? "the employee"} a ticket +
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
                  {/* #108: pending review comments + the Codex-style send.
                    Both render only while comments exist and a send handler
                    is wired (D-#19). */}
                  {onSend && pendingComments.length > 0 && (
                    <span className="ml-auto flex items-center gap-2">
                      <span
                        data-diff-pending
                        className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700 dark:text-amber-400"
                      >
                        <MessageSquareTextIcon className="size-3" />
                        {pendingComments.length} pending
                      </span>
                      <Button
                        size="xs"
                        data-diff-send
                        onClick={sendComments}
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
                      </Button>
                    </span>
                  )}
                </div>
                {shown.map((d) => (
                  <div key={d.path} className="flex items-start gap-2">
                    {/* Stage checkbox — the ship bar commits the checked
                      set (issue #107 AC-1; all checked by default). */}
                    {shipBar && (
                      <Checkbox
                        data-stagecheck
                        className="mt-3 shrink-0"
                        checked={!unchecked.has(d.path)}
                        onCheckedChange={(c) => toggleFile(d.path, c === true)}
                        title={`Stage ${d.path}`}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <DiffView
                        d={d}
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
            )}
            {/* Commits on this branch — outside the clean/dirty ternary: they
              still matter once every change is committed (issue #107). */}
            {liveCommits.length > 0 && (
              <div className="space-y-2 px-3 pt-2 pb-3">
                <div className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs">
                  <GitCommitHorizontalIcon className="size-3.5" />
                  Commits on this branch
                </div>
                {liveCommits.map((c) => (
                  <Commit key={c.hash}>
                    <CommitHeader nativeButton={false}>
                      <CommitInfo className="min-w-0">
                        <CommitMessage className="truncate">
                          {c.message}
                        </CommitMessage>
                        <CommitMetadata>
                          <CommitHash>{c.hash}</CommitHash>
                          <CommitSeparator />
                          {/* #587 AC-3: the real git author — mock rows
                             (no `author`) keep the employee fallback. */}
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
            )}
          </ScrollArea>
          {shipBar && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-background to-transparent" />
          )}
        </div>
        {/* The commit → push → Create PR bar (issue #107/#359). */}
        {shipBar && <CommitBar {...shipBar} />}
      </TabsContent>

      <TabsContent value="files" className="min-h-0 flex-1">
        <ScrollArea className="h-full" data-wb-scroll="files">
          <div className="p-3">
            {/* #587: the path truncates on the left so the folder's TAIL
               stays visible; the file count never wraps to a second line. */}
            <div className="mb-2 flex items-center gap-1.5 text-muted-foreground text-xs">
              <FolderGit2Icon className="size-3.5 shrink-0" />
              <span
                className="min-w-0 truncate font-mono"
                dir="rtl"
                title={cwd}
              >
                {prettyPath(cwd)}
              </span>
              {openPath && (
                <OpenPathButton
                  editors={editors}
                  onOpen={(app) => openPath(".", app)}
                  label="Open this folder in an editor or Finder"
                />
              )}
              {diffs.length > 0 && (
                <span className="shrink-0 whitespace-nowrap">
                  · {plural(diffs.length, "file")}{" "}
                  {liveMode ? "changed" : "touched by this thread"}
                </span>
              )}
            </div>
            {liveMode && probe === null ? (
              <div
                data-wb-probing
                className="py-6 text-center text-muted-foreground text-xs"
              >
                Reading <span className="font-mono">{prettyPath(cwd)}</span>…
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
                  {/* #587: middle ellipsis — the dirname truncates on the
                     left, the file NAME (the bit that matters) stays put. */}
                  <span
                    className="flex min-w-0 font-mono text-muted-foreground"
                    title={viewFile.path}
                  >
                    {(() => {
                      const shown = prettyPath(viewFile.path);
                      const i = shown.lastIndexOf("/");
                      const dir = i >= 0 ? shown.slice(0, i) : "";
                      const base = i >= 0 ? shown.slice(i) : shown;
                      return (
                        <>
                          {dir !== "" && (
                            <span className="min-w-0 truncate" dir="rtl">
                              {dir}
                            </span>
                          )}
                          <span className="shrink-0 font-medium text-foreground">
                            {dir !== "" ? base : shown}
                          </span>
                        </>
                      );
                    })()}
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
                ) : viewFile.line !== undefined ? (
                  /* #340: `workbench_open` pointed at a line — per-line rows so
                     that one is highlighted and scrolled into view. */
                  <pre className="max-h-[60vh] overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-[11px] leading-5">
                    {viewFile.content.split("\n").map((ln, i) => (
                      <div
                        key={i}
                        ref={
                          i + 1 === viewFile.line
                            ? (el) => el?.scrollIntoView({ block: "center" })
                            : undefined
                        }
                        className={
                          i + 1 === viewFile.line
                            ? "-mx-1 rounded bg-work/15 px-1 text-work"
                            : undefined
                        }
                      >
                        {ln || " "}
                      </div>
                    ))}
                    {viewFile.truncated && (
                      <div className="pt-2 text-muted-foreground">
                        … truncated
                      </div>
                    )}
                  </pre>
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
                onSelect={onTreeSelect}
                className="border-0 text-xs"
              >
                <TreeNodes
                  node={tree}
                  changed={changed}
                  openPath={treeOpenPath}
                  included={treeIncluded}
                  expanded={expanded}
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
              a.termOut || "\u001b[90mNo commands yet in this thread.\u001b[0m"
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
        {browser ? (
          browser
        ) : live ? (
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

      {plan && (
        <TabsContent value="plan" className="min-h-0 flex-1">
          <PlanPanel plans={plans} />
        </TabsContent>
      )}

      {bgOn && (
        <TabsContent value="background" className="min-h-0 flex-1">
          <BackgroundPanel jobs={jobs} onStop={onStopJob} />
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

      {prOn && (
        <TabsContent value="pr" className="min-h-0 flex-1">
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
          ) : (
            /* No PR on the branch, or `gh` failed — plain copy per reason
               with one next step; raw stderr stays behind Details (#114 AC-5). */
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground text-xs">
              {prError ? (
                <PrFailure
                  error={prError}
                  onRetry={reloadPr}
                  employeeName={lead?.name}
                />
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
