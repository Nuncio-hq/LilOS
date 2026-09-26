import type { ChatStatus } from "ai";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleDotIcon,
  CopyIcon,
  LockIcon,
  Maximize2Icon,
  PlayIcon,
  RefreshCcwIcon,
  ShieldAlertIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { NotSentTray, runningComposer, SteerRows } from "../chat/agent-chat";
import { Composer } from "../chat/composer";
import { CodeBlock } from "../components/ai-elements/code-block";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "../components/ai-elements/confirmation";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "../components/ai-elements/conversation";
import {
  MessageAction,
  MessageActions,
} from "../components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "../components/ai-elements/reasoning";
import { Shimmer } from "../components/ai-elements/shimmer";
import { Task, TaskContent, TaskTrigger } from "../components/ai-elements/task";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "../components/ai-elements/tool";
import { Button } from "../components/ui/button";
import { Body, Row, Who } from "../feed/row";
import { SessionUsage } from "../focus/session-usage";
import { plural } from "../lib/helpers";
import { cn } from "../lib/utils";
import type { EmpFn, HumanFn, Msg, Reply, Thread, Work } from "../types";
import { WorkspaceBadge, WsBadge } from "../workbench/ws-badges";

export function ThreadView({
  root,
  thread,
  channelName,
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
  pending,
}: {
  root: Extract<Msg, { kind: "msg" }>;
  thread: Thread;
  channelName: string;
  emp: EmpFn;
  human: HumanFn;
  resolved: Record<string, string>;
  setResolved: (r: Record<string, string>) => void;
  focus: boolean;
  onFocus: () => void;
  work: Work | null;
  repo?: string;
  onStart: () => void;
  running: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onRetry: (empId: string) => void;
  onUnqueue: (i: number) => void;
  onSendQueued: (i: number) => void;
  pending: string[];
}) {
  const [openSteps, setOpenSteps] = useState<Record<number, boolean>>({});
  const lead = thread.replies.find((r) => emp(r.from));
  const leadEmp = lead ? emp(lead.from) : undefined;
  const isDM = channelName.startsWith("DM");
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
            {channelName} · {leadEmp && !isDM && `${leadEmp.name} · `}Hermes{" "}
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
          {!work && !isDM && (
            <Button size="sm" className="ml-1" onClick={onStart}>
              <PlayIcon />
              Start work
            </Button>
          )}
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
          {thread.replies.map((r, i) => {
            const isEmp = !!emp(r.from);
            const steps = r.steps ?? [];
            return (
              <Row key={r.id ?? i} from={r.from} emp={emp} human={human}>
                <Who id={r.from} time={r.time} emp={emp} human={human} />
                {r.reasoning !== undefined && (
                  <Reasoning
                    className="mb-1 w-full"
                    isStreaming={r.live && r.phase === "thinking"}
                    duration={r.thought ?? 0}
                    defaultOpen={!!r.live}
                  >
                    <ReasoningTrigger
                      className="w-fit text-xs"
                      getThinkingMessage={(s, d) =>
                        s ? (
                          <Shimmer duration={1}>Thinking…</Shimmer>
                        ) : (
                          <span>Thought for {d || 1}s</span>
                        )
                      }
                    />
                    <ReasoningContent className="mt-2 border-l-2 pl-3 text-xs">
                      {r.reasoning || "…"}
                    </ReasoningContent>
                  </Reasoning>
                )}
                {steps.length > 0 && (
                  <Task
                    className="mb-1"
                    open={!!openSteps[i] || (!!r.live && r.phase === "tools")}
                    onOpenChange={(o) => setOpenSteps({ ...openSteps, [i]: o })}
                  >
                    <TaskTrigger title={plural(steps.length, "step")}>
                      <div className="flex w-fit cursor-pointer items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground">
                        {steps.some((s) => s.running) ? (
                          <CircleDotIcon className="size-3.5 animate-pulse text-amber-500" />
                        ) : (
                          <CheckIcon className="size-3.5 text-emerald-600" />
                        )}
                        <span>
                          {steps.some((s) => s.running)
                            ? `${steps[steps.length - 1].tool}…`
                            : plural(steps.length, "step")}
                        </span>
                        <LockIcon className="size-3" />
                        <ChevronDownIcon className="size-3.5 transition-transform group-data-[panel-open]:rotate-180" />
                      </div>
                    </TaskTrigger>
                    <TaskContent className="[&>div]:mt-2">
                      {steps.map((s, j) => (
                        <Tool key={j} className="mb-0 bg-background">
                          <ToolHeader
                            title={s.tool}
                            type={`tool-${s.tool}`}
                            state={
                              s.running ? "input-available" : "output-available"
                            }
                          />
                          <ToolContent>
                            <ToolInput input={s.input} />
                            <ToolOutput
                              output={s.output || undefined}
                              errorText={undefined}
                            />
                          </ToolContent>
                        </Tool>
                      ))}
                    </TaskContent>
                  </Task>
                )}
                {r.live && r.phase === "submitted" && (
                  <Shimmer className="text-sm">Opening Hermes session…</Shimmer>
                )}
                {r.streaming ? (
                  <Shimmer>{r.streaming}</Shimmer>
                ) : r.text ? (
                  <Body text={r.text} />
                ) : null}
                {/* Steer rows from the shared agent-chat component (pending + delivered, identical to Focus). */}
                <SteerRows steers={r.steers} pending={pending} live={r.live} />
                {r.phase === "stopped" && (
                  <div className="w-fit rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                    Stopped · session.interrupt
                  </div>
                )}
                {isEmp && !r.live && !r.streaming && r.text && (
                  <MessageActions className="absolute top-1 right-3 gap-0 rounded-md border bg-background p-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                    <MessageAction
                      tooltip="Copy"
                      label="Copy"
                      onClick={() => navigator.clipboard?.writeText(r.text)}
                    >
                      <CopyIcon className="size-3.5" />
                    </MessageAction>
                    {i === thread.replies.length - 1 && (
                      <MessageAction
                        tooltip="Retry turn"
                        label="Retry"
                        onClick={() => onRetry(r.from)}
                      >
                        <RefreshCcwIcon className="size-3.5" />
                      </MessageAction>
                    )}
                  </MessageActions>
                )}
                <ReplyCards
                  r={r}
                  work={work}
                  repo={repo}
                  emp={emp}
                  resolved={resolved}
                  setResolved={setResolved}
                  onStart={onStart}
                />
              </Row>
            );
          })}
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
      </Conversation>
      <Composer
        placeholder={
          running
            ? runningComposer(leadEmp?.name ?? "Employee").placeholder
            : `Reply to ${leadEmp?.name ?? "the thread"} in this session…`
        }
        employees={[]}
        hint={
          running
            ? runningComposer(leadEmp?.name ?? "Employee").hint
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
        onStop={onStop}
        queued={
          <NotSentTray
            items={thread.queue ?? []}
            onSend={onSendQueued}
            onRemove={onUnqueue}
          />
        }
      />
    </div>
  );
}

