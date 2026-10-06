import type { ChatStatus } from "ai";
import {
  ArrowLeftIcon,
  CheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  EyeIcon,
  FolderIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  ListTodoIcon,
  MenuIcon,
  Minimize2Icon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PlayIcon,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AccessPill } from "../chat/access-pill";
import {
  ConversationKeepBottom,
  NotSentTray,
  plain,
  QueuedTray,
  type QueuedTrayItem,
  queuedItemText,
  runningComposer,
  waitingComposer,
} from "../chat/agent-chat";
import { FocusComposer } from "../chat/focus-composer";
import { sessionChoice } from "../chat/model-picker";
import { useUiLayer } from "../chat/ui-layers";
import {
  Conversation,
  ConversationContent,
} from "../components/ai-elements/conversation";
import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "../components/ai-elements/queue";
import { Button } from "../components/ui/button";
import { askKeyDown, pendingAsk } from "../conversation/ask-keys";
import { openStartRequest } from "../conversation/cards";
import { FindUnstubAnchor, FindUnstubNudge } from "../conversation/find-unstub";
import type { PlanAction } from "../conversation/plan-card";
import {
  type QuestionAnswer,
  QuestionAwareScrollButton,
} from "../conversation/question-card";
import { TranscriptNoteRow } from "../conversation/transcript-note";
import {
  estTurnHeight,
  openTailStart,
  RewindHover,
  TURN_LAZY_AFTER,
  type TurnActs,
  TurnRow,
} from "../conversation/turn-rows";
import { UserTurn } from "../conversation/turns";
import { sessionModelId } from "../lib/context-window";
import { PHASE_LABEL } from "../lib/helpers";
import { cn } from "../lib/utils";
import { readWbCache } from "../lib/wb-probe-cache";
import { HermesAvatar } from "../shell/avatars";
import type {
  AttachedFile,
  Channel,
  ConversationAccess,
  EmpFn,
  Employee,
  HostAccessors,
  HumanFn,
  MergeMethod,
  ModelChoice,
  ModelOption,
  ModelPickerExtras,
  Msg,
  OsApp,
  OsEditor,
  Project,
  PullRequest,
  QuestionAsk,
  ShipBar,
  ShipHandlers,
  Thread,
  TranscriptNote,
  WbSpot,
  WbTab,
  Work,
} from "../types";
import { VIEWER_ID } from "../types";
import { sessionArtifacts } from "../workbench/artifacts";
import type { LiveSurfaces } from "../workbench/live";
import { planTodos, threadPlans } from "../workbench/plan-panel";
import { sessionSubagents } from "../workbench/subagents-panel";
import { Workbench } from "../workbench/workbench";
import { WsBadge } from "../workbench/ws-badges";
import { SessionUsage } from "./session-usage";

