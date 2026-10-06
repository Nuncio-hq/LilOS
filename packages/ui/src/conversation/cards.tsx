import { CheckIcon, PlayIcon, ShieldAlertIcon, XIcon } from "lucide-react";
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
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import type {
  EmpFn,
  HumanFn,
  QuestionAsk,
  Reply,
  Thread,
  Work,
} from "../types";
import { VIEWER_ID } from "../types";
import { askHint } from "./ask-keys";
import { type QuestionAnswer, QuestionCard } from "./question-card";

/* The one "asks to start work" request that currently owns the start-work action (issue #15).
   Decision (recorded on #15): while a request card is OPEN — the LAST reply proposed work, work has
   not started, and the user has not answered "Not yet" — the card is the single entry point: the header
   "Start work" button stays visible but disabled with tooltip "Answer the request below". Once a
   newer turn follows the card, or the card is answered, the card goes inactive and the header button
   is the normal one again. Same rule in the thread panel and Focus. */
export const startKey = (r: Reply, i: number) => `sp:${r.id ?? `i${i}`}`;
export function openStartRequest(
  thread: Thread,
  resolved: Record<string, string>,
): boolean {
  const i = thread.replies.length - 1;
  const r = thread.replies[i];
  return !!r?.startProposal && !resolved[startKey(r, i)];
}

/* Approval + start-work proposal cards under a reply — one implementation in the cards slot of
   AgentTurn for both frames (issue #19). The actions are controls, so they need their handlers:
   no setResolved → the card shows the request but no answer buttons; no onStart → no "Review & start". */
