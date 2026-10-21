import { CopyIcon, RefreshCcwIcon } from "lucide-react";
import { SteerRows } from "../chat/agent-chat";
import { effortLabel } from "../chat/model-picker";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "../components/ai-elements/message";
import { Shimmer } from "../components/ai-elements/shimmer";
import { withFileMentionChips } from "../lib/mentions";
import { HermesAvatar } from "../shell/avatars";
import type { EmpFn, HumanFn, ModelOption, Reply, WbTab } from "../types";
import { VIEWER_ID } from "../types";
import { turnChangedFiles } from "../workbench/artifacts";
import { type PlanAction, PlanCard } from "./plan-card";
import { SubagentsLink, TurnSubagents } from "./subagents";
import { TurnWork } from "./turn-work";

/* The conversation's turns — ONE implementation used by both frames (issue #19):
   ThreadView renders it for channel threads and DM sessions, FocusView for Focus.
   Optional controls render only when their handler is passed:
   Retry → onRetry, the "N files changed" link → onOpen (opens a workbench tab — the thread
   panel has no workbench, so the count stays plain text there), card content → cards.
   Your own messages are `UserTurn` (./user-turn). */

/* theme.css zeroes `p` and code-block margins with selectors more specific
   than its 0.7em block gap, so paragraphs would sit flush; `!` (important)
   beats that unlayered rule. Headings and lists keep their own. */
const GAP =
  "[&_.lilos-prose>*+p]:mt-[0.7em]! [&_.lilos-prose>*+[data-streamdown]]:mt-[0.7em]!";