export function FocusView({
  root,
  thread,
  channel,
  project,
  lead,
  emp,
  human,
  resolved,
  setResolved,
  work,
  onBack,
  onNav,
  onStart,
  running,
  onSend,
  onStop,
  lastSent,
  onRetry,
  onUnqueue,
  onSendQueued,
  onRewind,
  rewindWarning,
  seedFiles,
  onSeededFiles,
  onModel,
  picker,
  defaultModel,
  defaultProvider,
  accept,
  maxFileSize,
  onAttachError,
  say,
  models,
  repoFiles,
  host,
  onPrComment,
  onPrMerge,
  surfaces,
  pending,
  steer = false,
  agentWorking = false,
  onRemovePending,
  editors: editorsProp,
  onOpenPath,
  draft,
  onDraftChange,
  transcriptNote,
  banner,
  scrollTo,
  onScrolled,
  children,
  onOpenSession,
  onStopJob,
  onPlan,
  onAnswer,
  onCancel,
  browser,
  initialTab,
  onTab,
  wbSpot,
  ship,
  access,
  onAccess,
  caps,
  onSuggest,
  onPr,
}: {
  root: Extract<Msg, { kind: "msg" }>;
  thread: Thread;
  channel: Channel;
  project?: Project;
  lead?: Employee;
  emp: EmpFn;
  human: HumanFn;
  resolved: Record<string, string>;
  setResolved?: (r: Record<string, string>) => void;
  work: Work | null;
  onBack?: () => void;
  onNav?: () => void;
  onStart?: () => void;
  running: boolean;
  /* Return a promise to delay clearing the composer draft until it resolves;
     a rejected send keeps the text (issue #103, AC-5). */
  onSend: (t: string, files?: AttachedFile[]) => void | Promise<unknown>;
  /* Host-held composer draft for this conversation (issue #103); omitted, the
     composer keeps its own state. */
  draft?: string;
  onDraftChange?: (v: string) => void;
  onStop?: () => void;
  /* ↑ recall for the composer: the host's last sent message in this
     conversation (issue #104 AC-5). */
  lastSent?: string;
  onRetry?: (empId: string) => void;
  onUnqueue?: (i: number) => void;
  onSendQueued?: (i: number) => void;
  /* #134 "Rewind to here" — the picked user message's id (root included). */
  onRewind?: (messageId: string) => void;
  /* AC-5: a shared folder turns the click into an inline confirm naming the
     other session. */
  rewindWarning?: string;
  /* AC-4: rewound message images re-entering the composer. */
  seedFiles?: AttachedFile[];
  onSeededFiles?: () => void;
  onModel?: (c: ModelChoice) => void;
  /* Refresh / Edit models… / provider names — each renders only with its handler. */
  picker?: ModelPickerExtras;
  /* The engine's `models.list.default` — the unpinned-employee pick (#92 AC-5). */
  defaultModel?: string;
  /* The default's provider — a `{provider?, id}` pair disambiguates a shared id. */
  defaultProvider?: string;
  /* `{error:true}` marks a failed action — the host toasts it with the
     destructive accent instead of a neutral note (#423). */
  say?: (t: string, opts?: { error?: boolean }) => void;
  models?: ModelOption[];
  repoFiles?: string[];
  /** Live host accessors forwarded to the Workbench (issue #11 fs/git, #37 forge). */
  host?: HostAccessors;
  onPrComment?: (t: string) => void | Promise<void>;
  onPrMerge?: (method: MergeMethod) => void | Promise<void>;
  /** Live harness surfaces for Workbench Terminal/Preview tabs (issue #36). */
  surfaces?: LiveSurfaces;
  /* Mid-turn sends the agent hasn't read yet — the waiting tray above the composer (issue #9). */
  pending?: QueuedTrayItem[];
  /* os.editors + a bound os.open (issue #110, same pair ThreadView takes):
     the caller probes `host.describe` — onOpenPath={null} means os.open was
     absent, so the badge stays a plain label even when the accessors object
     statically carries the method (D-#19). Undefined keeps the prototype's
     own host.osEditors/osOpen path. */
  editors?: OsEditor[];
  onOpenPath?: ((path: string, app: OsApp, line?: number) => void) | null;
  /* Composer attachment types the host accepts (e.g. "image/*"); absent = no attach UI. */
  accept?: string;
  /* Attachment byte cap + where rejections surface (issue #31). */
  maxFileSize?: number;
  onAttachError?: (message: string) => void;
  steer?: boolean;
  /* #308: the running turn is engine-initiated (a leg) — same composer
     contract as ThreadView. */
  agentWorking?: boolean;
  onRemovePending?: (i: number) => void;
  /* A note on the transcript's state — same contract as ThreadView (#532):
     "trimmed" heads the transcript (#431 — history missing above the
     first entry); "unavailable" tails it (#28 — the live tail can't
     replay). */
  transcriptNote?: TranscriptNote;
  /* A pinned strip at the top of the conversation column (#423 AC-2 — the
     DM history-failure notice). The caller renders the surface (e.g. a
     StatusBanner); Focus only owns the slot above the scroll. */
  banner?: ReactNode;
  /* #138 AC-3 jump-to-hit, same contract as ThreadView: scroll the message
     with this id into view, flash it, then call onScrolled. */
  scrollTo?: string;
  onScrolled?: () => void;
  /* Extra surface content below the composer (the question card, #114). */
  children?: ReactNode;
  /* A subagent row that is another employee links to their session (issue #170). */
  onOpenSession?: (employeeId: string, session: string) => void;
  /* Workbench → Background: Stop a process (issue #170). */
  onStopJob?: (id: string) => void;
  /* Plan card decisions (issue #175). */
  onPlan?: (a: PlanAction, planId: string) => void;
  /* #420: question-ask answer/cancel — passed, the handler owns the
     resolved write (the card locks as "Sending…" until it lands). */
  onAnswer?: (q: QuestionAsk, a: QuestionAnswer) => void;
  onCancel?: (q: QuestionAsk) => void;
  /* #106: the thread's access level + toggle → the composer pill
     (both or neither; D-#19). */
  access?: ConversationAccess;
  onAccess?: (a: ConversationAccess) => void;
  /* This thread's own tabs of the LilOS Browser → Workbench Browser (#214). */
  browser?: ReactNode;
  /* Opens on this Workbench tab (e.g. a thread panel's "N subagents · Open" link, #317) —
     counts as the user's pick, so follow-the-agent doesn't switch away from it. */
  initialTab?: WbTab;
  /* The user picked a Workbench tab — the host syncs it into the URL so a
     reload lands on the same one (#319 AC-2). Follow-the-agent switches
     don't fire it: only picks go through pickTab. */
  onTab?: (t: WbTab) => void;
  /* The session's `workbench_open` request (issue #340): the panel opens and
     applies the target's tab — an explicit pick, so follow stops here. */
  wbSpot?: WbSpot;
  /* The Workbench ship bar's mock seam (issue #107/#359) — forwarded to
     Workbench.ship; live mode builds the same bar from `host` instead. */
  ship?: Partial<ShipBar> & ShipHandlers;
  /* Engine-declared capabilities forwarded to the Workbench (#587 AC-1):
     its Plan/Background/Subagents tabs gate on these flags so the strip's
     membership is fixed for the session — empty tabs grey, never pop in. */
  caps?: { plan?: boolean; subagents?: boolean; background?: boolean };
  /* #584: the ship bar's Suggest — the app's `session.ask` side request,
      returning the engine's answer text. Nothing is sent to the session. */
  onSuggest?: (files: string[]) => Promise<string | void> | string | void;
  /* #579 AC-1: the Workbench's live forge read reports the session's PR
     upward — a just-created/merged PR reaches the header chip instantly. */
  onPr?: (pr: PullRequest | null) => void;
}) {
  /* A `?tab=` destination shows its tab even under lg, where the panel is
     an overlay — "open on Subagents" means visibly open (#319 AC-1).
     Auto-open at ≥lg only when the panel has something to show on entry: a
     folder (or a non-DM thread's mock tabs), or live engine work on a
     folderless session (#543 — auto-opening an empty Background tab on
     every folderless Focus is noise, and under lg the overlay would sit
     over the ask card). */
  const engineContent =
    (thread.jobs?.length ?? 0) > 0 ||
    sessionSubagents(thread).length > 0 ||
    threadPlans(thread).length > 0;
  const [wbOpen, setWbOpen] = useState(
    () =>
      (window.innerWidth >= 1024 &&
        (work != null || !channel.dm || engineContent)) ||
      initialTab !== undefined,
  );
  /* #547 AC-5: closing the panel hides the aside (display:none) instead of
     unmounting it. On a big repo the remount is the whole reopen cost
     (~220 ms shell + ~0.3 ms/row) — keeping the DOM makes reopen a class
     flip. `wbEverOpened` mounts on first open only, and the element below
     is memoized so a wbOpen toggle doesn't re-render the tree (its props
     are unchanged). Focus remounts still unmount — the wb-probe-cache
     covers those. */
  const wbEverOpened = useRef(wbOpen);
  if (wbOpen) wbEverOpened.current = true;
  /* The visibility flip lands synchronously: the React re-render that
     re-asserts the same `hidden` class costs ~100 ms on a big repo, and
     the user shouldn't wait for it to see the panel (#547 AC-5). Every
     setWbOpen call site goes through this so state and DOM agree. The
     state update itself rides a transition so it renders off the click's
     critical path — the imperative class flip paints first. */
  const wbOpenWanted = useRef(wbOpen);
  const wbFlip = useCallback((open: boolean) => {
    /* `wbOpen` inside a handler can be stale while a transition is still
       rendering — the ref tracks the wanted value at click time so rapid
       close→open clicks never toggle the wrong way (#547). The DOM class
       flips synchronously (the user's frame); the state update waits a
       frame so the ~65 ms FocusView re-render can't delay first paint. */
    wbOpenWanted.current = open;
    /* Converge to the LATEST wanted value at fire time — a rapid
       close→open→close leaves several timers queued and only the final
       wanted state is correct. */
    setTimeout(() => setWbOpen(wbOpenWanted.current), 0);
    document
      .querySelector("[data-wb-shell]")
      ?.classList.toggle("hidden", !open);
  }, []);
  const wbClose = useCallback(() => wbFlip(false), [wbFlip]);
  const wbSend = useCallback((t: string) => onSend(t), [onSend]);
  /* #547 AC-1: a Focus remount (Esc out/in, session switch and back)
     reseeds the picked tab from the folder's cache entry — only a panel
     toggle was covered before. A `?tab=` deep link still wins. A
     cache-seeded pick counts as a pick, so follow must start disarmed —
     otherwise the lastDone/liveKey effects below re-apply "changes" on
     mount and stomp it before the first paint. */
  const cachedTab =
    work?.path && host ? readWbCache(host, work.path)?.tab : undefined;
  const [tab, setTab] = useState<WbTab>(
    () =>
      initialTab ??
      cachedTab ??
      (sessionArtifacts(thread).diffs.length ? "changes" : "terminal"),
  );
  /* Follow lives in a ref, not state: a `?tab=` deep link applying in the
     same commit as a turn's step/settle event would let the later effects
     below read the stale pre-deep-link `follow` and steal the tab it just
     applied (their setState queues after, so the steal would win). */
  const followRef = useRef(!initialTab && cachedTab == null);
  /* #547 AC-1 (cont.): `work` can arrive a render after mount (conv still
     loading) — then the mount seed above missed and the tab picked the
     heuristic ("terminal"→falls back to Changes). Seed once more when
     host+path first become available, in a layout effect so the restore
     lands before the next paint. `seededTab` also flips on any user pick
     or `?tab=` apply so a late seed never stomps a real choice. */
  const seededTab = useRef(initialTab !== undefined);
  useLayoutEffect(() => {
    if (seededTab.current || !work?.path || !host) return;
    seededTab.current = true;
    const saved = readWbCache(host, work.path)?.tab;
    if (saved != null) {
      followRef.current = false;
      setTab(saved);
    }
  }, [work?.path, host, initialTab]);
  /* Why follow is disarmed matters for the re-arm below: a `?tab=` deep
     link holds the named tab even while a still-starting turn streams in
     (#319); a manual pick or a `workbench_open` spot does not — a turn
     that begins post-attach re-engages follow there (#396). Both write
     `?tab=`, so the hold can't key on `initialTab` alone. */
  const deepLinkHold = useRef(!!initialTab);
  /* `?tab=` can land after mount — a boot redirect settling the location —
     and applies then like a fresh deep link (#432); the prop is not
     mount-only. A user pick writes the same tab back through the URL, so
     re-applying it is a no-op. */
  const appliedTab = useRef(initialTab);
  useEffect(() => {
    if (!initialTab || initialTab === appliedTab.current) return;
    appliedTab.current = initialTab;
    seededTab.current = true; // a `?tab=` apply counts as the seed (#547)
    deepLinkHold.current = true;
    setTab(initialTab);
    followRef.current = false;
    wbFlip(true);
  }, [initialTab]);
  /* #138 AC-3: a search hit opens the session in Focus (#114) scrolled to
     that message with a short flash — mirrors ThreadView's jump-to-hit.
     Waits for the row to render (history may still be loading). */
  const turnsRef = useRef<HTMLElement>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!scrollTo) {
      flashedRef.current = null;
      return;
    }
    if (flashedRef.current === scrollTo) return;
    const el = turnsRef.current?.querySelector(
      `[data-msg="${CSS.escape(scrollTo)}"]`,
    );
    if (!el) return;
    flashedRef.current = scrollTo;
    el.scrollIntoView({ block: "center" });
    setFlash(scrollTo);
    onScrolled?.();
  }, [scrollTo, thread.replies, onScrolled]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(t);
  }, [flash]);
  const flashCls = (id?: string) =>
    cn(
      "rounded-lg transition-colors duration-500",
      id && flash === id && "bg-amber-100 dark:bg-amber-900/40",
    );
  const isDM = !!channel.dm;
  /* The session's model via the one shared resolver (#294) — the DM panel
     resolves the same way, so one session can't show two windows. */
  const model = sessionModelId(
    thread,
    lead?.model,
    models,
    defaultModel,
    defaultProvider,
  );
  const live = thread.replies.find((r) => r.live);
  const lastStep = live?.steps?.[live.steps.length - 1];
  /* #420: parked on an open QUESTION ask = WAITING, not working — the
     composer says "waiting for your answer" and shows Send, not Stop
     (Hermes FIX #515). Scoped to r.question, which only the question card
     sets: approval/plan asks keep the steer composer. */
  const waiting = running && live?.phase === "waiting" && !!live?.question;
  const status: ChatStatus = running
    ? waiting
      ? "ready"
      : live?.phase === "submitted"
        ? "submitted"
        : "streaming"
    : "ready";
  // The latest approved plan / task list (issue #175), else the engine's session todos.
  const fromPlan = planTodos(thread);
  const todos = fromPlan.length ? fromPlan : (thread.todos ?? []);
  const queue = thread.queue ?? [];
  const pendingSteers = pending ?? [];
  // The open "asks to start work" card, if any, is the single start-work entry point (issue #15).
  const startCardOpen = openStartRequest(thread, resolved);
  const liveKey = live
    ? `${live.id}:${live.steps?.length}:${lastStep?.running}`
    : "";
  /* Follow the agent: a turn that BEGAN while this feed was attached
     re-arms follow so the workbench tracks it. The turn already live when
     the view mounted — a mid-turn reload onto `?tab=` — must not steal the
     deep-linked tab before the user ever saw it (#396). `live` arrives
     async, so the discriminator is the turn's own attach boundary
     (`postAttach`), not mount-time state; mock rows without it keep the
     old always-follow behavior. Under `deepLinkHold` (`?tab=` applied,
     not yet picked away) a still-starting turn must NOT re-arm — its
     `turn.started` landing post-attach would let `liveKey` steal the
     deep-linked tab on the next step (#319). */
  /* Re-arm only when a NEW turn appears while mounted: the mount-run must
     not fire for a turn already streaming when the view attached — on a
     Focus remount that would re-engage follow and let liveKey steal the
     cache-seeded tab mid-turn (#547 AC-1). A pick made mid-turn still
     re-arms on the NEXT turn (live.id changes) exactly as before (#396). */
  const seenLive = useRef(live?.id);
  /* #606: a pick while a turn is in flight holds follow for THAT turn —
     its `live` row can land after the pick (`turn.started` rides the feed),
     and `seenLive` alone can't tell the late row from a new turn's. The
     stamp lifts on the first quiet beat (nothing live or running — the
     pick-time turn ended) or when a different live turn shows up, so the
     next turn still re-engages follow (#396). "in-flight" = running but
     the row hasn't rendered yet. */
  const pickedDuringTurn = useRef<string | null>(null);
  useEffect(() => {
    const id = live?.id;
    if (id === seenLive.current) return;
    seenLive.current = id;
    /* The first live row after a mid-turn pick IS the pick-time turn —
       keep holding; a different id is a new turn and lifts the hold. */
    if (id && pickedDuringTurn.current != null) {
      pickedDuringTurn.current =
        pickedDuringTurn.current === "in-flight" ||
        pickedDuringTurn.current === id
          ? id
          : null;
    }
    if (
      !deepLinkHold.current &&
      pickedDuringTurn.current == null &&
      live &&
      live.postAttach !== false
    )
      followRef.current = true;
  }, [live?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!running && !live) pickedDuringTurn.current = null;
  }, [running, live]);
  // Turn finished with edits → land on Changes, like Codex's review pane.
  const lastDone = [...thread.replies]
    .reverse()
    .find((r) => emp(r.from) && !r.live);
  /* #419: the Retry lives on the last TURN — system notes (a failed turn's
     error row) sit below it and don't count. */
  const lastTurnIdx = thread.replies.reduce(
    (a, r, i) => (emp(r.from) ? i : a),
    -1,
  );
  useEffect(() => {
    if (followRef.current && !live && lastDone?.steps?.some((s) => s.diff))
      setTab("changes");
  }, [lastDone?.id, !!live]); // eslint-disable-line react-hooks/exhaustive-deps
  // A PR NEWLY appearing on the session opens its tab (Devin opens a PR tab
  // per PR) — a change only: re-opening a conversation that already has one
  // must not flip the panel open on its own (#579).
  const seenPr = useRef<number | undefined>(undefined);
  useEffect(() => {
    const n = thread.pr?.number;
    if (seenPr.current === undefined) {
      seenPr.current = n;
      return;
    }
    if (n !== undefined && n !== seenPr.current) {
      setTab("pr");
      wbFlip(true);
    }
    seenPr.current = n;
  }, [thread.pr?.number]); // eslint-disable-line react-hooks/exhaustive-deps
  const pr = thread.pr;
  const prPending = pr?.checks.some((c) => c.status === "pending");
  useEffect(() => {
    if (!followRef.current || !lastStep) return;
    if (lastStep.diff) setTab("changes");
    else if (lastStep.tool === "terminal") setTab("terminal");
  }, [liveKey]); // eslint-disable-line react-hooks/exhaustive-deps
  /* The running turn spins off a new helper → Subagents comes forward (#317). */
  const liveHelpers = live?.subagents?.map((x) => x.id).join(",") ?? "";
  useEffect(() => {
    if (followRef.current && liveHelpers) setTab("subagents");
  }, [liveHelpers]); // eslint-disable-line react-hooks/exhaustive-deps
  /* Latest in-flight turn, read at pick time — riding a ref keeps the
     memoized `pickTab` stable across step churn (the actsRef pattern). */
  const inFlightTurn = useRef<{ id?: string } | null>(null);
  inFlightTurn.current = live ?? (running ? {} : null);
  const pickTab = useCallback(
    (t: WbTab) => {
      setTab(t);
      /* The pick belongs to the turn currently in flight — hold follow for
         it specifically (#606): a live row arriving after the pick is that
         same turn, not a new one. */
      pickedDuringTurn.current = inFlightTurn.current
        ? (inFlightTurn.current.id ?? "in-flight")
        : null;
      seededTab.current = true; // a manual pick counts as the seed (#547)
      followRef.current = false;
      /* A pick lifts the deep-link hold (new turns re-arm follow) and its
         `?tab=` echo must not re-mark the hold — record it as applied so
         the effect above treats the echo as a no-op. */
      deepLinkHold.current = false;
      appliedTab.current = t;
      wbFlip(true);
      onTab?.(t);
    },
    [onTab, wbFlip],
  );
  /* #430: row handlers ride a ref rewritten each render — the memoized
     TurnRow never sees a fresh callback identity (pickTab is one), and
     its reads are always the latest closures. */
  const actsRef = useRef<TurnActs>({});
  actsRef.current = {
    onRetry,
    onOpen: pickTab,
    onOpenSession,
    onPlan,
    onRewind,
    setResolved,
    onStart,
    onAnswer,
    onCancel,
  };
  const lazyRows = thread.replies.length > TURN_LAZY_AFTER;
  /* #570: a lazy thread opens on its tail — rows above `tailStart` never
     mount on first paint; they start as estimated-height stubs and the
     observer mounts them at the window edge. */
  const estHeights = useMemo(
    () =>
      lazyRows
        ? thread.replies.map((r) => estTurnHeight(r, !!emp(r.from), "focus"))
        : [],
    [lazyRows, thread.replies, emp],
  );
  const tailStart = openTailStart(estHeights);
  /* Same stale-target guard as thread-view: a scrollTo id with no row
     left in this thread must not keep the open pin suppressed. */
  const jumpPending =
    !!scrollTo &&
    (root.id === scrollTo || thread.replies.some((r) => r.id === scrollTo));
  /* #340 AC-2b: `workbench_open` brings the panel forward on the target's
     tab — the Workbench applies `target`; here the panel opens and follow
     stops (it is the agent's explicit "look at this"). */
  const wbSpotAt = wbSpot?.at;
  useEffect(() => {
    if (!wbSpot) return;
    wbFlip(true);
    followRef.current = false;
    deepLinkHold.current = false;
  }, [wbSpotAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const doneTodos = todos.filter((t) => t.status === "completed").length;
  // Plan tray opens while the agent works and folds away when the turn ends (user can still toggle).
  const [planOpen, setPlanOpen] = useState(running);
  useEffect(() => setPlanOpen(running), [running]);
  /* Header "Open folder" affordance (issue #110): editors on the session's
     host; the badge is a menu only when os.open exists there (D-#19). */
  const wsCwd = thread.ws?.cwd;
  const [hostEditors, setHostEditors] = useState<OsEditor[]>([]);
  useEffect(() => {
    let off = false;
    if (editorsProp === undefined && host?.osEditors && wsCwd)
      void host
        .osEditors()
        .then((e) => !off && setHostEditors(e))
        .catch(() => {});
    else setHostEditors([]);
    return () => {
      off = true;
    };
  }, [wsCwd, editorsProp]);
  const editors = editorsProp ?? hostEditors;
  const where = isDM ? "Direct" : (project?.name ?? "Company");
  const chLabel = isDM ? channel.name : `#${channel.name}`;
  /* #543: the Workbench exists for EVERY session — the app passes `host`
     unconditionally now (the accessors are folder-independent; every call
     takes the cwd). Folder-bound tabs still need a real folder — that's
     per-tab inside the Workbench. The toggle renders only when a tab could
     show (D-#19): a folder session can always ask the host; a folderless
     session needs an engine tab (a declared background_jobs capability via
     `onStopJob`, jobs, helpers, a plan — or the `?tab=subagents` deep
     link); a channel thread keeps its mock tabs. Once opened, the
     Workbench reports its settled tab set — a folder session whose host
     answered nothing and has no engine work reports empty, which hides the
     toggle (AC-5) — except while the panel is already open, where its
     "Nothing to show" line answers instead of a vanishing aside. */
  const [wbReported, setWbReported] = useState<WbTab[] | null>(null);
  useEffect(() => {
    setWbReported(null);
  }, [thread.session, work?.path]);
  const engineTabs = engineContent || onStopJob != null;
  const wbAvailable =
    host != null &&
    (wbReported === null
      ? work != null || !isDM || engineTabs || tab === "subagents"
      : wbReported.length > 0 || engineTabs || tab === "subagents" || wbOpen);

  /* Focus is one UI layer: Esc backs out only while Focus is the top-most
     surface (an open dialog or menu above it keeps Esc, #576 — it never
     stops a turn), and while top-most it owns the surface keys — ⌘. stops
     a running turn, ↵/⌫ answer the newest pending approval/plan card
     (#558). */
  const keyAsk = pendingAsk(thread.replies, resolved, !!onPlan);
  const keyViewer = human(VIEWER_ID)?.name ?? "you";
  useUiLayer({
    onEscape: onBack,
    onKey: (e) =>
      askKeyDown(e, {
        ask: keyAsk,
        viewer: keyViewer,
        resolved,
        setResolved,
        onPlan,
        running,
        onStop,
      }),
  });
  /* The id the hint lives under — approval cards match on ask id, plan
     cards on plan id. */
  const keyTarget = keyAsk
    ? keyAsk.kind === "approval"
      ? keyAsk.reply.approval?.id
      : keyAsk.reply.plan?.id
    : undefined;

  /* The memoized element keeps the whole Workbench subtree out of the
     render when only `wbOpen` flips — otherwise a 2,000-row file tree
     reconciles on every open/close (#547 AC-5). */
  const wbEl = useMemo(
    () => (
      <Workbench
        thread={thread}
        work={work}
        isDM={isDM}
        lead={lead}
        tab={tab}
        setTab={pickTab}
        onClose={wbClose}
        onStart={onStart}
        startYields={startCardOpen}
        onSend={wbSend}
        say={say}
        repoFiles={repoFiles}
        host={host}
        human={human}
        onPrComment={onPrComment}
        onPrMerge={onPrMerge}
        live={surfaces}
        onStopJob={onStopJob}
        emp={emp}
        onOpenSession={onOpenSession}
        running={running}
        sendPending={pendingSteers.length > 0}
        steer={steer}
        editors={editorsProp}
        onOpenPath={onOpenPath}
        browser={browser}
        spot={wbSpot}
        ship={ship}
        caps={caps}
        onSuggest={onSuggest}
        onPr={onPr}
        onAllowed={setWbReported}
      />
    ),
    [
      thread,
      work,
      isDM,
      lead,
      tab,
      pickTab,
      wbClose,
      onStart,
      startCardOpen,
      wbSend,
      say,
      repoFiles,
      host,
      human,
      onPrComment,
      onPrMerge,
      surfaces,
      onStopJob,
      emp,
      onOpenSession,
      running,
      pendingSteers.length,
      steer,
      editorsProp,
      onOpenPath,
      browser,
      wbSpot,
      ship,
    ],
  );

  return (
    <main className="lilos-glass flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="lilos-drag flex h-14 shrink-0 items-center gap-2 border-b px-2 sm:px-3">
        {onNav && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onNav}
            title="Workspace"
          >
            <MenuIcon />
          </Button>
        )}
        {onBack && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 px-2"
            onClick={onBack}
            title={isDM ? "Back to DM" : `Back to ${chLabel}`}
            aria-label={isDM ? "Back to DM" : `Back to ${chLabel}`}
          >
            <ArrowLeftIcon />
            <span className="hidden sm:inline">{chLabel}</span>
          </Button>
        )}
        <span className="h-5 w-px shrink-0 bg-border" />
        {lead && (
          <HermesAvatar
            name={lead.name}
            status={lead.status}
            className="size-7"
          />
        )}
        <div className="min-w-0">
          {/* #137 AC-4: the session's title (placeholder → engine-written)
              leads; untitled threads keep the first message. */}
          <div
            className="truncate font-semibold"
            title={thread.title || plain(root.text)}
            data-session-title
          >
            {thread.title || plain(root.text)}
          </div>
          <div
            className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs"
            title={`${where} / ${chLabel} · ${lead?.name ?? ""} · ${thread.session}`}
          >
            {/* The session's folder + branch — same badge the thread panel
                shows (#113); Focus is the session's main view (#114).
                A folder-less DM session is a plain chat — no repo exists to
                be read-only on, so no label at all (#196). */}
            {thread.ws ? (
              /* Same WsBadge the thread header shows (#113) — with the
                 open-in-editor / Reveal-in-Finder menu when the host has
                 os.open (#110); Focus is the session's main view (#114). */
              <WsBadge
                ws={thread.ws}
                openMenu={
                  onOpenPath
                    ? { editors, onOpen: (app) => onOpenPath(".", app) }
                    : onOpenPath === undefined && host?.osOpen
                      ? {
                          editors,
                          onOpen: (app) =>
                            void host
                              .osOpen?.(thread.ws!.cwd, ".", app)
                              .catch((e) =>
                                say?.(
                                  `Open failed — ${e instanceof Error ? e.message : String(e)}`,
                                  { error: true },
                                ),
                              ),
                        }
                      : undefined
                }
              />
            ) : work?.branch ? (
              <span className="hidden shrink-0 items-center gap-1 rounded bg-emerald-50 px-1 text-emerald-800 md:flex">
                <GitBranchIcon className="size-3" />
                <span className="font-mono">{work.branch}</span>
              </span>
            ) : work ? (
              /* A real folder that isn't a git checkout: writes land there,
                 "read-only" would lie (#114). */
              <span className="hidden shrink-0 items-center gap-1 rounded bg-muted px-1 text-muted-foreground md:flex">
                <FolderIcon className="size-3" />
                no git repo
              </span>
            ) : isDM ? null : (
              <span className="hidden shrink-0 items-center gap-1 rounded bg-muted px-1 md:flex">
                <EyeIcon className="size-3" />
                read-only
              </span>
            )}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {running && (
            <span className="hidden items-center gap-1 text-muted-foreground text-xs sm:flex">
              <CircleDotIcon className="size-3 animate-pulse text-work" />
              {live?.phase ? PHASE_LABEL[live.phase] : "working"}
            </span>
          )}
          {thread.usage && (
            <SessionUsage usage={thread.usage} model={model} models={models} />
          )}
          {!work && !isDM && onStart && (
            // Same rule as the thread panel (issue #15): while the request card in the conversation
            // is open, this button yields to it — disabled + tooltip. Wrapper carries the title so
            // the disabled button's pointer-events:none doesn't swallow the hover.
            <span
              className="inline-flex shrink-0"
              title={
                startCardOpen
                  ? "Answer the request below"
                  : "New ticket + worktree for this session"
              }
            >
              <Button
                size="sm"
                onClick={onStart}
                disabled={startCardOpen}
                data-startwork-header
              >
                <PlayIcon />
                <span className="hidden sm:inline">Start work</span>
              </Button>
            </span>
          )}
          {/* #579: no "Open PR" button — asking the employee IS the way to
             open one. A session that already has a PR shows its link chip. */}
          {pr && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => pickTab("pr")}
              data-prchip
            >
              {pr.status === "merged" ? (
                <GitMergeIcon className="text-violet-600" />
              ) : prPending ? (
                <CircleDashedIcon className="animate-spin text-work [animation-duration:3s]" />
              ) : (
                <GitPullRequestIcon className="text-emerald-600" />
              )}
              <span className="hidden sm:inline">
                #{pr.number}{" "}
                {pr.status === "merged"
                  ? "merged"
                  : pr.draft
                    ? "draft"
                    : prPending
                      ? "checks"
                      : "ready"}
              </span>
            </Button>
          )}
          {wbAvailable && (
            <Button
              variant={wbOpen ? "secondary" : "ghost"}
              size="icon-sm"
              title="Workbench"
              onClick={() => wbFlip(!wbOpenWanted.current)}
            >
              {wbOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
            </Button>
          )}
          {onBack && (
            <Button
              variant="ghost"
              size="icon-sm"
              title="Exit focus"
              onClick={onBack}
            >
              <Minimize2Icon />
            </Button>
          )}
        </div>
      </header>

      <div
        className={cn(
          "grid min-h-0 flex-1 grid-cols-1",
          /* The 2-col layout follows the shell's own class, not wbOpen —
             it flips in the same frame the panel does (#547 AC-5). */
          wbAvailable &&
            "has-[[data-wb-shell]:not(.hidden)]:lg:grid-cols-[minmax(0,1fr)_minmax(400px,46%)]",
        )}
      >
        <section ref={turnsRef} className="flex min-h-0 min-w-0 flex-col">
          {/* The banner lives in the same column as the messages — never a
              full-bleed strip the action floats away on (#423). */}
          {banner && (
            <div className="mx-auto w-full max-w-[46rem] px-5 pt-3">
              {banner}
            </div>
          )}
          {/* #570: a lazy thread's first pin lands instantly — a smooth
              sweep would mount every stub it scrolls past (see
              thread-view); a scrollTo open skips the pin so the jump
              lands first. `resize` stays smooth for the streaming
              chase. */}
          <Conversation
            className="min-h-0 [mask-image:linear-gradient(to_bottom,transparent,#000_28px)]"
            initial={jumpPending ? false : lazyRows ? "instant" : "smooth"}
          >
            <ConversationContent
              data-thread
              className="mx-auto w-full max-w-[46rem] gap-7 px-5 pt-8 pb-3"
            >
              {transcriptNote?.kind === "trimmed" && (
                <TranscriptNoteRow note={transcriptNote} />
              )}
              <div
                data-msg={root.id}
                className={cn(
                  flashCls(root.id),
                  onRewind && root.id && human(root.from) && "group relative",
                )}
              >
                <UserTurn
                  from={root.from}
                  time={root.time}
                  text={root.text}
                  note={`opened session ${thread.session}`}
                  human={human}
                  attachments={root.attachments}
                />
                {onRewind && root.id && human(root.from) && (
                  <RewindHover
                    running={running}
                    warning={rewindWarning}
                    onRewind={() => onRewind(root.id ?? "")}
                  />
                )}
              </div>
              {/* #430: memoized per row — a delta re-renders only the
                  turn it touched; long threads hold far-off-screen rows
                  as stubs (data-msg/turnsettled anchors preserved). */}
              {thread.replies.map((r, i) => (
                <TurnRow
                  key={r.turnId ?? r.id ?? i}
                  frame="focus"
                  r={r}
                  i={i}
                  lastTurn={i === lastTurnIdx}
                  lastRow={i === thread.replies.length - 1}
                  flashed={flash === r.id}
                  lazy={lazyRows}
                  startHeld={i < tailStart}
                  estHeight={estHeights[i]}
                  scrollTarget={scrollTo === r.id}
                  running={running}
                  emp={emp}
                  human={human}
                  resolved={resolved}
                  work={work}
                  repo={channel.repo}
                  models={models}
                  pr={pr}
                  prAuthor={lead?.name ?? pr?.author}
                  rewindWarning={rewindWarning}
                  keyTarget={keyTarget}
                  acts={actsRef}
                />
              ))}
              {transcriptNote?.kind === "unavailable" && (
                <TranscriptNoteRow note={transcriptNote} />
              )}
            </ConversationContent>
            {/* Same guard as the thread panel — the ↓ never overlaps a
                pending question card (FIX #515 r4). */}
            <QuestionAwareScrollButton />
            <FindUnstubNudge />
            <FindUnstubAnchor lazy={lazyRows} />
            {/* Not-sent tray / plan tray / steer chips grow the area below the conversation;
                re-stick so everything stays visible without scrolling (issue #15). */}
            <ConversationKeepBottom
              signal={`${queue.length}:${todos.length}:${pendingSteers.length}:${running}:${planOpen}`}
            />
          </Conversation>

          {/* data-composer on the whole dock (plan tray + steer tray +
              not-sent tray + composer): the app's toast floats above the
              tallest bottom block, never over a control (#423). */}
          <div
            data-composer
            className="mx-auto w-full max-w-[46rem] shrink-0 px-3 pb-3"
          >
            {todos.length > 0 && (
              <Queue className="mb-2 gap-1 py-1.5 shadow-none">
                <QueueSection open={planOpen} onOpenChange={setPlanOpen}>
                  <QueueSectionTrigger className="py-1.5 text-xs">
                    <QueueSectionLabel
                      label={`Plan · ${doneTodos}/${todos.length} done`}
                      icon={<ListTodoIcon className="size-3.5" />}
                    />
                    {todos.find((t) => t.status === "in_progress") && (
                      <span className="ml-2 min-w-0 truncate text-amber-700">
                        {todos.find((t) => t.status === "in_progress")!.content}
                      </span>
                    )}
                  </QueueSectionTrigger>
                  <QueueSectionContent>
                    <QueueList className="mt-1">
                      {todos.map((t) => {
                        const off =
                          t.status === "completed" || t.status === "cancelled";
                        return (
                          <QueueItem key={t.content} className="py-0.5">
                            <div className="flex items-center gap-2">
                              {t.status === "in_progress" ? (
                                <CircleDotIcon className="size-2.5 shrink-0 animate-pulse text-work" />
                              ) : off ? (
                                <CheckIcon className="size-2.5 shrink-0 text-emerald-600" />
                              ) : (
                                <QueueItemIndicator />
                              )}
                              <QueueItemContent
                                className={cn(
                                  "text-xs",
                                  off
                                    ? "text-muted-foreground line-through decoration-muted-foreground/40"
                                    : "text-foreground",
                                )}
                              >
                                {t.content}
                              </QueueItemContent>
                            </div>
                          </QueueItem>
                        );
                      })}
                    </QueueList>
                  </QueueSectionContent>
                </QueueSection>
              </Queue>
            )}
            {/* Mid-turn sends still waiting to be read (issue #9) and the not-sent tray —
                same markup as the thread panel, above the composer there too. queue holds ONLY
                messages the Stop button stopped before they landed. */}
            <QueuedTray
              items={pendingSteers}
              steer={steer}
              name={lead?.name}
              onRemove={onRemovePending}
              onEdit={
                onRemovePending && onDraftChange
                  ? (i) => {
                      onDraftChange(
                        pendingSteers[i]
                          ? queuedItemText(pendingSteers[i])
                          : "",
                      );
                      onRemovePending(i);
                    }
                  : undefined
              }
            />
            <NotSentTray
              items={queue}
              onSend={onSendQueued}
              onRemove={onUnqueue}
            />
            <FocusComposer
              running={running && !waiting}
              status={status}
              choice={
                models?.length
                  ? sessionChoice(
                      thread,
                      lead?.model,
                      models,
                      defaultModel,
                      defaultProvider,
                    )
                  : undefined
              }
              models={models}
              onModel={onModel}
              picker={picker}
              tools={
                access !== undefined && onAccess ? (
                  <AccessPill access={access} onAccess={onAccess} />
                ) : undefined
              }
              onStop={onStop}
              lastSent={lastSent}
              placeholder={
                // Terminal takeover (issue #69 AC-2): while the human holds
                // the session's terminal, the agent can't run or write there —
                // the composer says it's paused rather than inviting input.
                surfaces?.termControl === "user"
                  ? `${lead?.name ?? "The agent"} is paused while you use the terminal`
                  : running
                    ? waiting
                      ? waitingComposer(lead?.name ?? "Employee").placeholder
                      : runningComposer(
                          lead?.name ?? "Employee",
                          steer,
                          agentWorking,
                        ).placeholder
                    : `Continue session ${thread.session} with ${lead?.name ?? "the employee"}…`
              }
              hint={
                running
                  ? waiting
                    ? waitingComposer(lead?.name ?? "Employee").hint
                    : runningComposer(
                        lead?.name ?? "Employee",
                        steer,
                        agentWorking,
                      ).hint
                  : pr?.status === "merged"
                    ? `#${pr.number} merged, ⎇ ${pr.head} deleted · next edit starts a new branch from main`
                    : work?.branch
                      ? `Edits go to ⎇ ${work.branch}`
                      : work
                        ? "Edits land in this folder"
                        : isDM
                          ? `Reply to ${lead?.name ?? "the employee"}…`
                          : "Read-only on main"
              }
              onSend={(t, files) => onSend(t, files)}
              draft={draft}
              onDraftChange={onDraftChange}
              seedFiles={seedFiles}
              onSeededFiles={onSeededFiles}
              accept={accept}
              maxFileSize={maxFileSize}
              onAttachError={onAttachError}
            />
          </div>
          {/* The open question card docks below the composer, same place it
              sits under the thread panel (#114 AC-2). */}
          {children}
        </section>

        {wbAvailable && wbEverOpened.current && (
          <>
            {wbOpen && (
              <div
                className="fixed inset-0 z-20 bg-black/20 lg:hidden"
                onClick={wbClose}
              />
            )}
            <aside
              className={cn(
                "lilos-glass flex min-h-0 flex-col border-l bg-background lg:my-2 lg:mr-2 max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:w-[min(560px,100vw)] max-lg:shadow-2xl",
                /* Reads the wanted value: an unrelated render landing while
                   a deferred setWbOpen is still pending must not re-hide a
                   panel wbFlip just opened (#547). */
                !wbOpenWanted.current && "hidden",
              )}
              data-wb-shell
            >
              {wbEl}
            </aside>
          </>
        )}
      </div>
    </main>
  );
}
