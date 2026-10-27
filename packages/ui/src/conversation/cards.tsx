import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "../components/ai-elements/confirmation";
import { HireCardInline } from "../feed/hire-card";
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
import { useMenu } from "../v3/v3-keys";
import { StatusPill } from "../v3/v3-marks";
import { askHint } from "./ask-keys";
import { askNote, summariseAsk } from "./ask-line";
import {
  CARD,
  CARD_HEAD,
  CardButton,
  CardLink,
  KEY_HINT,
  RECEIPT,
} from "./card-bits";
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
              className={cn("mt-1 w-full", open && CARD)}
            >
              {open ? (
                <>
                  <div className={CARD_HEAD}>
                    <StatusPill status="needs" />
                    <span>{emp(r.from)?.name} asks to start work</span>
                  </div>
                  <div className="mt-2.5 text-[14.5px] text-foreground leading-normal">
                    {r.startProposal.title}
                  </div>
                  <p className="mt-1 text-[13.5px] text-muted-foreground leading-normal">
                    {repo
                      ? `New ticket + worktree on ${repo}. This thread moves there.`
                      : "New ticket. No repo on this channel, so no worktree."}
                  </p>
                  {(onStart || setResolved) && (
                    <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                      {setResolved && (
                        <CardLink
                          onClick={() =>
                            setResolved({ ...resolved, [key]: "Not now" })
                          }
                        >
                          Not yet
                        </CardLink>
                      )}
                      {onStart && (
                        <CardButton primary onClick={onStart}>
                          Review &amp; start
                        </CardButton>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className={cn(CARD_HEAD, "py-0.5")}>
                  <CheckIcon className="size-3.5 text-emerald-600" />
                  {work
                    ? `Started as ${work.ticket}`
                    : (answered ?? "Superseded by a newer turn")}
                </div>
              )}
            </div>
          );
        })()}
      {r.approval && (
        <ApprovalCard
          a={r.approval}
          done={done || undefined}
          answer={(v: string) =>
            setResolved?.({ ...resolved, [r.approval!.id]: v })
          }
          /* #558: the card the ↵/⌫ keys would answer names its shortcuts —
             only the keys its offered options support (askHint). */
          hint={
            r.approval.id === keyTarget && !done
              ? (askHint(r, "approval") ?? undefined)
              : undefined
          }
          canAnswer={!!setResolved}
          viewer={viewer}
          by={r.from}
          emp={emp}
        />
      )}
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

/* #884: an approval asks one plain question — "Edit README.md?" — and offers
   two answers: Allow and Deny. The extra grant scopes the engine offers
   (This thread, Always) live under a small ▾ on Allow; the receipt text each
   choice writes is what the app layer maps back to the wire outcome. A deny
   is not a failure — the receipt reads "You said no". */
const GRANT_LABEL: Record<string, string> = {
  once: "Once",
  session: "This thread",
  always: "Always",
};

const GRANT_RECEIPT: Record<string, (viewer: string) => string> = {
  once: (v) => `Allowed once by ${v}`,
  session: (v) => `Allowed this thread by ${v}`,
  always: () => "Always allowed here",
};

const GRANT_TITLE: Record<string, string> = {
  once: "Allow — it asks again next time",
  session: "Allow it for the rest of this thread",
  always: "Always allow it here",
};

