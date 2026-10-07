import type { ChatStatus } from "ai";
import { CheckIcon, Maximize2Icon, PlayIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { AccessPill } from "../chat/access-pill";
import {
  ConversationKeepBottom,
  NotSentTray,
  QueuedTray,
  type QueuedTrayItem,
  queuedItemText,
  ReconnectingLine,
  runningComposer,
  waitingComposer,
} from "../chat/agent-chat";
import { Composer } from "../chat/composer";
import { ModelPicker, sessionChoice } from "../chat/model-picker";
import { useUiLayer } from "../chat/ui-layers";
import {
  Conversation,
  ConversationContent,
} from "../components/ai-elements/conversation";
import { Button } from "../components/ui/button";
import { askKeyDown, pendingAsk } from "../conversation/ask-keys";
import { openStartRequest } from "../conversation/cards";
import { FindUnstubAnchor, FindUnstubNudge } from "../conversation/find-unstub";
import { landJump } from "../conversation/jump-to-hit";
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
import { AttachmentChips } from "../conversation/turns";
import { Body, Row, Who } from "../feed/row";
import { SessionUsage } from "../focus/session-usage";
import { sessionModelId } from "../lib/context-window";
import { cn } from "../lib/utils";
import type {
  AttachedFile,
  Channel,
  ConversationAccess,
  EmpFn,
  Employee,
  FileMention,
  HumanFn,
  ModelChoice,
  ModelOption,
  ModelPickerExtras,
  Msg,
  OsApp,
  OsEditor,
  QuestionAsk,
  Thread,
  TranscriptNote,
  WbTab,
  Work,
} from "../types";
import { VIEWER_ID } from "../types";
import { WorkspaceBadge, WsBadge } from "../workbench/ws-badges";

/* #134/#430: the "Rewind to here" checkpoint lives in
   conversation/turn-rows.tsx so both frames share the memoized row. */

/* The right-panel frame around the conversation — channel threads AND DM sessions (issue #19).
   The employee turns render through the shared AgentTurn (identical to Focus); human turns keep
   the compact feed Row. DM-ness comes only from channel.dm — never the display name (AC-3). */
export function ThreadView({
  root,
  thread,
  channel,
  emp,
  human,
  resolved,
  setResolved,
  onFocus,
  onOpenTab,
  onClose,
  work,
  repo,
  onStart,
  running,
  onSend,
  onStop,
  lastSent,
  onRetry,
  onUnqueue,
  onSendQueued,
  pending = [],
  reconnecting,
  accept,
  maxFileSize,
  maxFiles,
  onAttachError,
  steer = false,
  agentWorking = false,
  onRemovePending,
  models,
  onModel,
  picker,
  defaultModel,
  defaultProvider,
  transcriptNote,
  mentionables,
  onSearchFiles,
  scrollTo,
  onScrolled,
  draft,
  onDraftChange,
  editors,
  onOpenPath,
  onRewind,
  rewindWarning,
  seedFiles,
  onSeededFiles,
  onOpenSession,
  onPlan,
  onAnswer,
  onCancel,
  access,
  onAccess,
}: {
  root: Extract<Msg, { kind: "msg" }>;
  thread: Thread;
  channel: Channel;
  emp: EmpFn;
  human: HumanFn;
  resolved: Record<string, string>;
  setResolved?: (r: Record<string, string>) => void;
  onFocus?: () => void;
  /* Opens Focus on a Workbench tab — makes the turn's "N subagents · Open" / "N files changed"
     links live in the panel (#317). Absent = those stay in-place / plain text. */
  onOpenTab?: (t: WbTab) => void;
  /* Esc → close the panel (issue #195 AC-1); absent → Esc does nothing (D-#19). */
  onClose?: () => void;
  work: Work | null;
  repo?: string;
  onStart?: () => void;
  running: boolean;
  /* Return a promise to delay clearing the composer draft until it resolves;
     a rejected send keeps the text (issue #103, AC-5). */
  onSend: (text: string, files?: AttachedFile[]) => void | Promise<unknown>;
  onStop?: () => void;
  /* Host-held composer draft for this conversation (issue #103); omitted, the
     composer keeps its own state. */
  draft?: string;
  onDraftChange?: (v: string) => void;
  /* ↑ recall for the thread composer: the host's last sent message in this
     conversation (issue #104 AC-5). */
  lastSent?: string;
  /* Engine-reported models + pick handler (issue #30); no onModel → no picker (D-#19). */
  models?: ModelOption[];
  onModel?: (c: ModelChoice) => void;
  /* Refresh / Edit models… / provider names — each renders only with its handler. */
  picker?: ModelPickerExtras;
  /* The engine's `models.list.default` — the unpinned-employee pick (#92 AC-5). */
  defaultModel?: string;
  /* The default's provider — a `{provider?, id}` pair disambiguates a shared id. */
  defaultProvider?: string;
  onRetry?: (empId: string) => void;
  onUnqueue?: (i: number) => void;
  onSendQueued?: (i: number) => void;
  /* Messages sent while the turn runs that the agent hasn't read yet. They wait in the tray above the
     composer; `steer` (engine declared session.steer) only changes when they get read (issue #9).
     A `{text, removable}` row the engine already holds hides its Edit/Remove (#315). */
  pending?: QueuedTrayItem[];
  /* #557: the relay socket is down and the client is redialing — a thin
     "Reconnecting…" line over the composer; the send waits and lands once
     the socket is back. */
  reconnecting?: boolean;
  /* Composer attachment types the host accepts (e.g. "image/*"); absent = no attach UI. */
  accept?: string;
  /* Attachment byte cap + count cap + where rejections surface (issue #31). */
  maxFileSize?: number;
  maxFiles?: number;
  onAttachError?: (message: string) => void;
  steer?: boolean;
  /* #308: the running turn is engine-initiated (a leg) — Enter queues,
     and the composer names whose work it is instead of offering to
     steer. */
  agentWorking?: boolean;
  onRemovePending?: (i: number) => void;
  /* A note on the transcript's state — the kind picks the slot (#532):
     "trimmed" heads the transcript (#431 — history missing above the
     first entry); "unavailable" tails it (#28 — the live tail can't
     replay). */
  transcriptNote?: TranscriptNote;
  /* os.editors result + the os.open call bound to the session folder
     (issue #110): the folder badge gains an "Open in …/Reveal in Finder"
     menu only when both are passed (D-#19). */
  editors?: OsEditor[];
  onOpenPath?: (path: string, app: OsApp, line?: number) => void;
  /* `@` menu sections (#105): employees for mention; a file/dir search for
     the Files section — passed only when the session has a folder (cwd). */
  mentionables?: Employee[];
  onSearchFiles?: (query: string) => Promise<FileMention[]>;
  /* A message id to bring into view — set when the user opens a search hit
     (issue #138 AC-3): scrolls the message center into view and flashes it
     briefly. Retried while replies stream in. */
  scrollTo?: string;
  /* Fired once the scroll happened; the host clears `scrollTo` there. */
  onScrolled?: () => void;
  /* #134 "Rewind to here" on every user row (root included): the host drops
     the message + everything after and restores the folder to the pre-turn
     checkpoint. Disabled while a turn runs (AC-5). */
  onRewind?: (messageId: string) => void;
  /* AC-5: when another session shares this folder a click must confirm first
     — the string names the sharer. */
  rewindWarning?: string;
  /* AC-4: rewound message images re-entering the composer — forwarded to the
     Composer's `seedFiles`. */
  seedFiles?: AttachedFile[];
  onSeededFiles?: () => void;
  /* A subagent row that is another employee links to their session (issue #170). */
  onOpenSession?: (employeeId: string, session: string) => void;
  /* Plan card decisions (issue #175). */
  onPlan?: (a: PlanAction, planId: string) => void;
  /* #420: question-ask answer/cancel — passed, the handler owns the
     resolved write (the card locks as "Sending…" until it lands). */
  onAnswer?: (q: QuestionAsk, a: QuestionAnswer) => void;
  onCancel?: (q: QuestionAsk) => void;
  /* #106: the thread's access level + toggle → the composer pill.
     Both or neither (D-#19: no access record, no control). */
  access?: ConversationAccess;
  onAccess?: (a: ConversationAccess) => void;
}) {
  const lead = thread.replies.find((r) => emp(r.from));
  const leadEmp = lead ? emp(lead.from) : undefined;
  const isDM = !!channel.dm;
  /* The panel is one UI layer: Esc closes it only while it is the top-most
     surface (an open dialog or menu above it keeps Esc, #576), and while
     top-most it owns the surface keys — ⌘. stops a running turn, ↵/⌫
     answer the newest pending approval/plan card (#558). */
  const keyAsk = pendingAsk(thread.replies, resolved, !!onPlan);
  const viewer = human(VIEWER_ID)?.name ?? "you";
  useUiLayer({
    onEscape: onClose,
    onKey: (e) =>
      askKeyDown(e, {
        ask: keyAsk,
        viewer,
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
  const channelLabel = isDM ? `DM · ${channel.name}` : `#${channel.name}`;
  const startCardOpen = openStartRequest(thread, resolved);
  /* #138 AC-3: jump-to-hit — scroll the message into view, flash it, hand
     back control. Waits for the row to render (history may still load).
     #570: `landJump` releases the bottom pin before the native write (an
     in-flight spring would overwrite it before its scroll event lands an
     escape) and keeps the row landed while born-stubs hydrate around it. */
  const bodyRef = useRef<HTMLDivElement>(null);
  const convCtx = useRef<StickToBottomContext | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!scrollTo) {
      flashedRef.current = null;
      return;
    }
    if (flashedRef.current === scrollTo) return;
    const el = bodyRef.current?.querySelector(
      `[data-msg="${CSS.escape(scrollTo)}"]`,
    );
    if (!el) return;
    flashedRef.current = scrollTo;
    landJump(el, convCtx.current?.state ?? null);
    setFlash(scrollTo);
    onScrolled?.();
  }, [scrollTo, thread.replies, onScrolled]);
  /* The flash window lives in its own effect — the scroll effect's cleanup
     would cancel it when onScrolled clears scrollTo. */
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(t);
  }, [flash]);
  /* #420 + #583 AC-1: a live reply parked on ANY open ask (question,
     approval, plan) is WAITING, not working — the composer placeholder
     says what it waits on. A question ask also parks the composer itself
     (Send, not Stop — Hermes FIX #515); an approval/plan-parked turn is
     still interruptible and steerable, so it keeps Stop (⌘.), steers and
     the running hint — only the placeholder names the wait. `waitingOn`
     carries the ask kind so the placeholder names it. */
  const waitingReply = thread.replies.find(
    (r) => r.live && r.phase === "waiting",
  );
  const waiting = running && !!waitingReply;
  const parkedOnQuestion = waiting && waitingReply?.waitingOn === "question";
  /* #583 AC-3: background processes still running under this thread. */
  const runningJobs =
    thread.jobs?.filter((j) => j.status === "running").length ?? 0;
  const status: ChatStatus = running
    ? parkedOnQuestion
      ? "ready"
      : thread.replies.some((r) => r.live && r.phase === "submitted")
        ? "submitted"
        : "streaming"
    : "ready";
  /* #419: the Retry lives on the last TURN — system notes (a failed turn's
     error row) sit below it and don't count. */
  const lastTurnIdx = thread.replies.reduce(
    (a, r, i) => (emp(r.from) ? i : a),
    -1,
  );
  /* #430: row handlers ride a ref rewritten each render — the memoized
     TurnRow never sees a fresh callback identity, and its reads are always
     the latest closures. */
  const actsRef = useRef<TurnActs>({});
  actsRef.current = {
    onRetry,
    onOpen: onOpenTab,
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
        ? thread.replies.map((r) => estTurnHeight(r, !!emp(r.from), "panel"))
        : [],
    [lazyRows, thread.replies, emp],
  );
  const tailStart = openTailStart(estHeights);
  /* A scrollTo open skips the pin — but only while the target row is in
     this thread's replies. A stale id (hit trimmed or rewound away) must
     not keep suppressing the pin on every later open. */
  const jumpPending =
    !!scrollTo &&
    (root.id === scrollTo || thread.replies.some((r) => r.id === scrollTo));
  return (
    <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
      <div className="lilos-drag flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-semibold">
            {/* #137 AC-4: the session's title (placeholder → engine-written)
                leads the header; untitled threads keep the kind label. */}
            <span className="truncate" data-session-title>
              {thread.title || "Thread"}
            </span>
            {work?.ticket && (
              <span className="shrink-0 font-mono text-muted-foreground text-xs">
                · {work.ticket}
              </span>
            )}
          </div>
          <div
            className="truncate text-muted-foreground text-xs"
            title={`Thread ${thread.session}`}
          >
            {channelLabel}
            {leadEmp && !isDM && ` · ${leadEmp.name}`}
            {/* #583 AC-3: a live background job says so right under the
                title — "1 running in background". */}
            {runningJobs > 0 && (
              <span data-bg-jobs className="text-work">
                {" "}
                · {runningJobs} running in background
              </span>
            )}
          </div>
          {/* A folder-less DM session is a plain chat — no folder label
              at all (#196). */}
          {thread.ws ? (
            <WsBadge
              ws={thread.ws}
              openMenu={
                onOpenPath
                  ? {
                      editors: editors ?? [],
                      onOpen: (app) => onOpenPath(".", app),
                    }
                  : undefined
              }
            />
          ) : isDM && !work && !repo ? null : (
            <WorkspaceBadge work={work} repo={repo} />
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {thread.usage && leadEmp && (
            /* The SESSION's model — never the employee's (#294): the panel
               and Focus resolve through the same helper and the window comes
               engine-reported on the usage/catalog, not an employee row. */
            <SessionUsage
              usage={thread.usage}
              model={sessionModelId(
                thread,
                leadEmp.model,
                models,
                defaultModel,
                defaultProvider,
              )}
              models={models}
            />
          )}
          {!work && !isDM && onStart && (
            // While the request card below is open the header button must not compete with it (issue
            // #15): disabled + tooltip. The title lives on the wrapper because the disabled button
            // itself ignores pointer events.
            <span
              className="ml-1 inline-flex shrink-0"
              title={
                startCardOpen
                  ? "Answer the request below"
                  : "New ticket + worktree for this thread"
              }
            >
              <Button
                size="sm"
                onClick={onStart}
                disabled={startCardOpen}
                data-startwork-header
              >
                <PlayIcon />
                Start work
              </Button>
            </span>
          )}
          {onFocus && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-0.5"
              title="Focus"
              aria-label="Focus"
              onClick={onFocus}
            >
              <Maximize2Icon />
            </Button>
          )}
        </div>
      </div>
      {/* #570: the first pin on a lazy thread must land instantly — the
          default smooth sweep would scroll through the whole stub field
          and mount every row it passes, recreating the open-time freeze.
          A scrollTo open skips the pin outright (initial=false): the jump
          would otherwise race the pin's first write before the escape
          check lands. `resize` stays smooth: the streaming chase is
          unchanged. */}
      <Conversation
        className="min-h-0"
        contextRef={convCtx}
        initial={jumpPending ? false : lazyRows ? "instant" : "smooth"}
      >
        {/* The composer sits below the scroller in normal flow — nothing
            overlays the last turn, so only a small bottom pad is needed;
            the question card's Skip row stays fully visible on its own row
            (#515, #602). */}
        <ConversationContent className="gap-0 p-0 pt-2 pb-3">
          {transcriptNote?.kind === "trimmed" && (
            <TranscriptNoteRow note={transcriptNote} />
          )}
          <div
            data-msg={root.id}
            className={cn(
              "transition-colors duration-500",
              flash === root.id && "bg-amber-100 dark:bg-amber-900/40",
            )}
          >
            <Row from={root.from} emp={emp} human={human}>
              <Who id={root.from} time={root.time} emp={emp} human={human} />
              <Body text={root.text} />
              {root.attachments && <AttachmentChips files={root.attachments} />}
              <div className="text-muted-foreground text-xs">
                opened thread{" "}
                <code className="rounded bg-muted px-1">{thread.session}</code>
              </div>
              {onRewind && root.id && human(root.from) && (
                <RewindHover
                  running={running}
                  warning={rewindWarning}
                  onRewind={() => onRewind(root.id ?? "")}
                />
              )}
            </Row>
          </div>
          <div className="my-1 flex items-center gap-2 px-3 text-muted-foreground text-xs sm:px-5">
            {/* #585: system notes aren't replies — the count skips them. */}
            <span>
              {thread.replies.filter((r) => !r.system).length}{" "}
              {thread.replies.filter((r) => !r.system).length === 1
                ? "reply"
                : "replies"}
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>
          {thread.replies.map((r, i) => (
            /* Employee turns render through the one shared AgentTurn — same DOM as Focus,
               wrapped in the row's padding/hover chrome only (issue #19). The
               data-msg wrapper is the search-hit scroll/flash anchor (#138).
               #430: memoized per row — a delta re-renders only the turn it
               touched; long threads hold far-off-screen rows as stubs. */
            <TurnRow
              key={r.turnId ?? r.id ?? i}
              frame="panel"
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
              repo={repo}
              models={models}
              rewindWarning={rewindWarning}
              keyTarget={keyTarget}
              acts={actsRef}
            />
          ))}
          {transcriptNote?.kind === "unavailable" && (
            /* Same outer insets as the #28 note this replaces — the panel's
               content column carries no horizontal padding. */
            <TranscriptNoteRow
              note={transcriptNote}
              className="mx-3 my-2 sm:mx-5"
            />
          )}
          {work?.by && (
            <div className="mx-3 my-2 rounded-lg border border-emerald-200 bg-emerald-50/40 p-3 text-xs sm:mx-5">
              <div className="flex items-center gap-1.5 font-medium text-emerald-900">
                <PlayIcon className="size-3.5" />
                {work.by} started work · {work.ticket}
              </div>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                <li className="flex gap-1.5">
                  <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                  Ticket{" "}
                  <span className="font-mono text-foreground">
                    {work.ticket}
                  </span>{" "}
                  created from this thread
                </li>
                {work.branch && (
                  <li className="flex gap-1.5">
                    <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                    <span className="min-w-0 break-all font-mono">
                      git worktree add .lilos/wt/{work.ticket.toLowerCase()} -b{" "}
                      {work.branch}
                    </span>
                  </li>
                )}
                {work.branch && (
                  <li className="flex gap-1.5">
                    <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                    Thread <span className="font-mono">{thread.session}</span>{" "}
                    moved to the worktree. Same thread, no history lost.
                  </li>
                )}
              </ul>
            </div>
          )}
        </ConversationContent>
        {/* The ↓ never overlaps a pending question card — the guard hides
            it while an open card intersects the port (FIX #515 r4). */}
        <QuestionAwareScrollButton />
        <FindUnstubNudge />
        <FindUnstubAnchor lazy={lazyRows} />
        {/* The not-sent tray and pending-steer chips grow the composer area below; re-stick so the
           stopped turn + tray are both fully visible (issue #15). Inside <Conversation> so it can
           use the stick-to-bottom context. */}
        <ConversationKeepBottom
          signal={`${(thread.queue ?? []).length}:${pending.length}`}
        />
      </Conversation>
      <Composer
        placeholder={
          running
            ? waiting
              ? waitingComposer(
                  leadEmp?.name ?? "Employee",
                  waitingReply?.waitingOn,
                ).placeholder
              : runningComposer(
                  leadEmp?.name ?? "Employee",
                  steer,
                  agentWorking,
                ).placeholder
            : `Reply to ${leadEmp?.name ?? "the employee"}…`
        }
        employees={mentionables ?? []}
        onSearchFiles={onSearchFiles}
        hint={
          running
            ? parkedOnQuestion
              ? waitingComposer(
                  leadEmp?.name ?? "Employee",
                  waitingReply?.waitingOn,
                ).hint
              : runningComposer(
                  leadEmp?.name ?? "Employee",
                  steer,
                  agentWorking,
                ).hint
            : work?.branch
              ? `Edits go to ⎇ ${work.branch}`
              : work
                ? "Ticket only. No repo on this channel."
                : repo
                  ? "Read-only on main. Start work to edit code."
                  : isDM
                    ? `Reply to ${leadEmp?.name ?? "the employee"}…`
                    : `thread ${thread.session}`
        }
        onSend={onSend}
        draft={draft}
        onDraftChange={onDraftChange}
        seedFiles={seedFiles}
        onSeededFiles={onSeededFiles}
        status={status}
        lastSent={lastSent}
        accept={accept}
        maxFileSize={maxFileSize}
        maxFiles={maxFiles}
        onAttachError={onAttachError}
        onStop={onStop}
        tools={
          <>
            {onModel && models?.length ? (
              <ModelPicker
                value={sessionChoice(
                  thread,
                  leadEmp?.model,
                  models,
                  defaultModel,
                  defaultProvider,
                )}
                models={models}
                onChoice={onModel}
                {...picker}
              />
            ) : undefined}
            {access !== undefined && onAccess ? (
              <AccessPill access={access} onAccess={onAccess} />
            ) : undefined}
          </>
        }
        queued={
          <>
            {reconnecting && <ReconnectingLine />}
            {/* Every mid-turn send waits here until the agent reads it — steer or not (issue #9). */}
            <QueuedTray
              items={pending}
              steer={steer}
              name={leadEmp?.name}
              onRemove={onRemovePending}
              onEdit={
                onRemovePending && onDraftChange
                  ? (i) => {
                      onDraftChange(
                        pending[i] ? queuedItemText(pending[i]) : "",
                      );
                      onRemovePending(i);
                    }
                  : undefined
              }
            />
            <NotSentTray
              items={thread.queue ?? []}
              onSend={onSendQueued}
              onRemove={onUnqueue}
            />
          </>
        }
      />
    </div>
  );
}
