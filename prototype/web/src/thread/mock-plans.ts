import type { Plan, PlanStep, V3Thread, V3Turn } from "@lilos/ui"

/* A plan waiting for your OK (the card with Approve, Change and Reject), on a
   mock thread. The mock thread record has no plan to propose, so the plan's
   text lives here, by thread; everything that changes after (waiting, working,
   rejected, a second version) is read back from the thread itself, so it
   survives leaving the thread and coming back. Like the app, the plan is an
   ask on Needs ("Review the plan"): the card, the Threads card and Needs all
   decide it through the engine's approve/deny, which settles the thread here.
   · the thread waits on you (`needs`) → the newest version is proposed;
   · Approve sets it working → the plan is approved and its first step runs;
   · Reject ends it with PLAN_REJECTED → the plan is rejected;
   · Change sends "Change the plan: …" as a turn → that turn carries the next
     version (the plan plus your change as its last step) and the one before it
     folds to "Replaced by v2", as in the app. */

type Proposal = {
  goal: string;
  steps: { text: string; files?: string[] }[];
  risks?: string[];
};

const PROPOSALS: Record<string, Proposal> = {
  "t-chat-sidebar": {
    goal: "The sidebar opens at the width you left it, with no jump after the first paint.",
    steps: [
      {
        text: "Read the saved width synchronously, before the first render",
        files: ["packages/ui/src/v3/v3-layout-prefs.ts"],
      },
      {
        text: "Start the sidebar at that width instead of the default",
        files: ["packages/ui/src/v3/v3-shell.tsx"],
      },
      {
        text: "Clamp a saved width that no longer fits a narrower window",
        files: ["packages/ui/src/v3/v3-resize.tsx"],
      },
      {
        text: "Cover a restart with a unit test",
        files: ["packages/ui/test/v3-layout.test.tsx"],
      },
    ],
    risks: ["A width saved on a larger screen is clamped, so the sidebar can open narrower than you left it."],
  },
};

/** Where the app's composer starts a Change: the send that keeps it answers the plan. */
export const PLAN_CHANGE_PREFIX = "Change the plan: ";

/** The summary a rejected plan leaves on its thread. */
const PLAN_REJECTED = "You rejected the plan";

const changeOf = (turn: V3Turn): string | undefined => {
  const text = turn.prompt?.text.trimStart();
  return text?.startsWith(PLAN_CHANGE_PREFIX) ? text.slice(PLAN_CHANGE_PREFIX.length).trim() : undefined;
};

/** Whether `text` is a Change to the plan this thread has waiting. */
export const isPlanChange = (t: V3Thread, text: string): boolean =>
  planWaiting(t) && text.trimStart().startsWith(PLAN_CHANGE_PREFIX);

/** The turns that carry a plan: the first, then each Change. */
const planTurns = (t: V3Thread): V3Turn[] => {
  const turns = [...t.turns].sort((a, b) => a.n - b.n);
  return turns.filter((u, i) => i === 0 || changeOf(u) !== undefined);
};

/** The plan this turn carries, if it carries one. */
export function planOf(t: V3Thread, turn: V3Turn): Plan | undefined {
  const base = PROPOSALS[t.id];
  const carriers = planTurns(t);
  const at = carriers.indexOf(turn);
  if (!base || at < 0) return undefined;
  const steps: { text: string; files?: string[] }[] = [
    ...base.steps,
    ...carriers.slice(1, at + 1).flatMap((u) => {
      const text = changeOf(u);
      return text ? [{ text: text.charAt(0).toUpperCase() + text.slice(1) }] : [];
    }),
  ];
  const newest = at === carriers.length - 1;
  const status: Plan["status"] = !newest
    ? "replaced"
    : t.summary === PLAN_REJECTED
      ? "rejected"
      : t.status === "needs"
        ? "proposed"
        : "approved";
  const running = t.status === "working";
  return {
    id: `${t.id}:plan`,
    kind: "plan",
    version: at + 1,
    goal: base.goal,
    steps: steps.map(
      (s, i): PlanStep => ({
        ...s,
        status: status !== "approved" ? "pending" : !running ? "completed" : i === 0 ? "in_progress" : "pending",
      }),
    ),
    ...(base.risks ? { risks: base.risks } : {}),
    status,
  };
}

/** The turn with the highest number (turns are stored newest first). */
export const newestTurn = (t: V3Thread): V3Turn | undefined =>
  t.turns.reduce<V3Turn | undefined>((a, u) => (!a || u.n > a.n ? u : a), undefined);

/** The thread has a plan the card can still decide. */
export function planWaiting(t: V3Thread): boolean {
  const newest = newestTurn(t);
  return !!newest && planOf(t, newest)?.status === "proposed";
}

/** The thread has a plan of its own to decide. */
export const hasPlan = (threadId: string): boolean => threadId in PROPOSALS;

/** The thread after you decide its plan: Approve sets the first step running, Reject ends it. */
export function decidePlan(t: V3Thread, action: "approve" | "reject"): V3Thread {
  if (action === "reject") return { ...t, status: "done", askId: undefined, quote: undefined, summary: PLAN_REJECTED };
  const newest = newestTurn(t);
  const first = newest && planOf(t, newest)?.steps[0]?.text;
  return {
    ...t,
    status: "working",
    askId: undefined,
    quote: undefined,
    unseen: false,
    now: first ? { kind: "edit", text: first, elapsed: "0s" } : undefined,
    tail: ["Plan approved"],
  };
}

/** Your Change as the next turn: the agent takes it into the plan and asks again. */
export function reviseTurn(t: V3Thread, text: string, at: string): V3Thread {
  const n = Math.max(0, ...t.turns.map((u) => u.n)) + 1;
  return {
    ...t,
    turns: [
      {
        n,
        from: `you at ${at}`,
        took: "1m",
        prompt: { by: "you", at, text },
        answer: "I’ve added that to the plan. Nothing is touched until you approve it.",
      },
      ...t.turns,
    ],
  };
}

/** A message sent while a plan waits: it waits on the turn, as one sent mid-turn does. */
export function queueOnNewest(t: V3Thread, text: string, at: string): V3Thread {
  const newest = newestTurn(t);
  return {
    ...t,
    turns: t.turns.map((u) => (u === newest ? { ...u, queued: [...(u.queued ?? []), { at, text }] } : u)),
  };
}
