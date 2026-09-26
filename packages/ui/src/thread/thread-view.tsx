import type { ChatStatus } from "ai";
import { CheckIcon, Maximize2Icon, PlayIcon } from "lucide-react";
import {
  ConversationKeepBottom,
  NotSentTray,
  QueuedTray,
  runningComposer,
} from "../chat/agent-chat";
import { Composer } from "../chat/composer";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "../components/ai-elements/conversation";
import { Button } from "../components/ui/button";
import { openStartRequest, ReplyCards } from "../conversation/cards";
import { AgentTurn, AttachmentChips } from "../conversation/turns";
import { Body, Row, Who } from "../feed/row";
import { SessionUsage } from "../focus/session-usage";
import type {
  AttachedFile,
  Channel,
  EmpFn,
  HumanFn,
  Msg,
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
  work,
  repo,
  onStart,
  running,
  onSend,
  onStop,
  onRetry,
  onUnqueue,
  onSendQueued,
  pending = [],
  accept,
  steer = false,
  onRemovePending,
}: {
  root: Extract<Msg, { kind: "msg" }>;
  thread: Thread;
  channel: Channel;
  emp: EmpFn;
  human: HumanFn;
  resolved: Record<string, string>;
  setResolved?: (r: Record<string, string>) => void;
  onFocus?: () => void;
  work: Work | null;
  repo?: string;
  onStart?: () => void;
  running: boolean;
  onSend: (text: string, files?: AttachedFile[]) => void;
  onStop?: () => void;
  onRetry?: (empId: string) => void;
  onUnqueue?: (i: number) => void;
  onSendQueued?: (i: number) => void;
  /* Messages sent while the turn runs. `steer` (engine declared session.steer) renders them as
     pending-steer chips inside the turn; without it they show in the queued tray instead (issue #9). */
  pending?: string[];
  /* Composer attachment types the host accepts (e.g. "image/*"); absent = no attach UI. */
  accept?: string;
  steer?: boolean;
  onRemovePending?: (i: number) => void;
}) {
  const lead = thread.replies.find((r) => emp(r.from));
  const leadEmp = lead ? emp(lead.from) : undefined;
  const isDM = !!channel.dm;
  const channelLabel = isDM ? `DM · ${channel.name}` : `#${channel.name}`;
  const startCardOpen = openStartRequest(thread, resolved);
  const status: ChatStatus = running
    ? thread.replies.some((r) => r.live && r.phase === "submitted")
      ? "submitted"
      : "streaming"
    : "ready";
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-semibold">
            <span className="truncate">{isDM ? "Session" : "Thread"}</span>
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
            <WsBadge ws={thread.ws} />
          ) : (
            <WorkspaceBadge work={work} repo={repo} />
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {thread.usage && leadEmp && (
            <SessionUsage usage={thread.usage} model={leadEmp.model} />
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
          <Row from={root.from} emp={emp} human={human}>
            <Who id={root.from} time={root.time} emp={emp} human={human} />
            <Body text={root.text} />
            <div className="text-muted-foreground text-xs">
              opened session{" "}
              <code className="rounded bg-muted px-1">{thread.session}</code>
            </div>
          </Row>
          <div className="my-1 flex items-center gap-2 px-3 text-muted-foreground text-xs sm:px-5">
            <span>
              {thread.replies.length}{" "}
              {thread.replies.length === 1 ? "reply" : "replies"}
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>
          {thread.replies.map((r, i) =>
            /* Employee turns render through the one shared AgentTurn — same DOM as Focus,
               wrapped in the row's padding/hover chrome only (issue #19). */
            emp(r.from) ? (
              <div
                key={r.id ?? i}
                className="group px-3 py-2 hover:bg-muted/40 sm:px-5"
              >
                <AgentTurn
                  r={r}
                  emp={emp}
                  last={i === thread.replies.length - 1}
                  onRetry={onRetry}
                  pending={steer ? pending : []}
                  cards={
                    <ReplyCards
                      r={r}
                      i={i}
                      last={i === thread.replies.length - 1}
                      work={work}
                      repo={repo}
                      emp={emp}
                      resolved={resolved}
                      setResolved={setResolved}
                      onStart={onStart}
                    />
                  }
                />
              </div>
            ) : (
              <Row key={r.id ?? i} from={r.from} emp={emp} human={human}>
                <Who id={r.from} time={r.time} emp={emp} human={human} />
                <Body text={r.text} />
                {r.attachments && <AttachmentChips files={r.attachments} />}
              </Row>
            ),
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
        employees={[]}
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
        status={status}
        accept={accept}
        onStop={onStop}
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
