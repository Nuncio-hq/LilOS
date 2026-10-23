import {
  agentNameOf,
  type V3Ask,
  type V3Thread,
  type V3Ticket,
  type V3Turn,
} from "@lilos/ui/v3-data";
import { decidePlan, hasPlan } from "../../../../web/src/thread/mock-plans";
import { drain } from "./chat";
import { nowClock, uid } from "./clock";
import { deferInLane, isBusy, openLane } from "./lanes";
import { $data, patchThread } from "./state";
import { advance, closeCurrent, completeSteps } from "./tickets";

/* What you do about an ask: approve it, deny it, or answer its question. The
   semantics are the Mac's `resolve` (asks.ts): the ask leaves the list, the
   ticket moves, the thread that held the ask picks up. An approval carries on
   for a few seconds and then finishes with a short scripted turn; a denial or
   an answer ends the thread at once. */

type Outcome =
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "answer"; option: string };

const sentences = (text?: string): string[] =>
  (text?.match(/[^.!?]+[.!?]+/g) ?? (text ? [text] : [])).map((s) => s.trim());

const nextTurnNumber = (t: V3Thread): number =>
  Math.max(0, ...t.turns.map((u) => u.n)) + 1;

/** A turn that was still running when the thread stopped waiting is over:
    "3m so far" reads "3m". */
const settled = (turns: V3Turn[]): V3Turn[] =>
  turns.map((u) =>
    u.took?.endsWith(" so far")
      ? { ...u, took: u.took.slice(0, -" so far".length) }
      : u,
  );

/** What the agent did once you approved, written from the ask and its subject. */
type Carried = {
  askTitle: string;
  ifYes?: string;
  me: string;
  subject: string;
  at: string;
  plan: boolean;
  ticketId?: string;
};

function finishApproved(threadId: string, c: Carried): void {
  const d = $data.get();
  const thread = d.threads.find((t) => t.id === threadId);
  if (!thread) return;
  const summary = c.plan
    ? "Plan approved and carried out"
    : `Done. You approved “${c.askTitle}”.`;
  const turn: V3Turn = {
    n: nextTurnNumber(thread),
    from: `you at ${c.at}`,
    took: "4s",
    prompt: { by: "you", at: c.at, text: "Approved" },
    steps: [
      {
        kind: "think",
        target: c.plan
          ? `${c.me} approved the plan, so I carried it out step by step.`
          : `${c.me} approved “${c.askTitle}”, so ${c.subject} goes ahead.`,
      },
    ],
    answer: c.plan
      ? `The plan is carried out: ${c.subject}. Nothing is left to approve.`
      : `${c.me} approved “${c.askTitle}”.${c.ifYes ? ` ${c.ifYes}` : ""}`,
  };
  $data.set({
    ...d,
    tickets: d.tickets.map((t) =>
      t.id === c.ticketId
        ? {
            ...t,
            status: "done" as const,
            since: 0,
            doneAgo: 0,
            progress: completeSteps(t.progress),
          }
        : t,
    ),
    threads: d.threads.map((t) =>
      t.id === threadId
        ? {
            ...t,
            status: "done" as const,
            unseen: true,
            doneAgo: 0,
            now: undefined,
            live: undefined,
            tail: undefined,
            quote: undefined,
            summary,
            step: (t.step ?? 0) + 1,
            minutes: t.minutes + 1,
            turns: [turn, ...settled(t.turns)],
          }
        : t,
    ),
  });
}

/** After an approval: the thread works for a moment, then finishes. If a
    scripted turn is running on it, the finish lands when that turn ends. */
function carryOn(threadId: string, c: Carried): void {
  if (isBusy(threadId)) {
    deferInLane(threadId, () => finishApproved(threadId, c));
    return;
  }
  const later = openLane(threadId);
  // An approved plan already shows its first step running (decidePlan).
  if (!c.plan)
    later(
      () =>
        patchThread(threadId, (t) => ({
          ...t,
          now: { kind: "think", text: `Checking ${c.subject}`, elapsed: "0s" },
          tail: [`Approved by ${c.me}`, "Almost done…"],
        })),
      1500,
    );
  later(() => {
    finishApproved(threadId, c);
    drain(threadId);
  }, 4000);
}

