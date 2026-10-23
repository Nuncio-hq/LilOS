import type { V3Reply, V3StepKind, V3Thread, V3Turn } from "@lilos/ui/v3-data";
import { v3Reply } from "../../../../web/src/fake-v3-reply";
import { CEO_THREAD_ID } from "../model";
import { ceoReply } from "./ceo-reply";
import { nowClock } from "./clock";
import { closeLane, isBusy, openLane, waitInLane } from "./lanes";
import { $data, patchThread } from "./state";

/* The prototype's stand-in for an engine turn (ported from the Mac's
   chat-sim): the message shows at once, the agent's steps appear one by one
   (a run step streams its output into the live box), then the answer streams
   in a couple of words at a time. Slow enough to watch. */

const STEP_VERB: Record<V3StepKind, string> = {
  read: "Read",
  search: "Searched",
  edit: "Edited",
  run: "Ran",
  web: "Browsed",
  think: "Thought",
  delegate: "Delegated",
};

function replyFor(text: string, thread: V3Thread): V3Reply {
  const d = $data.get();
  return thread.id === CEO_THREAD_ID
    ? ceoReply(text, d)
    : v3Reply(text, thread, d);
}

/** Drops the oldest "sent while it ran" note once that message starts. */
function dropQueued(threadId: string): void {
  patchThread(threadId, (t) => {
    let dropped = false;
    return {
      ...t,
      turns: t.turns.map((u) => {
        if (dropped || !u.queued?.length) return u;
        dropped = true;
        return { ...u, queued: u.queued.slice(1) };
      }),
    };
  });
}

/** A thread's lane is free again: land what waited on it, then start the
    next message that was sent meanwhile. */
export function drain(threadId: string): void {
  const { waiting, deferred } = closeLane(threadId);
  for (const fn of deferred) fn();
  const [next, ...rest] = waiting;
  if (next === undefined) return;
  dropQueued(threadId);
  runTurn(threadId, next);
  for (const text of rest) waitInLane(threadId, text);
}

function runTurn(id: string, text: string): void {
  const thread = $data.get().threads.find((t) => t.id === id);
  if (!thread) return;
  const n = Math.max(0, ...thread.turns.map((t) => t.n)) + 1;
  const at = nowClock();
  const r = replyFor(text, thread);
  const started = Date.now();
  const later = openLane(id);

  const patchTurn = (fn: (u: V3Turn) => V3Turn) =>
    patchThread(id, (t) => ({
      ...t,
      turns: t.turns.map((u) => (u.n === n ? fn(u) : u)),
    }));

  patchThread(id, (t) => ({
    ...t,
    status: "working",
    // The user is in this thread; nothing finishes "unseen" under their eyes.
    unseen: false,
    stuck: undefined,
    rewound: undefined,
    step: (t.step ?? 0) + 1,
    now: { kind: "think", text: "Reading your message", elapsed: "0s" },
    live: undefined,
    turns: [
      {
        n,
        from: `you at ${at}`,
        took: "just now",
        prompt: { by: "you", at, text },
        steps: [],
      },
      ...t.turns,
    ],
  }));

  let atMs = 900;
  for (const s of r.steps) {
    const { output, ...step } = s;
    later(() => {
      patchThread(id, (t) => ({
        ...t,
        step: (t.step ?? 0) + 1,
        context: Math.min(95, (t.context ?? 0) + 2),
        now: {
          kind: step.kind,
          text: `${STEP_VERB[step.kind]} ${step.target}`,
          elapsed: "0s",
        },
        live: output
          ? {
              cmd: step.kind === "run" ? `$ ${step.target}` : step.target,
              lines: output,
            }
          : undefined,
      }));
      patchTurn((u) => ({
        ...u,
        steps: [
          ...(u.steps ?? []).map((x) => ({ ...x, running: false })),
          { ...step, running: true },
        ],
      }));
    }, atMs);
    atMs += 800 + (output?.length ?? 0) * 450;
  }

  const words = r.answer.match(/\S+\s*/g) ?? [r.answer];
  later(() => {
    patchThread(id, (t) => ({
      ...t,
      now: { kind: "think", text: "Writing the answer", elapsed: "0s" },
      live: undefined,
    }));
    patchTurn((u) => ({
      ...u,
      steps: (u.steps ?? []).map((x) => ({ ...x, running: false })),
      answer: "",
      streaming: true,
    }));
  }, atMs);
  for (let i = 2; i < words.length + 2; i += 2) {
    later(
      () => patchTurn((u) => ({ ...u, answer: words.slice(0, i).join("") })),
      atMs + (i / 2) * 45,
    );
  }
  atMs += (words.length / 2) * 45 + 300;

  later(() => {
    const secs = Math.round((Date.now() - started) / 1000);
    patchTurn((u) => ({
      ...u,
      answer: r.answer,
      streaming: false,
      attachments: r.attachments,
      took: secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`,
    }));
    patchThread(id, (t) => ({
      ...t,
      // A message to a thread that still waits on you does not answer the ask.
      status:
        t.askId && $data.get().asks.some((a) => a.id === t.askId)
          ? "needs"
          : "done",
      now: undefined,
      live: undefined,
      minutes: t.minutes + Math.max(1, Math.round(secs / 60)),
    }));
    drain(id);
  }, atMs);
}

export function sendMessage(threadId: string, text: string): void {
  const body = text.trim();
  if (!body) return;
  if (!$data.get().threads.some((t) => t.id === threadId)) return;
  if (isBusy(threadId)) {
    // Like the Mac: it waits on the running turn and starts when that ends.
    waitInLane(threadId, body);
    const at = nowClock();
    patchThread(threadId, (t) => {
      const newest = Math.max(0, ...t.turns.map((u) => u.n));
      return {
        ...t,
        turns: t.turns.map((u) =>
          u.n === newest
            ? { ...u, queued: [...(u.queued ?? []), { at, text: body }] }
            : u,
        ),
      };
    });
    return;
  }
  runTurn(threadId, body);
}

/** Posts into the CEO's standing thread; the CEO answers there. */
export function askCeo(text: string): string {
  sendMessage(CEO_THREAD_ID, text);
  return CEO_THREAD_ID;
}
