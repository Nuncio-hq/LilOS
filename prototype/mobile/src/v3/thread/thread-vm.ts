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
  StepVM,
  ThreadVM,
  TurnVM,
} from "@lilos/ui-native/v3";
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

function turnVM(d: V3Data, threadId: string, t: V3Turn): TurnVM {
  const key = `${threadId}-${t.n}`;
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
    queued: (t.queued ?? []).map((q, i) => ({
      key: `${key}-q${i}`,
      at: q.at,
      text: q.text,
    })),
  };
}

export function threadVM(d: V3Data, t: V3Thread): ThreadVM {
  const ask = t.askId ? d.asks.find((a) => a.id === t.askId) : undefined;
  return {
    id: t.id,
    agent: personOf(d, t.agentId),
    tag: threadTag(d, t),
    status: t.status,
    statusWord: STATUS_WORDS[t.status],
    // Stored newest first; a chat reads oldest first.
    turns: [...t.turns].reverse().map((turn) => turnVM(d, t.id, turn)),
    now:
      t.status === "working" && t.now
        ? { text: t.now.text, elapsed: t.now.elapsed }
        : undefined,
    stuck: t.status === "stuck" ? t.stuck : undefined,
    failure:
      t.status === "failed" ? (t.summary ?? "It did not finish.") : undefined,
    ask: ask ? askVM(d, ask) : undefined,
  };
}