function closingTurn(
  t: V3Thread,
  ask: V3Ask,
  outcome: Outcome,
  me: string,
  at: string,
  subject: string,
): { turn: V3Turn; summary: string } {
  if (outcome.kind === "answer") {
    const summary = `You chose ${outcome.option}`;
    return {
      summary,
      turn: {
        n: nextTurnNumber(t),
        from: `you at ${at}`,
        took: "just now",
        prompt: { by: "you", at, text: summary },
        steps: [
          {
            kind: "think",
            target: `${me} chose ${outcome.option}, so that settles ${subject}.`,
          },
        ],
        answer: `Going with ${outcome.option}.`,
      },
    };
  }
  return {
    summary: `Denied “${ask.title}”`,
    turn: {
      n: nextTurnNumber(t),
      from: `you at ${at}`,
      took: "just now",
      prompt: { by: "you", at, text: "Denied" },
      steps: [
        {
          kind: "think",
          target: `${me} said no, so I am dropping ${subject}.`,
        },
      ],
      answer: `Understood, I won't go ahead.${ask.ifNo ? ` ${ask.ifNo}` : ""}`,
    },
  };
}

function resolve(askId: string, outcome: Outcome): void {
  const d = $data.get();
  const ask = d.asks.find((a) => a.id === askId);
  if (!ask) return;
  const ticket: V3Ticket | undefined = d.tickets.find(
    (t) => t.id === ask.ticketId,
  );
  const thread = d.threads.find((t) => t.askId === askId);
  const yes = outcome.kind === "yes";
  const word = yes
    ? "Approved"
    : outcome.kind === "no"
      ? "Denied"
      : `You chose ${outcome.option}`;
  // A plan's text lives with the Mac's mock plans, keyed by its thread.
  const plan = !!thread && hasPlan(thread.id);
  const subject = ticket?.title ?? thread?.title ?? ask.title;
  const who = agentNameOf(d, ask.from);
  const at = nowClock();
  const detail = plan
    ? yes
      ? `${who} carries out the plan.`
      : "Nothing was touched."
    : yes
      ? ask.ifYes
      : outcome.kind === "no"
        ? ask.ifNo
        : undefined;

  const tickets = !ticket
    ? d.tickets
    : d.tickets.map((t) =>
        t.id !== ticket.id
          ? t
          : {
              ...t,
              status: yes ? ("working" as const) : ("done" as const),
              waitingOn: undefined,
              since: 0,
              doneAgo: yes ? undefined : 0,
              progress: yes ? advance(t.progress) : closeCurrent(t.progress),
              updates: [
                ...t.updates,
                { by: "you", ago: 0, text: word },
                ...(detail && !plan
                  ? [
                      {
                        by: yes ? ask.from : (d.ceoId ?? ask.from),
                        ago: 0,
                        text: detail,
                      },
                    ]
                  : []),
              ],
            },
      );

  const threads = d.threads.map((t) => {
    if (t.askId !== askId) return t;
    // The plan card settles the way the Mac's does: Approve sets the first
    // step running, Reject ends the thread with its plan rejected.
    if (plan) {
      const decided = decidePlan(
        { ...t, step: (t.step ?? 0) + 1 },
        yes ? "approve" : "reject",
      );
      return yes ? decided : { ...decided, turns: settled(decided.turns) };
    }
    const base = {
      ...t,
      askId: undefined,
      quote: undefined,
      step: (t.step ?? 0) + 1,
    };
    if (yes) {
      return {
        ...base,
        status: "working" as const,
        unseen: false,
        now: {
          kind: "run" as const,
          text: `Carrying on: ${subject}`,
          elapsed: "0s",
        },
        tail: [
          `Approved by ${d.me}`,
          sentences(ask.ifYes)[0] ?? `Picking up ${subject}`,
        ],
        live: {
          cmd: `${who} · ${subject}`,
          lines: [
            `Approved by ${d.me}`,
            ...sentences(ask.ifYes),
            "Working on it…",
          ],
        },
      };
    }
    const closing = closingTurn(t, ask, outcome, d.me, at, subject);
    return {
      ...base,
      status: "done" as const,
      unseen: false,
      doneAgo: 0,
      now: undefined,
      live: undefined,
      tail: undefined,
      summary: closing.summary,
      turns: [closing.turn, ...settled(t.turns)],
    };
  });

  $data.set({
    ...d,
    asks: d.asks.filter((a) => a.id !== askId),
    tickets,
    threads,
    updates: [
      {
        id: uid(`u-${askId}`),
        by: ask.from,
        at,
        ticketId: ask.ticketId,
        kind: yes ? "handed" : "finished",
        text: `${word}.${detail ? ` ${detail}` : ""}`,
      },
      ...d.updates,
    ],
  });

  if (yes && thread) {
    carryOn(thread.id, {
      askTitle: ask.title,
      ifYes: ask.ifYes,
      me: d.me,
      subject,
      at,
      plan,
      ticketId: ticket?.id,
    });
  }
}

export function approve(askId: string): void {
  resolve(askId, { kind: "yes" });
}

export function deny(askId: string): void {
  resolve(askId, { kind: "no" });
}

export function answer(askId: string, option: string): void {
  resolve(askId, { kind: "answer", option });
}
