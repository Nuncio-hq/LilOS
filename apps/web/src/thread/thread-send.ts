import type { Ask, Conversation } from "@lilos/contracts/app";
import {
  clearDraftIfSent,
  draftKey,
  getDraft,
  type PlanAction,
} from "@lilos/ui";
import type { AttachedFile } from "@lilos/ui/types";
import { respondToRequest, sendDm } from "../lib/actions";
import { flushRewind } from "../lib/rewind";
import { asks as asksAtom } from "../lib/runtime";
import { sendKeyDoneForSend, sendKeyForSend } from "../lib/send-key";
import { say } from "../lib/toast";
import { PLAN_CHANGE_PREFIX } from "./thread-actions";

/* The thread composer's send and the plan card's decisions — both route
   through the conversation's open `plan` ask when there is one. */
export function threadSendHandlers(a: {
  conv: Conversation;
  employeeId: string;
  asks: Ask[];
  setDraft: (v: string) => void;
}) {
  const { conv, employeeId, asks, setDraft } = a;
  /* #180: a proposed plan opens a `plan` ask on the relay — Approve/Reject
     answer it straight; Change… prefills the composer (AC-3/AC-4). */
  const openPlanAsk = asks.find(
    (x) => x.state === "open" && x.request.kind === "plan",
  );
  /* The card can beat `asks.open` by a frame — plan.updated lands in the
     feed before the relay mints the ask — so a fast Approve/Reject waits a
     short window for the ask instead of dropping the click (AC-4). */
  const findOpenPlanAsk = (planId: string): Ask | undefined =>
    asksAtom
      .get()
      .find(
        (x) =>
          x.conversationId === conv.id &&
          x.state === "open" &&
          x.request.kind === "plan" &&
          x.request.planId === planId,
      );
  const awaitPlanAsk = (planId: string) =>
    new Promise<Ask | undefined>((resolve) => {
      let tries = 0;
      const tick = () => {
        const hit = findOpenPlanAsk(planId);
        if (hit || ++tries >= 60) return resolve(hit);
        setTimeout(tick, 50);
      };
      tick();
    });
  const onPlan = (action: PlanAction, planId: string) => {
    if (action === "change") {
      setDraft(PLAN_CHANGE_PREFIX);
      return;
    }
    /* #590 AC-1: an Approve/Reject decides the plan — a prefix the user
       never typed into (draft still exactly "Change the plan: ") is
       cleared, or the composer keeps a dead prompt to edit a decided plan.
       A draft with content stays. The draft is read live (the store, not
       the render-scope value): a fast Approve can beat the re-render that
       would carry the prefix into this closure. */
    if (getDraft(draftKey.thread(conv.id)) === PLAN_CHANGE_PREFIX) setDraft("");
    void awaitPlanAsk(planId).then((ask) => {
      /* respondToRequest toasts its own failure line — the catch only keeps
         the rethrow from going unhandled. */
      if (ask) void respondToRequest(ask.id, action).catch(() => {});
    });
  };
  /* The thread composer send: a send that keeps the "Change the plan: "
     prefix answers the open plan request instead of posting (AC-4). */
  const send = (text: string, files?: AttachedFile[]): Promise<unknown> => {
    const t = text.trimStart();
    if (openPlanAsk && t.startsWith(PLAN_CHANGE_PREFIX)) {
      const answer = t.slice(PLAN_CHANGE_PREFIX.length).trim();
      /* An ask answer carries no attachments — reject the send so the
         composer keeps the chips staged for the next real send (a resolved
         send would clear them silently). */
      return respondToRequest(openPlanAsk.id, "change", answer).then(() => {
        clearDraftIfSent(draftKey.thread(conv.id), text);
        if (files?.length) {
          say(
            "Your reply went to the plan — attached files can't ride it and stayed staged below.",
          );
          throw new Error("plan answer carries no attachments");
        }
        return conv;
      });
    }
    /* #578: a send sees the real post-rewind session — a pending rewind in
       this conversation commits now, not at its own timer. */
    return flushRewind(conv.id)
      .then(() =>
        sendDm(
          employeeId,
          text,
          conv.id,
          undefined,
          files,
          /* #552 AC-1: the draft's own key when the draft itself goes out —
             a Workbench/programmatic send rides a session binding instead,
             so it can't borrow the key a stored draft send is waiting on. */
          sendKeyForSend(
            `conv:${conv.id}`,
            draftKey.thread(conv.id),
            text,
            files,
          ),
        ),
      )
      .then((c) => {
        if (!c) throw new Error("send failed");
        sendKeyDoneForSend(`conv:${conv.id}`, text, files);
        clearDraftIfSent(draftKey.thread(conv.id), text);
        return c;
      });
  };
  return { onPlan, send };
}