function ApprovalCard({
  a,
  done,
  answer,
  hint,
  canAnswer,
  viewer,
  by,
  emp,
}: {
  a: NonNullable<Reply["approval"]>;
  /** The receipt text once answered; undefined while it waits. */
  done?: string;
  /** Writes the receipt text — the app maps it back to a wire outcome. */
  answer: (receipt: string) => void;
  hint?: string;
  canAnswer: boolean;
  viewer: string;
  by: string;
  emp: EmpFn;
}) {
  const menu = useMenu();
  /* #106 AC-4: the card offers the options the engine offered — asks stored
     before options existed fall back to the original set. */
  const offered = a.options?.length ? a.options : ["once", "always", "deny"];
  const grants = offered.filter((o) => o !== "deny" && o !== "cancel");
  const main = grants.includes("once") ? "once" : grants[0];
  const extra = grants.filter((o) => o !== main);
  const canDeny = offered.includes("deny") || offered.includes("cancel");
  /* "You said no" is the new deny receipt; stored asks may still carry the
     old "Denied by …" label — both mean not-approved. */
  const denied =
    !!done && (done === "You said no" || done.startsWith("Denied"));
  const grant = (o: string) =>
    answer((GRANT_RECEIPT[o] ?? ((v: string) => `Allowed by ${v}`))(viewer));
  const note = askNote(a.command, a.note);
  return (
    <Confirmation
      className={done ? RECEIPT : CARD}
      data-ask-id={a.id}
      data-ask-state={done ? "resolved" : "open"}
      state={done ? "approval-responded" : "approval-requested"}
      approval={
        done ? { id: a.id, approved: !denied, reason: done } : { id: a.id }
      }
    >
      <ConfirmationTitle className={CARD_HEAD}>
        <ConfirmationRequest>
          <StatusPill status="needs" />
          <span>Approval needed</span>
        </ConfirmationRequest>
        <ConfirmationAccepted>
          <CheckIcon className="size-3.5 text-emerald-600" />
          {done}
        </ConfirmationAccepted>
        <ConfirmationRejected>
          <XIcon className="size-3.5 text-muted-foreground" />
          {done}
        </ConfirmationRejected>
      </ConfirmationTitle>
      <ConfirmationRequest>
        {a.hire ? (
          /* A hire proposal is the draft itself, not a command echo — the
             same card a channel hire renders. */
          <HireCardInline
            draft={a.hire}
            by={by}
            emp={emp}
            me={viewer}
            done={done}
            onReview={() => answer(`Allowed once by ${viewer}`)}
            onReject={() => answer("You said no")}
          />
        ) : (
          <>
            <div className="text-[14.5px] text-foreground leading-normal">
              {summariseAsk(a.command)}
            </div>
            {note && (
              <p className="mt-1 text-[13.5px] text-muted-foreground leading-normal">
                {note}
              </p>
            )}
          </>
        )}
      </ConfirmationRequest>
      {canAnswer && !a.hire && (
        <ConfirmationActions className="flex-wrap">
          {canDeny && (
            <CardButton
              title="Deny — the agent sees the refusal"
              onClick={() => answer("You said no")}
            >
              Deny
            </CardButton>
          )}
          {main && (
            <span className="relative flex">
              <CardButton
                primary
                title={GRANT_TITLE[main] ?? "Allow"}
                onClick={() => grant(main)}
                className={extra.length ? "rounded-r-none" : undefined}
              >
                Allow
              </CardButton>
              {extra.length > 0 && (
                <>
                  <CardButton
                    primary
                    ref={menu.trigger}
                    aria-haspopup="menu"
                    aria-expanded={menu.open}
                    aria-label="More ways to allow"
                    title="More ways to allow"
                    onClick={() => menu.setOpen((o) => !o)}
                    className="rounded-l-none border-l border-background/25 px-1.5"
                  >
                    <ChevronDownIcon className="size-3.5" />
                  </CardButton>
                  {menu.open && (
                    <div
                      ref={menu.list}
                      role="menu"
                      onKeyDown={menu.onKeyDown}
                      className="absolute top-[calc(100%+6px)] right-0 z-20 w-40 rounded-lg border bg-popover p-1 shadow-lg"
                    >
                      {extra.map((o) => (
                        <button
                          key={o}
                          type="button"
                          role="menuitem"
                          title={GRANT_TITLE[o]}
                          onClick={() => {
                            menu.setOpen(false);
                            grant(o);
                          }}
                          className="flex w-full items-center rounded-md px-2 py-1.5 text-[13px] hover:bg-[var(--v3-hover)]"
                        >
                          {GRANT_LABEL[o] ?? o}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </span>
          )}
        </ConfirmationActions>
      )}
      {hint && (
        <div data-ask-keyhint className={KEY_HINT}>
          Answer from the keyboard: {hint}
        </div>
      )}
    </Confirmation>
  );
}
