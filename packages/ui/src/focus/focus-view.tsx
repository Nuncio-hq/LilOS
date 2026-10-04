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
import { type ReactNode, useEffect, useRef, useState } from "react";
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
import { useEscapeKey } from "../chat/composer-keys";
import { FocusComposer } from "../chat/focus-composer";
import { sessionChoice } from "../chat/model-picker";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
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
import { openStartRequest } from "../conversation/cards";
import type { PlanAction } from "../conversation/plan-card";
import type { QuestionAnswer } from "../conversation/question-card";
import {
  RewindCheckpoint,
  TURN_LAZY_AFTER,
  type TurnActs,
  TurnRow,
} from "../conversation/turn-rows";
import { UserTurn } from "../conversation/turns";
import { sessionModelId } from "../lib/context-window";
import { PHASE_LABEL } from "../lib/helpers";
import { cn } from "../lib/utils";
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
  QuestionAsk,
  ShipBar,
  ShipHandlers,
  Thread,
  WbSpot,
  WbTab,
  Work,
} from "../types";
import { sessionArtifacts } from "../workbench/artifacts";
import type { LiveSurfaces } from "../workbench/live";
import { planTodos } from "../workbench/plan-panel";
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
  /* Why the working transcript can't be shown — same note ThreadView renders
     where the transcript would be (issue #28). */
  transcriptNote?: string;
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
}) {
  /* A `?tab=` destination shows its tab even under lg, where the panel is
     an overlay — "open on Subagents" means visibly open (#319 AC-1). */
  const [wbOpen, setWbOpen] = useState(
    () => window.innerWidth >= 1024 || initialTab !== undefined,
  );
  const [tab, setTab] = useState<WbTab>(
    () =>
      initialTab ??
      (sessionArtifacts(thread).diffs.length ? "changes" : "terminal"),
  );
  /* Follow lives in a ref, not state: a `?tab=` deep link applying in the
     same commit as a turn's step/settle event would let the later effects
     below read the stale pre-deep-link `follow` and steal the tab it just
     applied (their setState queues after, so the steal would win). */
  const followRef = useRef(!initialTab);
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
    deepLinkHold.current = true;
    setTab(initialTab);
    followRef.current = false;
    setWbOpen(true);
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
  useEffect(() => {
    if (!deepLinkHold.current && live && live.postAttach !== false)
      followRef.current = true;
  }, [live?.id]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // A PR appearing on the session opens its tab (Devin opens a PR tab per PR).
  useEffect(() => {
    if (thread.pr) {
      setTab("pr");
      setWbOpen(true);
    }
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
  const pickTab = (t: WbTab) => {
    setTab(t);
    followRef.current = false;
    /* A pick lifts the deep-link hold (new turns re-arm follow) and its
       `?tab=` echo must not re-mark the hold — record it as applied so
       the effect above treats the echo as a no-op. */
    deepLinkHold.current = false;
    appliedTab.current = t;
    setWbOpen(true);
    onTab?.(t);
  };
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
  /* #340 AC-2b: `workbench_open` brings the panel forward on the target's
     tab — the Workbench applies `target`; here the panel opens and follow
     stops (it is the agent's explicit "look at this"). */
  const wbSpotAt = wbSpot?.at;
  useEffect(() => {
    if (!wbSpot) return;
    setWbOpen(true);
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
  /* The Workbench exists only where there is a real folder to read (D-#19):
     the app passes `host` only for sessions with one — a folder-less session
     (or a pure-mock surface) gets no Workbench and no toggle (#114 AC-6). */
  const wbAvailable = host != null;

  /* Esc leaves Focus — but only when nothing else owns the key: the composer
     takes it to stop a running turn, an open popup/menu takes it to close,
     and Esc pressed inside a field stays there (#114 AC-1, same rules as
     issue #104). */
  useEscapeKey(onBack);

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
          {pr ? (
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
                  : prPending
                    ? "checks"
                    : "ready"}
              </span>
            </Button>
          ) : (
            work?.branch && (
              <Button
                variant="outline"
                size="sm"
                disabled={running}
                onClick={() => onSend("Open a PR for this branch")}
              >
                <GitPullRequestIcon />
                <span className="hidden sm:inline">Open PR</span>
              </Button>
            )
          )}
          {wbAvailable && (
            <Button
              variant={wbOpen ? "secondary" : "ghost"}
              size="icon-sm"
              title="Workbench"
              onClick={() => setWbOpen(!wbOpen)}
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
          wbAvailable &&
            wbOpen &&
            "lg:grid-cols-[minmax(0,1fr)_minmax(400px,46%)]",
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
          <Conversation className="min-h-0 [mask-image:linear-gradient(to_bottom,transparent,#000_28px)]">
            <ConversationContent
              data-thread
              className="mx-auto w-full max-w-[46rem] gap-7 px-5 py-8"
            >
              {onRewind && root.id && human(root.from) && (
                <RewindCheckpoint
                  running={running}
                  warning={rewindWarning}
                  onRewind={() => onRewind(root.id ?? "")}
                />
              )}
              <div data-msg={root.id} className={flashCls(root.id)}>
                <UserTurn
                  from={root.from}
                  time={root.time}
                  text={root.text}
                  note={`opened session ${thread.session}`}
                  human={human}
                  attachments={root.attachments}
                />
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
                  acts={actsRef}
                />
              ))}
              {transcriptNote && (
                <div
                  data-transcript-note
                  className="rounded-lg border border-dashed px-3 py-2 text-muted-foreground text-xs"
                >
                  {transcriptNote}
                </div>
              )}
            </ConversationContent>
            <ConversationScrollButton />
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
                messages ■ stopped before they landed. */}
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

        {wbAvailable && wbOpen && (
          <>
            <div
              className="fixed inset-0 z-20 bg-black/20 lg:hidden"
              onClick={() => setWbOpen(false)}
            />
            <aside className="lilos-glass flex min-h-0 flex-col border-l bg-background lg:my-2 lg:mr-2 max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:w-[min(560px,100vw)] max-lg:shadow-2xl">
              <Workbench
                thread={thread}
                work={work}
                isDM={isDM}
                lead={lead}
                tab={tab}
                setTab={pickTab}
                onClose={() => setWbOpen(false)}
                onStart={onStart}
                startYields={startCardOpen}
                onSend={(t) => onSend(t)}
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
              />
            </aside>
          </>
        )}
      </div>
    </main>
  );
}
