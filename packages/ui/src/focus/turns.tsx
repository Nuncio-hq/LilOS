import {
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CopyIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  RefreshCcwIcon,
} from "lucide-react";
import { SteerRows } from "../chat/agent-chat";
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
import { plural } from "../lib/helpers";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import type { EmpFn, HumanFn, PullRequest, Reply, WbTab } from "../types";
import { StepRow } from "../workbench/step-row";

export function UserTurn({
  from,
  time,
  text,
  note,
  human,
}: {
  from: string;
  time: string;
  text: string;
  note?: string;
  human: HumanFn;
}) {
  return (
    <Message from="user" className="max-w-[80%] gap-1">
      <MessageContent className="rounded-2xl px-4 py-2.5 text-[15px] leading-[1.6]">
        <MessageResponse className="lilos-prose break-words">
          {text}
        </MessageResponse>
      </MessageContent>
      <div className="ml-auto text-[12px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
        {human(from)?.name ?? from} · {time}
        {note && <> · {note}</>}
      </div>
    </Message>
  );
}

export function AgentTurn({
  r,
  emp,
  last,
  onRetry,
  onOpen,
  cards,
  pending,
}: {
  r: Reply;
  emp: EmpFn;
  last: boolean;
  onRetry: (empId: string) => void;
  onOpen: (t: WbTab) => void;
  cards: React.ReactNode;
  pending: string[];
}) {
  const e = emp(r.from);
  const steps = r.steps ?? [];
  const files = new Set(steps.filter((s) => s.diff).map((s) => s.diff!.path))
    .size;
  return (
    <Message from="assistant" className="max-w-full gap-2.5">
      <div className="flex items-center gap-2 text-[13px]">
        <HermesAvatar className="size-5" />
        <span className="font-semibold">{e?.name}</span>
        <span className="text-muted-foreground">{r.time}</span>
      </div>
      {r.reasoning !== undefined && (
        <Reasoning
          className="mb-0 w-full"
          isStreaming={r.live && r.phase === "thinking"}
          duration={r.thought ?? 0}
          defaultOpen={!!r.live}
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
        <div className="flex flex-col">
          {steps.map((s, j) => (
            <StepRow key={j} s={s} />
          ))}
        </div>
      )}
      {r.live && r.phase === "tools" && !steps.some((s) => s.running) && (
        <Shimmer as="span" duration={1} className="pl-4 text-[13px]">
          Working…
        </Shimmer>
      )}
      {r.live && r.phase === "submitted" && (
        <Shimmer className="text-[15px]">Opening Hermes session…</Shimmer>
      )}
      {r.streaming ? (
        <Shimmer>{r.streaming}</Shimmer>
      ) : r.text ? (
        <MessageContent className="w-full">
          <MessageResponse className="lilos-prose break-words">
            {r.text}
          </MessageResponse>
        </MessageContent>
      ) : null}
      {/* Steer rows from the shared agent-chat component (pending + delivered, identical to the panel). */}
      <SteerRows steers={r.steers} pending={pending} live={r.live} />
      {r.phase === "stopped" && (
        <div className="w-fit rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
          Stopped · session.interrupt
        </div>
      )}
      {cards}
      {!r.live && !r.streaming && (r.text || steps.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-muted-foreground">
          {r.dur !== undefined && <span>Worked for {r.dur}s</span>}
          {steps.length > 0 && <span>· {plural(steps.length, "step")}</span>}
          {files > 0 && (
            <button
              type="button"
              className="underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => onOpen("changes")}
            >
              · {plural(files, "file")} changed
            </button>
          )}
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
            {last && (
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
      className="flex w-full max-w-lg items-center gap-3 rounded-xl border bg-background px-3.5 py-3 text-left transition-colors hover:border-foreground/25"
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