export function ReplyCards({
  r,
  i,
  last,
  work,
  repo,
  emp,
  resolved,
  setResolved,
  onStart,
  onAnswer,
  onCancel,
  human,
  keyTarget,
}: {
  r: Reply;
  /** Index of this reply in thread.replies (keys the start-work card's answered state). */
  i: number;
  /** True when this is the last reply — only then can its start-work card be the open request. */
  last: boolean;
  work: Work | null;
  repo?: string;
  emp: EmpFn;
  /** Resolves the approver's name (the signed-in human; #118). */
  human: HumanFn;
  resolved: Record<string, string>;
  setResolved?: (r: Record<string, string>) => void;
  onStart?: () => void;
  /** #420: question-ask continuations — passed, they own the resolved
      write; absent, the card resolves itself. */
  onAnswer?: (q: QuestionAsk, a: QuestionAnswer) => void;
  onCancel?: (q: QuestionAsk) => void;
  /** #558: id of the card the keyboard answers — it shows the ↵/⌫ hint. */
  keyTarget?: string;
}) {
  const done = r.approval && resolved[r.approval.id];
  const viewer = human(VIEWER_ID)?.name ?? "you";
  return (
    <>
      {r.startProposal &&
        (() => {
          const key = startKey(r, i);
          const answered = resolved[key];
          /* Issue #15: while this card is the OPEN request (it is on the last reply, no work started,
             the user hasn't answered) it is THE entry point for start work — the header button yields
             to it. Once a newer turn follows the card (superseded) or the user answers "Not yet", the
             card goes inactive and the header button is the single entry point again. */
          const open = !work && !answered && last;
          return (
            <div
              data-startcard={open ? "open" : "inactive"}
              className={cn(
                "mt-1 w-full max-w-md overflow-hidden rounded-lg border",
                work
                  ? "border-emerald-200"
                  : open
                    ? "border-violet-300"
                    : "border-border",
              )}
            >
              <div
                className={cn(
                  "flex items-center gap-2 px-3 py-2 font-medium text-xs",
                  work
                    ? "bg-emerald-50 text-emerald-900"
                    : open
                      ? "bg-violet-50 text-violet-900"
                      : "bg-muted/40 text-muted-foreground",
                )}
              >
                {work ? (
                  <>
                    <CheckIcon className="size-3.5" />
                    Started as {work.ticket}
                  </>
                ) : open ? (
                  <>
                    <PlayIcon className="size-3.5" />
                    {emp(r.from)?.name} asks to start work
                  </>
                ) : (
                  <>
                    <CheckIcon className="size-3.5" />
                    {answered ?? "Superseded by a newer turn"}
                  </>
                )}
              </div>
              {open && (
                <div className="space-y-2 p-3">
                  <div className="font-medium">{r.startProposal.title}</div>
                  <p className="text-muted-foreground text-xs">
                    {repo
                      ? `New ticket + worktree on ${repo}. This thread and its Hermes session move there.`
                      : "New ticket. No repo on this channel, so no worktree."}
                  </p>
                  {(onStart || setResolved) && (
                    <div className="flex gap-1.5">
                      {onStart && (
                        <Button size="sm" onClick={onStart}>
                          Review & start
                        </Button>
                      )}
                      {setResolved && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setResolved({ ...resolved, [key]: "Not now" })
                          }
                        >
                          Not yet
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })()}
      {r.approval &&
        (() => {
          const a = r.approval;
          const answer = (v: string) =>
            setResolved?.({ ...resolved, [a.id]: v });
          /* #558: the card the ↵/⌫ keys would answer names its shortcuts —
             only the keys its offered options support (askHint). */
          const hint =
            a.id === keyTarget && !done ? askHint(r, "approval") : null;
          /* #106 AC-4: the card offers the options the engine offered
             (Once / This session / Always / Deny) — asks stored before
             options existed fall back to the original three. */
          const actions = a.options?.length
            ? a.options
            : ["once", "always", "deny"];
          const actionMeta: Record<
            string,
            {
              label: string;
              title: (command: string) => string;
              resolved: (viewer: string, command: string) => string;
              ghost?: boolean;
            }
          > = {
            once: {
              label: "Once",
              title: () => "Once — it asks again next time",
              resolved: (v) => `Allowed once by ${v}`,
            },
            session: {
              label: "This session",
              title: (c) =>
                `Allow ${c.slice(0, 60)} for the rest of this session`,
              resolved: (v) => `Allowed this session by ${v}`,
            },
            always: {
              label: "Always",
              /* "Always" names what it covers — the tooltip spells out the
                 command it grants; the code block sits right above. */
              title: (c) => `Always allow ${c.slice(0, 60)}`,
              resolved: () => "Always allowed here",
            },
            deny: {
              label: "Deny",
              title: () => "Deny — the agent sees the refusal",
              resolved: (v) => `Denied by ${v}`,
              ghost: true,
            },
          };
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
              data-ask-id={a.id}
              data-ask-state={done ? "resolved" : "open"}
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
                  <ShieldAlertIcon className="size-3.5 text-primary" />
                  Approval needed · only {viewer} can answer
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
                {/* The caption must say what the command DOES — when the
                    engine just echoes the command it adds nothing. */}
                {a.note.trim() && a.note.trim() !== a.command.trim() ? (
                  <p className="text-muted-foreground text-xs">{a.note}</p>
                ) : null}
              </ConfirmationRequest>
              {setResolved && (
                <ConfirmationActions className="flex-wrap self-start">
                  {actions.map((opt, i) => {
                    const meta = actionMeta[opt];
                    if (!meta) return null;
                    return (
                      <ConfirmationAction
                        key={opt}
                        variant={
                          meta.ghost ? "ghost" : i === 0 ? undefined : "outline"
                        }
                        title={meta.title(a.command)}
                        onClick={() => answer(meta.resolved(viewer, a.command))}
                      >
                        {meta.label}
                      </ConfirmationAction>
                    );
                  })}
                </ConfirmationActions>
              )}
              {hint && (
                <div
                  data-ask-keyhint
                  className="px-3 pb-2 text-[11px] text-muted-foreground"
                >
                  Answer from the keyboard: {hint}
                </div>
              )}
            </Confirmation>
          );
        })()}
      {r.question && (
        <QuestionCard
          q={r.question}
          viewer={viewer}
          agent={emp(r.from)?.name}
          done={resolved[r.question.id]}
          resolved={resolved}
          setResolved={setResolved}
          onAnswer={onAnswer}
          onCancel={onCancel}
        />
      )}
    </>
  );
}
