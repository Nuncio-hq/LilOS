import type { ChatStatus } from "ai";
import { CheckIcon, Maximize2Icon, PlayIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  ConversationKeepBottom,
  NotSentTray,
  QueuedTray,
  runningComposer,
} from "../chat/agent-chat";
import { Composer } from "../chat/composer";
import { useEscapeKey } from "../chat/composer-keys";
import { ModelPicker, sessionChoice } from "../chat/model-picker";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "../components/ai-elements/conversation";
import { Button } from "../components/ui/button";
import { openStartRequest, ReplyCards } from "../conversation/cards";
import type { PlanAction } from "../conversation/plan-card";
import { AgentTurn, AttachmentChips } from "../conversation/turns";
import { Body, Row, Who } from "../feed/row";
import { SessionUsage } from "../focus/session-usage";
import { cn } from "../lib/utils";
import type {
  AttachedFile,
  Channel,
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
  Thread,
  Work,
} from "../types";
import { WorkspaceBadge, WsBadge } from "../workbench/ws-badges";

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
  accept,
  maxFileSize,
  maxFiles,
  onAttachError,
  steer = false,
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
  onOpenSession,
  onPlan,
}: {
  root: Extract<Msg, { kind: "msg" }>;
  thread: Thread;
  channel: Channel;
  emp: EmpFn;
  human: HumanFn;
  resolved: Record<string, string>;
  setResolved?: (r: Record<string, string>) => void;
  onFocus?: () => void;
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
  /* Messages sent while the turn runs. `steer` (engine declared session.steer) renders them as
     pending-steer chips inside the turn; without it they show in the queued tray instead (issue #9). */
  pending?: string[];
  /* Composer attachment types the host accepts (e.g. "image/*"); absent = no attach UI. */
  accept?: string;
  /* Attachment byte cap + count cap + where rejections surface (issue #31). */
  maxFileSize?: number;
  maxFiles?: number;
  onAttachError?: (message: string) => void;
  steer?: boolean;
  onRemovePending?: (i: number) => void;
  /* Why the working transcript can't be shown (harness down, engine restarted) —
     rendered as a muted note where the transcript would be (issue #28). */
  transcriptNote?: string;
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
  /* A subagent row that is another employee links to their session (issue #170). */
  onOpenSession?: (employeeId: string, session: string) => void;
  /* Plan card decisions (issue #175). */
  onPlan?: (a: PlanAction, planId: string) => void;
}) {
  const lead = thread.replies.find((r) => emp(r.from));
  const leadEmp = lead ? emp(lead.from) : undefined;
  const isDM = !!channel.dm;
  /* Esc closes the peek — same ownership rules as Focus's Esc→back (issue
     #195 AC-1): a field's Esc and an open overlay's Esc stay theirs. */
  useEscapeKey(onClose);
  const channelLabel = isDM ? `DM · ${channel.name}` : `#${channel.name}`;
  const startCardOpen = openStartRequest(thread, resolved);
  /* #138 AC-3: jump-to-hit — scroll the message into view, flash it, hand
     back control. Waits for the row to render (history may still load). */
  const bodyRef = useRef<HTMLDivElement>(null);
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
    el.scrollIntoView({ block: "center" });
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
  const status: ChatStatus = running
    ? thread.replies.some((r) => r.live && r.phase === "submitted")
      ? "submitted"
      : "streaming"
    : "ready";
  return (
    <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-semibold">
            {/* #137 AC-4: the session's title (placeholder → engine-written)
                leads the header; untitled threads keep the kind label. */}
            <span className="truncate" data-session-title>
              {thread.title || (isDM ? "Session" : "Thread")}
            </span>
            {work?.ticket && (
              <span className="shrink-0 font-mono text-muted-foreground text-xs">
                · {work.ticket}
              </span>
            )}
          </div>
          <div className="truncate text-muted-foreground text-xs">
            {channelLabel} · {leadEmp && !isDM && `${leadEmp.name} · `}Hermes{" "}
            <code className="rounded bg-muted px-1">{thread.session}</code>
          </div>
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
          ) : (
            <WorkspaceBadge work={work} repo={repo} />
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {thread.usage && leadEmp && (
            <SessionUsage
              usage={thread.usage}
              model={leadEmp.model}
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
      <Conversation className="min-h-0">
        <ConversationContent className="gap-0 p-0 py-2">
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
                opened session{" "}
                <code className="rounded bg-muted px-1">{thread.session}</code>
              </div>
            </Row>
          </div>
          <div className="my-1 flex items-center gap-2 px-3 text-muted-foreground text-xs sm:px-5">
            <span>
              {thread.replies.length}{" "}
              {thread.replies.length === 1 ? "reply" : "replies"}
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>
          {thread.replies.map((r, i) => (
            /* Employee turns render through the one shared AgentTurn — same DOM as Focus,
               wrapped in the row's padding/hover chrome only (issue #19). The
               data-msg wrapper is the search-hit scroll/flash anchor (#138). */
            <div
              key={r.id ?? i}
              data-msg={r.id}
              className={cn(
                "transition-colors duration-500",
                flash === r.id && "bg-amber-100 dark:bg-amber-900/40",
              )}
            >
              {emp(r.from) ? (
                <div className="group px-3 py-2 hover:bg-muted/40 sm:px-5">
                  <AgentTurn
                    r={r}
                    emp={emp}
                    human={human}
                    last={i === thread.replies.length - 1}
                    onRetry={onRetry}
                    models={models}
                    onOpenSession={onOpenSession}
                    onPlan={onPlan}
                    pending={steer ? pending : []}
                    cards={
                      <ReplyCards
                        r={r}
                        i={i}
                        last={i === thread.replies.length - 1}
                        work={work}
                        repo={repo}
                        emp={emp}
                        human={human}
                        resolved={resolved}
                        setResolved={setResolved}
                        onStart={onStart}
                      />
                    }
                  />
                </div>
              ) : (
                <Row from={r.from} emp={emp} human={human}>
                  <Who id={r.from} time={r.time} emp={emp} human={human} />
                  <Body text={r.text} />
                  {r.attachments && <AttachmentChips files={r.attachments} />}
                </Row>
              )}
            </div>
          ))}
          {transcriptNote && (
            <div
              data-transcript-note
              className="mx-3 my-2 rounded-lg border border-dashed px-3 py-2 text-muted-foreground text-xs sm:mx-5"
            >
              {transcriptNote}
            </div>
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
                    Session <span className="font-mono">{thread.session}</span>{" "}
                    moved to the worktree. Same session, no history lost.
                  </li>
                )}
              </ul>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
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
            ? runningComposer(leadEmp?.name ?? "Employee", steer).placeholder
            : `Reply to ${leadEmp?.name ?? "the thread"} in this session…`
        }
        employees={mentionables ?? []}
        onSearchFiles={onSearchFiles}
        hint={
          running
            ? runningComposer(leadEmp?.name ?? "Employee", steer).hint
            : work?.branch
              ? `Edits go to ⎇ ${work.branch}`
              : work
                ? "Ticket only. No repo on this channel."
                : repo
                  ? "Read-only on main. Start work to edit code."
                  : `session ${thread.session}`
        }
        onSend={onSend}
        draft={draft}
        onDraftChange={onDraftChange}
        status={status}
        lastSent={lastSent}
        accept={accept}
        maxFileSize={maxFileSize}
        maxFiles={maxFiles}
        onAttachError={onAttachError}
        onStop={onStop}
        tools={
          onModel && models?.length ? (
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
          ) : undefined
        }
        queued={
          <>
            {/* Without steer, mid-turn sends queue here and auto-run at turn end (issue #9). */}
            <QueuedTray
              items={steer ? [] : pending}
              onRemove={onRemovePending}
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
