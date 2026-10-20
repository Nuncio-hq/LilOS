import { STEP_VERB, type V3Data, type V3Reply, type V3Thread, type V3Turn } from "@lilos/ui"

/* The prototype's stand-in for an engine turn: a message goes in, the
   agent's steps appear one by one (a run step streams its output into the
   live box), then the answer streams in word by word, the way a real session
   reads in the app. Timings are slow enough to watch. */

type SetData = (fn: (d: V3Data) => V3Data) => void;
export type ReplyFn = (text: string, thread: V3Thread, data: V3Data) => V3Reply;

/* The mock day starts at 12:05; the clock moves with real time from load. */
const LOADED = Date.now();
export function nowClock() {
  const m = 12 * 60 + 5 + Math.floor((Date.now() - LOADED) / 60000);
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/* Pending timers per thread, so Stop can cancel a turn mid-flight instead of
   the old timers finishing it a few seconds later. */
const pending = new Map<string, number[]>();

export function cancelTurn(threadId: string) {
  for (const t of pending.get(threadId) ?? []) window.clearTimeout(t);
  pending.delete(threadId);
}

export function runTurn(
  setData: SetData,
  getData: () => V3Data,
  reply: ReplyFn,
  thread: V3Thread,
  text: string,
) {
  const id = thread.id;
  const n = Math.max(0, ...thread.turns.map((t) => t.n)) + 1;
  const at = nowClock();
  const r = reply(text, thread, getData());
  const started = Date.now();
  const timers: number[] = [];
  pending.set(id, timers);
  const later = (fn: () => void, ms: number) => {
    timers.push(window.setTimeout(fn, ms));
  };

  const patchThread = (fn: (t: V3Thread) => V3Thread) =>
    setData((d) => ({
      ...d,
      threads: d.threads.map((t) => (t.id === id ? fn(t) : t)),
    }));
  const patchTurn = (fn: (t: V3Turn) => V3Turn) =>
    patchThread((t) => ({
      ...t,
      turns: t.turns.map((u) => (u.n === n ? fn(u) : u)),
    }));

  patchThread((t) => ({
    ...t,
    status: "working",
    unseen: false,
    stuck: undefined,
    // A new message moves the conversation on; the last Rewind note goes.
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

  let at_ms = 900;
  for (const s of r.steps) {
    const { output, ...step } = s;
    later(() => {
      patchThread((t) => ({
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
    }, at_ms);
    at_ms += 800 + (output?.length ?? 0) * 450;
  }

  /* The answer streams a couple of words at a time. */
  const words = r.answer.match(/\S+\s*/g) ?? [r.answer];
  later(() => {
    patchThread((t) => ({
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
  }, at_ms);
  for (let i = 2; i < words.length + 2; i += 2) {
    later(
      () => patchTurn((u) => ({ ...u, answer: words.slice(0, i).join("") })),
      at_ms + (i / 2) * 45,
    );
  }
  at_ms += (words.length / 2) * 45 + 300;

  later(() => {
    pending.delete(id);
    const secs = Math.round((Date.now() - started) / 1000);
    patchTurn((u) => ({
      ...u,
      answer: r.answer,
      streaming: false,
      attachments: r.attachments,
      took: secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`,
    }));
    patchThread((t) => ({
      ...t,
      status: "done",
      now: undefined,
      live: undefined,
      minutes: t.minutes + Math.max(1, Math.round(secs / 60)),
    }));
    /* A message queued during this turn starts the next one. */
    const done = getData().threads.find((t) => t.id === id);
    const queued = done?.turns.find((u) => u.n === n)?.queued?.[0];
    if (done && queued) {
      patchTurn((u) => ({ ...u, queued: u.queued?.slice(1) }));
      later(() => runTurn(setData, getData, reply, done, queued.text), 400);
    }
  }, at_ms);
}
