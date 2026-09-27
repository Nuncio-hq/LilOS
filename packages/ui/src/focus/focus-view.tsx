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
  Undo2Icon,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import {
  ConversationKeepBottom,
  NotSentTray,
  plain,
  QueuedTray,
  runningComposer,
} from "../chat/agent-chat";
import { FocusComposer } from "../chat/focus-composer";
import { sessionChoice } from "../chat/model-picker";
import {
  Checkpoint,
  CheckpointIcon,
  CheckpointTrigger,
} from "../components/ai-elements/checkpoint";
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
import { openStartRequest, ReplyCards } from "../conversation/cards";
import { AgentTurn, PrCard, UserTurn } from "../conversation/turns";
import { PHASE_LABEL } from "../lib/helpers";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type {
  AttachedFile,
  Channel,
  EmpFn,
  Employee,
  HostAccessors,
  HumanFn,
  MergeMethod,
  ModelChoice,
  ModelOption,
  ModelPickerExtras,
  Msg,
  Project,
  Thread,
  WbTab,
  Work,
} from "../types";
import { sessionArtifacts } from "../workbench/artifacts";
import type { LiveSurfaces } from "../workbench/live";
import { Workbench } from "../workbench/workbench";
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
  onRetry,
  onUnqueue,
  onSendQueued,
  onRewind,
  onModel,
  picker,
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
  onRemovePending,
  draft,
  onDraftChange,
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
  onRetry?: (empId: string) => void;
  onUnqueue?: (i: number) => void;
  onSendQueued?: (i: number) => void;
  onRewind?: (replyIndex: number) => void;
  onModel?: (c: ModelChoice) => void;
  /* Refresh / Edit models… / provider names — each renders only with its handler. */
  picker?: ModelPickerExtras;
  say?: (t: string) => void;
  models?: ModelOption[];
  repoFiles?: string[];
  /** Live host accessors forwarded to the Workbench (issue #11 fs/git, #37 forge). */
  host?: HostAccessors;
  onPrComment?: (t: string) => void | Promise<void>;
  onPrMerge?: (method: MergeMethod) => void | Promise<void>;
  /** Live harness surfaces for Workbench Terminal/Preview tabs (issue #36). */
  surfaces?: LiveSurfaces;
  /* Mid-turn sends: pending-steer chips when `steer` is declared, the queued tray without it. */
  pending?: string[];
  /* Composer attachment types the host accepts (e.g. "image/*"); absent = no attach UI. */
  accept?: string;
  /* Attachment byte cap + where rejections surface (issue #31). */
  maxFileSize?: number;
  onAttachError?: (message: string) => void;
  steer?: boolean;
  onRemovePending?: (i: number) => void;
}) {
  const [wbOpen, setWbOpen] = useState(() => window.innerWidth >= 1024);
  const [tab, setTab] = useState<WbTab>(() =>
    sessionArtifacts(thread).diffs.length ? "changes" : "terminal",
  );
  const [follow, setFollow] = useState(true);
  const isDM = !!channel.dm;
  const model = thread.model ?? lead?.model ?? models?.[0]?.id;
  const live = thread.replies.find((r) => r.live);
  const lastStep = live?.steps?.[live.steps.length - 1];
  const status: ChatStatus = running
    ? live?.phase === "submitted"
      ? "submitted"
      : "streaming"
    : "ready";
  const todos = thread.todos ?? [];
  const queue = thread.queue ?? [];
  const pendingSteers = pending ?? [];
  // The open "asks to start work" card, if any, is the single start-work entry point (issue #15).
  const startCardOpen = openStartRequest(thread, resolved);
  const liveKey = live
    ? `${live.id}:${live.steps?.length}:${lastStep?.running}`
    : "";
  // Follow the agent: while a turn runs, the workbench jumps to what it is doing (until you pick a tab yourself).
  useEffect(() => {
    if (live) setFollow(true);
  }, [live?.id]);
  // Turn finished with edits → land on Changes, like Codex's review pane.
  const lastDone = [...thread.replies]
    .reverse()
    .find((r) => emp(r.from) && !r.live);
  useEffect(() => {
    if (follow && !live && lastDone?.steps?.some((s) => s.diff))
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
    if (!follow || !lastStep) return;
    if (lastStep.diff) setTab("changes");
    else if (lastStep.tool === "terminal") setTab("terminal");
  }, [liveKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickTab = (t: WbTab) => {
    setTab(t);
    setFollow(false);
    setWbOpen(true);
  };
  const doneTodos = todos.filter((t) => t.status === "completed").length;
  // Plan tray opens while the agent works and folds away when the turn ends (user can still toggle).
  const [planOpen, setPlanOpen] = useState(running);
  useEffect(() => setPlanOpen(running), [running]);
  const where = isDM ? "Direct" : (project?.name ?? "Company");
  const chLabel = isDM ? channel.name : `#${channel.name}`;

  return (
    <main className="flex min-h-0 min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-2 sm:px-3">
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
          <div className="truncate font-semibold" title={plain(root.text)}>
            {plain(root.text)}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
            <span className="truncate">
              {where} / {chLabel}
            </span>
            <span>·</span>
            <span className="shrink-0">{lead?.name}</span>
            <code className="hidden shrink-0 rounded bg-muted px-1 sm:inline">
              {thread.session}
            </code>
            {thread.ws && (
              <span
                className="hidden shrink-0 items-center gap-1 md:flex"
                title={thread.ws.cwd}
              >
                <FolderIcon className="size-3" />
                {thread.ws.project}
              </span>
            )}
            {work?.branch ? (
              <span className="hidden shrink-0 items-center gap-1 rounded bg-emerald-50 px-1 text-emerald-800 md:flex">
                <GitBranchIcon className="size-3" />
                <span className="font-mono">{work.branch}</span>
              </span>
            ) : (
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
              <CircleDotIcon className="size-3 animate-pulse text-amber-500" />
              {live?.phase ? PHASE_LABEL[live.phase] : "working"}
            </span>
          )}
          {thread.usage && model && (
            <SessionUsage usage={thread.usage} model={model} />
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
                <CircleDashedIcon className="animate-spin text-amber-500 [animation-duration:3s]" />
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
          <Button
            variant={wbOpen ? "secondary" : "ghost"}
            size="icon-sm"
            title="Workbench"
            onClick={() => setWbOpen(!wbOpen)}
          >
            {wbOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
          </Button>
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
          wbOpen && "lg:grid-cols-[minmax(0,1fr)_minmax(400px,46%)]",
        )}
      >
        <section className="flex min-h-0 min-w-0 flex-col">
          <Conversation className="min-h-0 [mask-image:linear-gradient(to_bottom,transparent,#000_28px)]">
            <ConversationContent className="mx-auto w-full max-w-[46rem] gap-7 px-5 py-8">
              <UserTurn
                from={root.from}
                time={root.time}
                text={root.text}
                note={`opened session ${thread.session}`}
                human={human}
                attachments={root.attachments}
              />
              {thread.replies.map((r, i) =>
                emp(r.from) ? (
                  <AgentTurn
                    key={r.id ?? i}
                    r={r}
                    emp={emp}
                    last={i === thread.replies.length - 1}
                    onRetry={onRetry}
                    models={models}
                    onOpen={pickTab}
                    pending={steer ? pendingSteers : []}
                    cards={
                      <>
                        <ReplyCards
                          r={r}
                          i={i}
                          last={i === thread.replies.length - 1}
                          work={work}
                          repo={channel.repo}
                          emp={emp}
                          resolved={resolved}
                          setResolved={setResolved}
                          onStart={onStart}
                        />
                        {pr &&
                          !r.live &&
                          r.steps?.some((s) =>
                            String(s.input.command ?? "").startsWith(
                              "gh pr create",
                            ),
                          ) && (
                            <PrCard
                              pr={pr}
                              author={lead?.name ?? pr.author}
                              onOpen={() => pickTab("pr")}
                            />
                          )}
                      </>
                    }
                  />
                ) : (
                  <Fragment key={r.id ?? i}>
                    {!running && onRewind && (
                      <Checkpoint className="text-xs">
                        <CheckpointIcon className="size-3.5" />
                        <CheckpointTrigger
                          size="xs"
                          tooltip="session.undo + rollback.restore: drop this turn and everything after, files included"
                          onClick={() => onRewind(i)}
                        >
                          <Undo2Icon className="size-3" />
                          Restore to here
                        </CheckpointTrigger>
                      </Checkpoint>
                    )}
                    <UserTurn
                      from={r.from}
                      time={r.time}
                      text={r.text}
                      human={human}
                      attachments={r.attachments}
                    />
                  </Fragment>
                ),
              )}
            </ConversationContent>
            <ConversationScrollButton />
            {/* Not-sent tray / plan tray / steer chips grow the area below the conversation;
                re-stick so everything stays visible without scrolling (issue #15). */}
            <ConversationKeepBottom
              signal={`${queue.length}:${todos.length}:${pendingSteers.length}:${running}:${planOpen}`}
            />
          </Conversation>

          <div className="mx-auto w-full max-w-[46rem] shrink-0 px-3 pb-3">
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
                                <CircleDotIcon className="size-2.5 shrink-0 animate-pulse text-amber-500" />
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
            {/* Queued mid-turn sends (engine without steer, issue #9) and the not-sent tray —
                same markup as the thread panel, above the composer there too. queue holds ONLY
                messages ■ stopped before they landed. */}
            <QueuedTray
              items={steer ? [] : pendingSteers}
              onRemove={onRemovePending}
            />
            <NotSentTray
              items={queue}
              onSend={onSendQueued}
              onRemove={onUnqueue}
            />
            <FocusComposer
              running={running}
              status={status}
              choice={
                models?.length
                  ? sessionChoice(thread, lead?.model, models)
                  : undefined
              }
              models={models}
              onModel={onModel}
              picker={picker}
              onStop={onStop}
              placeholder={
                // Terminal takeover (issue #69 AC-2): while the human holds
                // the session's terminal, the agent can't run or write there —
                // the composer says it's paused rather than inviting input.
                surfaces?.termControl === "user"
                  ? `${lead?.name ?? "The agent"} is paused while you use the terminal`
                  : running
                    ? runningComposer(lead?.name ?? "Employee", steer)
                        .placeholder
                    : `Continue session ${thread.session} with ${lead?.name ?? "the employee"}…`
              }
              hint={
                running
                  ? runningComposer(lead?.name ?? "Employee", steer).hint
                  : pr?.status === "merged"
                    ? `#${pr.number} merged, ⎇ ${pr.head} deleted · next edit starts a new branch from main`
                    : work?.branch
                      ? `Edits go to ⎇ ${work.branch}`
                      : "Read-only on main"
              }
              onSend={(t, files) => onSend(t, files)}
              draft={draft}
              onDraftChange={onDraftChange}
              accept={accept}
              maxFileSize={maxFileSize}
              onAttachError={onAttachError}
            />
          </div>
        </section>

        {wbOpen && (
          <>
            <div
              className="fixed inset-0 z-20 bg-black/20 lg:hidden"
              onClick={() => setWbOpen(false)}
            />
            <aside className="flex min-h-0 flex-col border-l bg-background max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:w-[min(560px,100vw)] max-lg:shadow-2xl">
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
              />
            </aside>
          </>
        )}
      </div>
    </main>
  );
}
