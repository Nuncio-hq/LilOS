import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CopyIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  LockIcon,
  PaperclipIcon,
  RefreshCcwIcon,
} from "lucide-react";
import { useState } from "react";
import { SteerRows } from "../chat/agent-chat";
import { effortLabel } from "../chat/model-picker";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "../components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "../components/ai-elements/reasoning";
import { Shimmer } from "../components/ai-elements/shimmer";
import { Task, TaskContent, TaskTrigger } from "../components/ai-elements/task";
import { Tool, ToolContent, ToolHeader } from "../components/ai-elements/tool";
import { Badge } from "../components/ui/badge";
import { useTurnBlockState } from "../lib/block-state";
import { plural } from "../lib/helpers";
import { withFileMentionChips } from "../lib/mentions";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type {
  AttachedFile,
  EmpFn,
  HumanFn,
  ModelOption,
  PullRequest,
  Reply,
  Step,
  WbTab,
} from "../types";
import { VIEWER_ID } from "../types";
import { turnChangedFiles } from "../workbench/artifacts";
import { type PlanAction, PlanCard } from "./plan-card";
import { StepDetail } from "./step-detail";
import { SubagentsLink, TurnSubagents } from "./subagents";

/* The conversation's turns — ONE implementation used by both frames (issue #19):
   ThreadView renders it for channel threads and DM sessions, FocusView for Focus.
   Optional controls render only when their handler is passed:
   Retry → onRetry, the "N files changed" link → onOpen (opens a workbench tab — the thread
   panel has no workbench, so the count stays plain text there), card content → cards. */

/* Files sent with a message, shown as chips under the body — the same shape the composer
   shows before send, so an attached image reads the same in both places. Image files
   with a `url` (a data URL while bytes ride with the message) show a thumbnail. */
export function AttachmentChips({ files }: { files: AttachedFile[] }) {
  if (!files.length) return null;
  return (
    <div data-attachments className="flex flex-wrap gap-1.5 pt-1">
      {files.map((f, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs"
        >
          {f.url && f.mediaType.startsWith("image/") ? (
            <img
              src={f.url}
              alt={f.name}
              className="size-8 rounded-sm object-cover"
            />
          ) : (
            <PaperclipIcon className="size-3 text-muted-foreground" />
          )}
          <span className="max-w-48 truncate font-medium">{f.name}</span>
        </span>
      ))}
    </div>
  );
}

export function UserTurn({
  from,
  time,
  text,
  note,
  human,
  attachments,
}: {
  from: string;
  time: string;
  text: string;
  note?: string;
  human: HumanFn;
  attachments?: AttachedFile[];
}) {
  return (
    <Message from="user" className="lilos-rise max-w-[80%] gap-1" data-userturn>
      <MessageContent className="rounded-2xl px-4 py-2.5 text-[15px] leading-[1.6]">
        <MessageResponse className="lilos-prose break-words">
          {withFileMentionChips(text)}
        </MessageResponse>
        {attachments && <AttachmentChips files={attachments} />}
      </MessageContent>
      <div className="ml-auto text-[12px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
        {human(from)?.name ?? from} · {time}
        {note && <> · {note}</>}
      </div>
    </Message>
  );
}

/* All tool calls of a turn collapse into ONE Task block (the panel style the client picked in
   #19): a "N steps" trigger — or the running tool's name — that expands into one Tool card
   per step. While the turn is in the tools phase the block opens itself (#320:
   that's only the DEFAULT — the first user click wins for the rest of the
   turn, in either direction). */
export function TurnSteps({
  steps,
  autoOpen,
  waitingApproval,
  openKey,
}: {
  steps: Step[];
  autoOpen?: boolean;
  /* The turn is parked on an approval (engine request.opened): the running
     step's card reads "Waiting for approval" (issue #71, AC-4). */
  waitingApproval?: boolean;
  /* Conv-scoped persist key — survives card remounts (#320). */
  openKey?: string;
}) {
  const [userSet, setUserSet] = useTurnBlockState<boolean | undefined>(
    openKey,
    undefined,
  );
  const running = steps.some((s) => s.running);
  return (
    <Task
      className="mb-1"
      open={userSet ?? !!autoOpen}
      onOpenChange={setUserSet}
      data-tasksteps
    >
      <TaskTrigger title={plural(steps.length, "step")}>
        <div className="flex w-fit cursor-pointer items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground">
          {running ? (
            <CircleDotIcon className="size-3.5 animate-pulse text-work" />
          ) : (
            <CheckIcon className="size-3.5 text-emerald-600" />
          )}
          <span>
            {running
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
                s.running
                  ? waitingApproval
                    ? "approval-requested"
                    : "input-available"
                  : "output-available"
              }
              badge={
                s.dispatched ? (
                  <Badge
                    className="gap-1.5 rounded-full text-xs"
                    variant="secondary"
                  >
                    <CircleDotIcon className="size-4 animate-pulse text-work" />
                    Dispatched
                  </Badge>
                ) : undefined
              }
            />
            <ToolContent className="space-y-0 px-3 pt-0 pb-3">
              <StepDetail s={s} />
            </ToolContent>
          </Tool>
        ))}
      </TaskContent>
    </Task>
  );
}

