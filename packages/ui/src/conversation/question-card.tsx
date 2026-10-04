import {
  CheckIcon,
  MessageCircleQuestionIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "../components/ai-elements/confirmation";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import type { QuestionAsk } from "../types";

/* What the card hands back: options answer with their wire id, free text
   with the typed string; `label` is the human wording the receipt shows. */
export type QuestionAnswer = { value: string; label: string };

/* #420: the engine's `question` ask under a reply — the question text, its
   options as buttons, a free-text field when allowed, and a Cancel. While
   open the turn sits in phase "waiting" (amber, "needs you"); answering or
   cancelling folds the card to a one-line receipt, the same resolved-map
   pattern the approval card uses (resolved[q.id] carries the wording).
   Props in, callbacks out: `setResolved` writes the receipt text,
   `onAnswer`/`onCancel` let the app continue the turn. */
export function QuestionCard({
  q,
  viewer,
  done,
  resolved,
  setResolved,
  onAnswer,
  onCancel,
}: {
  q: QuestionAsk;
  /** Display name of the signed-in human ("you" fallback). */
  viewer: string;
  /** Receipt text once resolved — `Answered "…"` reads accepted, `Cancelled…` rejected. */
  done?: string;
  resolved: Record<string, string>;
  setResolved?: (r: Record<string, string>) => void;
  /** Answer continues the turn. Passed, the handler owns the resolved
      write — the card locks as "Sending…" until resolved[q.id] lands
      (the real app's respond → engine-resolves round-trip). Absent, the
      card writes the receipt itself and stays self-contained. */
  onAnswer?: (q: QuestionAsk, a: QuestionAnswer) => void;
  onCancel?: (q: QuestionAsk) => void;
}) {
  const [draft, setDraft] = useState("");
  /* The answer is on its way to the engine — the controls lock until the
     resolved write flips the card to its receipt. */
  const [pending, setPending] = useState<string | null>(null);
  const cancelled = !!done?.startsWith("Cancelled");
  const options = q.options ?? [];
  /* Wire rule (requests.ts): free text beside the options only when
     `freeText`; no options at all → the answer IS free text. */
  const freeText = q.freeText === true || options.length === 0;
  const interactive = !!setResolved && !done;

  const pick = (a: QuestionAnswer) => {
    if (!interactive || pending) return;
    setPending(a.label);
    if (onAnswer) onAnswer(q, a);
    else
      setResolved?.({
        ...resolved,
        [q.id]: `Answered “${a.label}” by ${viewer}`,
      });
  };
  const cancel = () => {
    if (!interactive || pending) return;
    setPending("Cancelled");
    if (onCancel) onCancel(q);
    else setResolved?.({ ...resolved, [q.id]: `Cancelled by ${viewer}` });
  };
  return (
    <Confirmation
      className={cn(
        "mt-1",
        done
          ? cancelled
            ? "border-red-200"
            : "border-emerald-200"
          : "border-amber-300 bg-amber-50/50",
      )}
      data-ask-id={q.id}
      data-ask-state={done ? "resolved" : "open"}
      state={done ? "approval-responded" : "approval-requested"}
      approval={
        done ? { id: q.id, approved: !cancelled, reason: done } : { id: q.id }
      }
    >
      <ConfirmationTitle className="flex flex-wrap items-center gap-1.5 pr-2 font-medium text-foreground">
        <ConfirmationRequest>
          <MessageCircleQuestionIcon className="size-3.5 text-primary" />
          Question · only {viewer} can answer
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
        <div className="space-y-2.5">
          <p className="whitespace-pre-wrap text-foreground text-sm leading-snug">
            {q.question}
          </p>
          {options.length > 0 && (
            /* Many options cap and scroll instead of growing the thread. */
            <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto pr-0.5">
              {options.map((o) => (
                <Button
                  key={o.id}
                  variant="outline"
                  size="sm"
                  disabled={!interactive || !!pending}
                  title={o.description}
                  className="h-auto justify-start px-3 py-2 text-left whitespace-normal"
                  onClick={() => pick({ value: o.id, label: o.label })}
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span>{o.label}</span>
                    {o.description && (
                      <span className="font-normal text-muted-foreground text-xs">
                        {o.description}
                      </span>
                    )}
                  </span>
                </Button>
              ))}
            </div>
          )}
          {interactive && freeText && (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const text = draft.trim();
                if (text) pick({ value: text, label: text });
              }}
            >
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={!!pending}
                placeholder={
                  options.length
                    ? "Or type your own answer…"
                    : "Type your answer…"
                }
                aria-label="Your answer"
              />
              <Button
                type="submit"
                size="sm"
                disabled={!!pending || !draft.trim()}
              >
                <SendIcon className="size-3.5" />
                Answer
              </Button>
            </form>
          )}
          {interactive && (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={!!pending}
                title="Cancel — the agent sees the refusal"
                onClick={cancel}
              >
                Cancel
              </Button>
              {pending && (
                <span className="text-muted-foreground text-xs">Sending…</span>
              )}
            </div>
          )}
        </div>
      </ConfirmationRequest>
    </Confirmation>
  );
}