/* A small status line under the answer: a red/muted dot and one sentence. */
const NOTE =
  "flex w-fit max-w-full items-start gap-2 text-[13.5px] text-muted-foreground";

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
  /* "Working" until the answer starts; then the fold reads "Worked". */
  const inFlight =
    !!r.live &&
    (r.phase === "submitted" ||
      r.phase === "thinking" ||
      r.phase === "tools" ||
      r.phase === "waiting");
  /* An in-flight turn always shows its "Working" line — even before its
     first step — so a live row is never an empty box ("Opening thread…"
     covers the moment before the engine reports anything). */
  const hasWork =
    steps.length > 0 ||
    r.reasoning !== undefined ||
    (inFlight && r.phase !== "submitted");
  const hasAnswer = r.streaming !== undefined || !!r.text;

  /* The v3 turn: the folded work first, then who answers and what they
     said. The name sits over the answer (or whatever answers in its place),
     never over a bare "Working" line. */
  const speaks =
    hasAnswer ||
    !!r.plan ||
    !!r.approval ||
    !!r.question ||
    !!r.startProposal ||
    r.phase === "stopped" ||
    r.phase === "failed" ||
    !!r.agentInitiated;
  return (
    <Message
      from="assistant"
      className="lilos-rise max-w-full gap-3.5"
      data-agentturn
    >
      {hasWork && (
        <TurnWork
          steps={steps}
          reasoning={r.reasoning}
          thought={r.thought}
          dur={r.dur}
          live={r.live}
          thinking={r.live && r.phase === "thinking"}
          working={inFlight}
          idle={
            r.waitingOn === "question"
              ? "Waiting for your answer"
              : r.waitingOn === "plan"
                ? "Waiting for your plan decision"
                : undefined
          }
          autoOpen={
            r.live &&
            (r.phase === "thinking" ||
              r.phase === "tools" ||
              r.phase === "waiting")
          }
          waitingApproval={r.waitingOn === "approval"}
          openKey={r.turnId && `${r.turnId}:steps`}
          changed={files}
          onOpenChanges={onOpen ? () => onOpen("changes") : undefined}
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
      {r.live && r.phase === "submitted" && (
        <Shimmer className="text-[15px]">Opening thread…</Shimmer>
      )}
      {speaks && (
        <div
          data-agentwho
          className="mt-1.5 flex items-center gap-2 text-[13.5px] first:mt-0"
        >
          <HermesAvatar name={e?.name} className="size-5" />
          <span className="font-medium text-foreground">{e?.name}</span>
          {r.time && (
            <span className="text-[12px] text-muted-foreground/70">
              {r.time}
            </span>
          )}
        </div>
      )}
      {/* Mid-stream text rides the same MessageResponse path as the finished
          reply — streamdown's incomplete-markdown pass closes dangling
          backticks/list markers as chunks land (issue #80, AC-2). */}
      {r.streaming !== undefined ? (
        <MessageContent
          className={`-mt-2 w-full text-[15px] leading-6 ${GAP}`}
          data-streaming
        >
          <MessageResponse
            caret="block"
            className="lilos-prose break-words"
            isAnimating
          >
            {r.streaming}
          </MessageResponse>
        </MessageContent>
      ) : r.text ? (
        <MessageContent className={`-mt-2 w-full text-[15px] leading-6 ${GAP}`}>
          <MessageResponse className="lilos-prose break-words">
            {withFileMentionChips(r.text)}
          </MessageResponse>
        </MessageContent>
      ) : null}
      <SteerRows steers={r.steers} by={human?.(VIEWER_ID)?.name ?? "You"} />
      {r.phase === "stopped" && (
        <div className={NOTE}>
          <span
            aria-hidden
            className="mt-[9px] size-1.5 shrink-0 rounded-full bg-muted-foreground/50"
          />
          Stopped
        </div>
      )}
      {/* #419: a turn that ended on `turn.completed.error` — the card
          carries the engine's error text so "Failed" says what failed. */}
      {r.phase === "failed" && (
        <div
          data-turn-failed
          className="w-fit max-w-full rounded-[10px] border border-[var(--v3-line)] px-4 py-3 text-[13.5px]"
        >
          <span
            aria-hidden
            className="mr-2 inline-block size-1.5 rounded-full bg-red-500 align-middle dark:bg-red-400"
          />
          <span className="text-red-700 dark:text-red-300">
            Failed{r.error ? ` · ${r.error}` : ""}
          </span>
        </div>
      )}
      {r.agentInitiated && (
        <div className="w-fit text-[12.5px] text-muted-foreground/70">
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
           It has a real box (specs wait on it being visible) but hangs into
           the gap below the turn — negative margins return its height — so a
           quiet hover line never pushes the next message away. The box is
           12px, the column's own bottom padding (`pb-3`): a 20px box hung
           out past that padding and became the band under the last turn, so
           with the composer's margin a half-pixel font metric measured 24.5
           against #602's 24px cap. Under a resolved question card that box
           reads as a dead gap, so the turn with a collapsed receipt drops it
           entirely (FIX #515 r4). */
          <div
            data-turnsettled
            className="-mt-3.5 -mb-3 flex h-3 items-center gap-x-1.5 overflow-hidden whitespace-nowrap text-[12px] leading-3 text-muted-foreground/70 opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-has-[[data-question-card][data-ask-state=resolved]]:m-0 group-has-[[data-question-card][data-ask-state=resolved]]:h-0"
          >
            {r.model && (
              <span>
                {models?.find((m) => m.id === r.model)?.name ?? r.model}
                {r.effort && ` · ${effortLabel(r.effort)}`}
                {r.fast && " · Fast"}
              </span>
            )}
            {/* No step count and no files entry: the "Worked …" fold above says
                what the turn did, and its "edited N files" opens Changes. */}
            <MessageActions className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">
              {r.text && (
                <MessageAction
                  tooltip="Copy"
                  label="Copy"
                  size="icon-xs"
                  onClick={() => navigator.clipboard?.writeText(r.text)}
                >
                  <CopyIcon className="size-3.5" />
                </MessageAction>
              )}
              {last && onRetry && (
                <MessageAction
                  tooltip="Retry turn"
                  label="Retry"
                  size="icon-xs"
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