export function AgentTurn({
  r,
  emp,
  human,
  last,
  onRetry,
  onOpen,
  cards,
  models,
  onOpenSession,
  onPlan,
  keyTarget,
}: {
  r: Reply;
  emp: EmpFn;
  /** Resolves the steer rows' author label (viewer name; #118). */
  human?: HumanFn;
  /** Engine catalog — the footer renders the model's display name, not the id. */
  models?: ModelOption[];
  /** True on the last reply of the thread — Retry only makes sense there. */
  last: boolean;
  /** When absent the turn shows no Retry action. */
  onRetry?: (empId: string) => void;
  /** When absent the "N files changed" footer is plain text, not a link. */
  onOpen?: (t: WbTab) => void;
  /** Frame-attached pieces under the turn (approval card, start-work card, PR card). */
  cards?: React.ReactNode;
  /** Opens another employee's session a subagent row links to (issue #170). */
  onOpenSession?: (employeeId: string, session: string) => void;
  /** Approve / Change / Reject on the plan this turn proposed (issue #175). */
  onPlan?: (a: PlanAction, planId: string) => void;
  /** #558: id of the card the keyboard answers — a waiting plan carries
      the ↵/⌫ hint when it matches. */
  keyTarget?: string;
}) {
  const e = emp(r.from);
  const steps = r.steps ?? [];
  const files = turnChangedFiles(r).size;
  return (
    <Message
      from="assistant"
      className="lilos-rise max-w-full gap-2.5"
      data-agentturn
    >
      <div className="flex items-center gap-2 text-[13px]">
        <HermesAvatar name={e?.name} className="size-5" />
        <span className="font-semibold">{e?.name}</span>
        <span className="text-muted-foreground">{r.time}</span>
      </div>
      {r.reasoning !== undefined && (
        <Reasoning
          className="mb-0 w-full"
          isStreaming={r.live && r.phase === "thinking"}
          duration={r.thought ?? 0}
          defaultOpen={!!r.live}
          openKey={r.turnId && `${r.turnId}:reasoning`}
        >
          <ReasoningTrigger
            className="w-fit text-[13px]"
            getThinkingMessage={(s, d) =>
              s ? (
                <Shimmer duration={1}>Thinking…</Shimmer>
              ) : (
                <span>Thought for {d || 1}s</span>
              )
            }
          />
          <ReasoningContent className="mt-2 border-l-2 pl-3 text-[13px] leading-relaxed text-muted-foreground">
            {r.reasoning || "…"}
          </ReasoningContent>
        </Reasoning>
      )}
      {steps.length > 0 && (
        <TurnSteps
          steps={steps}
          autoOpen={r.live && (r.phase === "tools" || r.phase === "waiting")}
          waitingApproval={r.waitingOn === "approval"}
          openKey={r.turnId && `${r.turnId}:steps`}
        />
      )}
      {/* With a Workbench the helpers live on its Subagents tab (#317); the turn only points there. */}
      {!!r.subagents?.length &&
        (onOpen ? (
          <SubagentsLink
            agents={r.subagents}
            onOpen={() => onOpen("subagents")}
          />
        ) : (
          <TurnSubagents
            agents={r.subagents}
            emp={emp}
            onOpenSession={onOpenSession}
            openKey={r.turnId && `${r.turnId}:subagents`}
          />
        ))}
      {r.live && r.phase === "tools" && !steps.some((s) => s.running) && (
        <Shimmer as="span" duration={1} className="pl-4 text-[13px]">
          Working…
        </Shimmer>
      )}
      {r.live && r.phase === "submitted" && (
        <Shimmer className="text-[15px]">Opening Hermes session…</Shimmer>
      )}
      {/* Mid-stream text rides the same MessageResponse path as the finished
          reply — streamdown's incomplete-markdown pass closes dangling
          backticks/list markers as chunks land (issue #80, AC-2). */}
      {r.streaming !== undefined ? (
        <MessageContent className="w-full" data-streaming>
          <MessageResponse
            caret="block"
            className="lilos-prose break-words"
            isAnimating
          >
            {r.streaming}
          </MessageResponse>
        </MessageContent>
      ) : r.text ? (
        <MessageContent className="w-full">
          <MessageResponse className="lilos-prose break-words">
            {withFileMentionChips(r.text)}
          </MessageResponse>
        </MessageContent>
      ) : null}
      <SteerRows steers={r.steers} by={human?.(VIEWER_ID)?.name ?? "You"} />
      {r.phase === "stopped" && (
        <div className="w-fit rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
          Stopped · session.interrupt
        </div>
      )}
      {/* #419: a turn that ended on `turn.completed.error` — the chip
          carries the engine's error text so "Failed" says what failed
          (same red the DM session alert uses). */}
      {r.phase === "failed" && (
        <div
          data-turn-failed
          className="w-fit max-w-full rounded bg-red-50 px-1.5 py-0.5 text-red-900 text-xs"
        >
          Failed{r.error ? ` · ${r.error}` : ""}
        </div>
      )}
      {r.agentInitiated && (
        <div className="w-fit rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
          Agent-initiated
        </div>
      )}
      {r.plan && (
        <PlanCard
          plan={r.plan}
          onAction={onPlan}
          onOpen={onOpen ? () => onOpen("plan") : undefined}
          keyHint={r.plan.id === keyTarget}
        />
      )}
      {cards}
      {!r.live &&
        !r.streaming &&
        (r.text ||
          steps.length > 0 ||
          !!r.subagents?.length ||
          /* A turn stopped or failed before it produced anything still
             needs the end-anchor — otherwise there is no wire signal the
             turn ended (and no hover Retry, #419). */
          r.phase === "stopped" ||
          r.phase === "failed") && (
          /* data-turnsettled: the footer only renders once the turn has ended —
           the stable "turn is over" anchor for specs (text lands earlier).
           It reserves its height while invisible; under a resolved question
           card that reservation reads as a dead gap, so the turn with a
           collapsed receipt drops it entirely (FIX #515 r4). */
          <div
            data-turnsettled
            className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-muted-foreground opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-has-[[data-question-card][data-ask-state=resolved]]:h-0 group-has-[[data-question-card][data-ask-state=resolved]]:overflow-hidden"
          >
            {r.dur !== undefined && <span>Worked for {r.dur}s</span>}
            {r.model && (
              <span>
                · {models?.find((m) => m.id === r.model)?.name ?? r.model}
                {r.effort && ` · ${effortLabel(r.effort)}`}
                {r.fast && " · Fast"}
              </span>
            )}
            {steps.length > 0 && <span>· {plural(steps.length, "step")}</span>}
            {files > 0 &&
              (onOpen ? (
                <button
                  type="button"
                  className="underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => onOpen("changes")}
                >
                  · {plural(files, "file")} changed
                </button>
              ) : (
                <span>· {plural(files, "file")} changed</span>
              ))}
            <MessageActions className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">
              {r.text && (
                <MessageAction
                  tooltip="Copy"
                  label="Copy"
                  onClick={() => navigator.clipboard?.writeText(r.text)}
                >
                  <CopyIcon className="size-3.5" />
                </MessageAction>
              )}
              {last && onRetry && (
                <MessageAction
                  tooltip="Retry turn"
                  label="Retry"
                  onClick={() => onRetry(r.from)}
                >
                  <RefreshCcwIcon className="size-3.5" />
                </MessageAction>
              )}
            </MessageActions>
          </div>
        )}
    </Message>
  );
}