/* Approval + start-work proposal cards under a reply. */
export function ReplyCards({
  r,
  work,
  repo,
  emp,
  resolved,
  setResolved,
  onStart,
}: {
  r: Reply;
  work: Work | null;
  repo?: string;
  emp: EmpFn;
  resolved: Record<string, string>;
  setResolved: (r: Record<string, string>) => void;
  onStart: () => void;
}) {
  const done = r.approval && resolved[r.approval.id];
  return (
    <>
      {r.startProposal && (
        <div
          className={cn(
            "mt-1 w-full max-w-md overflow-hidden rounded-lg border",
            work ? "border-emerald-200" : "border-violet-300",
          )}
        >
          <div
            className={cn(
              "flex items-center gap-2 px-3 py-2 font-medium text-xs",
              work
                ? "bg-emerald-50 text-emerald-900"
                : "bg-violet-50 text-violet-900",
            )}
          >
            {work ? (
              <>
                <CheckIcon className="size-3.5" />
                Started as {work.ticket}
              </>
            ) : (
              <>
                <PlayIcon className="size-3.5" />
                {emp(r.from)?.name} asks to start work
              </>
            )}
          </div>
          {!work && (
            <div className="space-y-2 p-3">
              <div className="font-medium">{r.startProposal.title}</div>
              <p className="text-muted-foreground text-xs">
                {repo
                  ? `New ticket + worktree on ${repo}. This thread and its Hermes session move there.`
                  : "New ticket. No repo on this channel, so no worktree."}
              </p>
              <div className="flex gap-1.5">
                <Button size="sm" onClick={onStart}>
                  Review & start
                </Button>
                <Button size="sm" variant="ghost">
                  Not yet
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {r.approval &&
        (() => {
          const a = r.approval;
          const answer = (v: string) => setResolved({ ...resolved, [a.id]: v });
          return (
            <Confirmation
              className={cn(
                "mt-1",
                done
                  ? done.startsWith("Denied")
                    ? "border-red-200"
                    : "border-emerald-200"
                  : "border-amber-300 bg-amber-50/50",
              )}
              state={done ? "approval-responded" : "approval-requested"}
              approval={
                done
                  ? {
                      id: a.id,
                      approved: !done.startsWith("Denied"),
                      reason: done,
                    }
                  : { id: a.id }
              }
            >
              <ConfirmationTitle className="flex flex-wrap items-center gap-1.5 pr-2 font-medium text-foreground">
                <ConfirmationRequest>
                  <ShieldAlertIcon className="size-3.5 text-amber-600" />
                  Approval needed · only Oscar can answer
                </ConfirmationRequest>
                <ConfirmationAccepted>
                  <CheckIcon className="size-3.5 text-emerald-600" />
                  {done}
                </ConfirmationAccepted>
                <ConfirmationRejected>
                  <XIcon className="size-3.5 text-red-600" />
                  {done}
                </ConfirmationRejected>
              </ConfirmationTitle>
              <ConfirmationRequest>
                <CodeBlock
                  code={a.command}
                  language="bash"
                  className="text-xs [&_pre]:whitespace-pre-wrap [&_pre]:break-all"
                />
                <p className="text-muted-foreground text-xs">{a.note}</p>
              </ConfirmationRequest>
              <ConfirmationActions className="flex-wrap self-start">
                <ConfirmationAction
                  onClick={() => answer("Allowed once by Oscar")}
                >
                  Allow once
                </ConfirmationAction>
                <ConfirmationAction
                  variant="outline"
                  onClick={() => answer("Always allowed here")}
                >
                  Always here
                </ConfirmationAction>
                <ConfirmationAction
                  variant="ghost"
                  onClick={() => answer("Denied by Oscar")}
                >
                  Deny
                </ConfirmationAction>
              </ConfirmationActions>
            </Confirmation>
          );
        })()}
    </>
  );
}
