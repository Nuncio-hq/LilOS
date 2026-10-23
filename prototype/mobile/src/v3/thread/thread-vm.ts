import type { Plan } from "@lilos/ui/types";
import {
  threadTag,
  type V3Attachment,
  type V3Data,
  type V3Step,
  type V3Thread,
  type V3Turn,
} from "@lilos/ui/v3-data";
import type {
  AttachmentVM,
  PlanVM,
  StepVM,
  ThreadVM,
  TurnVM,
} from "@lilos/ui-native/v3";
import { planOf } from "../../../../web/src/thread/mock-plans";
import { askVM, personOf, STATUS_WORDS } from "../model";

/* A thread of the company as the conversation screen draws it. Pure. */

function stepVM(turnKey: string, s: V3Step, i: number): StepVM {
  return {
    key: `${turnKey}-s${i}`,
    kind: s.kind,
    target: s.target,
    meta: s.meta,
    add: s.add,
    del: s.del,
    failed: s.failed,
    running: s.running,
    where: s.where,
  };
}

function attachmentVM(
  turnKey: string,
  a: V3Attachment,
  i: number,
): AttachmentVM {
  const key = `${turnKey}-a${i}`;
  if (a.kind === "diff")
    return {
      key,
      kind: "diff",
      path: a.path,
      add: a.add,
      del: a.del,
      lines: a.lines.map((l, j) => ({
        key: `${key}-l${j}`,
        kind: l.kind,
        text: l.text,
      })),
    };
  return { key, ...a };
}

/** The plan a turn proposed, from the same source the Mac reads it from. */
function planVM(key: string, p: Plan): PlanVM {
  return {
    status: p.status,
    version: p.version,
    goal: p.goal,
    steps: p.steps.map((s, i) => ({
      key: `${key}-p${i}`,
      text: s.text,
      files: s.files ?? [],
      state:
        s.status === "completed"
          ? "done"
          : s.status === "in_progress"
            ? "running"
            : "pending",
    })),
    risks: p.risks ?? [],
  };
}

function turnVM(d: V3Data, thread: V3Thread, t: V3Turn): TurnVM {
  const threadId = thread.id;
  const key = `${threadId}-${t.n}`;
  const plan = planOf(thread, t);
  const steps = (t.steps ?? []).map((s, i) => stepVM(key, s, i));
  return {
    key,
    prompt: t.prompt && {
      fromYou: t.prompt.by === "you",
      // "you" is the owner: their name, never the id.
      who: personOf(d, t.prompt.by).name,
      at: t.prompt.at,
      text: t.prompt.text,
      files: (t.prompt.files ?? []).map((f) => f.name),
    },
    steps,
    took: t.took || undefined,
    live: t.streaming === true || steps.some((s) => s.running),
    answer: t.answer,
    streaming: t.streaming === true,
    summary: t.summary,
    attachments: (t.attachments ?? []).map((a, i) => attachmentVM(key, a, i)),
    plan: plan && planVM(key, plan),
    queued: (t.queued ?? []).map((q, i) => ({
      key: `${key}-q${i}`,
      at: q.at,
      text: q.text,
    })),
  };
}

/** The line "what it is doing now", unless a plan card already marks that
    very step as running (an approved plan's first step). */
function runningLine(t: V3Thread, turns: TurnVM[]): ThreadVM["now"] {
  if (t.status !== "working" || !t.now) return undefined;
  const text = t.now.text;
  const shown = turns.some((u) =>
    u.plan?.steps.some((s) => s.state === "running" && s.text === text),
  );
  return shown ? undefined : { text, elapsed: t.now.elapsed };
}

export function threadVM(d: V3Data, t: V3Thread): ThreadVM {
  const ask = t.askId ? d.asks.find((a) => a.id === t.askId) : undefined;
  // Stored newest first; a chat reads oldest first.
  const turns = [...t.turns].reverse().map((turn) => turnVM(d, t, turn));
  return {
    id: t.id,
    agent: personOf(d, t.agentId),
    tag: threadTag(d, t),
    status: t.status,
    statusWord: STATUS_WORDS[t.status],
    turns,
    now: runningLine(t, turns),
    stuck: t.status === "stuck" ? t.stuck : undefined,
    failure:
      t.status === "failed" ? (t.summary ?? "It did not finish.") : undefined,
    ask: ask ? askVM(d, ask) : undefined,
  };
}