/* The PR card an agent posts under the turn that opened the PR. */
export function PrCard({
  pr,
  author,
  onOpen,
}: {
  pr: PullRequest;
  author: string;
  onOpen: () => void;
}) {
  const pending = pr.checks.filter((c) => c.status === "pending").length;
  const merged = pr.status === "merged";
  return (
    <button
      type="button"
      onClick={onOpen}
      data-prcard
      className="lilos-lift flex w-full max-w-lg items-center gap-3 rounded-2xl border bg-background/70 px-3.5 py-3 text-left hover:border-foreground/25"
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-lg",
          merged
            ? "bg-violet-500/10 text-violet-600"
            : "bg-emerald-500/10 text-emerald-600",
        )}
      >
        {merged ? (
          <GitMergeIcon className="size-4" />
        ) : (
          <GitPullRequestIcon className="size-4" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-[14px]">
          {pr.title}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <span>
            {pr.repo} #{pr.number}
          </span>
          ·<span>{author}</span>·
          {merged ? (
            <span className="text-violet-600">merged</span>
          ) : pending ? (
            <span className="flex items-center gap-1 text-amber-600">
              <CircleDashedIcon className="size-3 animate-spin [animation-duration:3s]" />
              checks {pr.checks.length - pending}/{pr.checks.length}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-emerald-600">
              <CircleCheckIcon className="size-3" />
              checks passed
            </span>
          )}
        </span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
