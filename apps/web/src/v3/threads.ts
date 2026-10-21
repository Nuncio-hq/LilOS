import {
  type SessionModel,
  type ThreadStatus,
  threadStatus,
} from "@lilos/client-runtime";
import type {
  AppChannel,
  Ask,
  Conversation,
  ConversationSummary,
  Employee,
} from "@lilos/contracts/app";
import type { V3Ask, V3Status, V3Thread } from "@lilos/ui";
import type { SessionSignal } from "../lib/session-watch";
import { modelLabel } from "./models";

/* Relay rows → the v3 view models for threads and asks. Pure: the stores in
   data.ts feed it. Status comes from `threadStatus` (client-runtime, D-#33),
   the one derivation every surface shares; nothing here decides a second one. */

const MIN = 60_000;

/** "11:02" for today, "19 Oct" for an earlier day. */
export function clockOrDate(ts: number, now: number): string {
  const d = new Date(ts);
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay
    ? d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : d.toLocaleDateString([], { day: "numeric", month: "short" });
}

/** One line, cut at `max` characters. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** ThreadStatus → the shared status word. A thread that finished and is
    seen, or finished and unseen, is `done` (unseen marks the latter). */
export const V3_STATUS: Record<ThreadStatus, V3Status> = {
  needs: "needs",
  working: "working",
  failed: "failed",
  unseen: "done",
  idle: "done",
};

/** What the engine asks, as the ask card's text. */
function askText(ask: Ask): { title: string; text: string } {
  const r = ask.request;
  if (ask.hire)
    return {
      title: `Hire ${ask.hire.name}`,
      text: `${ask.hire.name} · ${ask.hire.role} on ${ask.hire.model || "the engine's default model"}`,
    };
  // The question is the title; "The ask" row only adds the full text when
  // the title had to cut it (the card hides a row equal to its title).
  if (r.kind === "question")
    return { title: oneLine(r.question, 80), text: r.question };
  if (r.kind === "plan")
    return {
      title: "Review the plan",
      text: "The plan is in the thread; open it to read it before you decide.",
    };
  /* The command is "The ask" row; a description that already quotes it
     would say it twice (D-#769), so the title keeps only the rest. */
  const said = r.description
    ?.replace(r.command, "")
    .replace(/[\s:·–—-]+$/u, "")
    .trim();
  return {
    title: oneLine(said || "Approve a command", 80),
    text: r.command,
  };
}

export interface ThreadSources {
  now: number;
  conversations: readonly Conversation[];
  summaries: readonly ConversationSummary[];
  channels: readonly AppChannel[];
  employees: readonly Employee[];
  models: Record<string, SessionModel>;
  signals: Record<string, SessionSignal>;
  asks: readonly Ask[];
}

/** The employee a conversation belongs to: the one its channel routes for
    (the channel is internal routing, never a place, D-#25). For one
    conversation; a pass over many builds `ownersOf` once instead. */
export function employeeOfConversation(
  c: Conversation,
  channels: readonly AppChannel[],
): string | undefined {
  return channels.find((ch) => ch.id === c.channelId)?.employeeId;
}

/** Channel id → its employee, once per pass over the conversations (a `find`
    per conversation is quadratic on a long history). */
const ownersOf = (channels: readonly AppChannel[]): Map<string, string> =>
  new Map(channels.map((ch) => [ch.id, ch.employeeId]));

/** The open asks as the Needs page reads them; oldest first (D-#773). */
export function v3Asks(src: ThreadSources): V3Ask[] {
  const convs = new Map(src.conversations.map((c) => [c.id, c]));
  const owners = ownersOf(src.channels);
  return src.asks
    .filter((a) => a.state === "open" && convs.has(a.conversationId))
    .sort((a, b) => a.createdAt - b.createdAt)
    .flatMap((a): V3Ask[] => {
      const from = owners.get(
        (convs.get(a.conversationId) as Conversation).channelId,
      );
      if (!from) return [];
      const { title, text } = askText(a);
      const r = a.request;
      return [
        {
          id: a.id,
          threadId: a.conversationId,
          from,
          kind: r.kind === "question" ? "question" : "approval",
          title,
          waiting: Math.max(0, Math.round((src.now - a.createdAt) / MIN)),
          at: a.createdAt,
          ask: text,
          ...(a.why ? { why: a.why } : {}),
          ...(a.ifYes ? { ifYes: a.ifYes } : {}),
          ...(a.ifNo ? { ifNo: a.ifNo } : {}),
          /* "Allow this next time" only when the engine offers `always`.
             A gateway ask is once/deny, so it never grows this box. */
          ...(r.kind === "approval" && r.options.includes("always")
            ? { allowRule: "Allow this next time" }
            : {}),
          ...(r.kind === "question" && r.options?.length
            ? { options: r.options.map((o) => o.label) }
            : {}),
        },
      ];
    });
}

/** Each agent's newest chat by when it began (archived ones count: the old
    home composer followed the last session whatever became of it): the
    project it lived in and, from the newest chat whose first message you
    wrote (a scheduled run's was not), that message. The new-chat box starts
    in that project (a plain chat has none, so "No project") and ↑ brings the
    message back (#104, #581, D-#771). */
export function lastChats(
  src: ThreadSources,
): Map<string, { projectId?: string; opener?: string }> {
  const summaries = new Map(src.summaries.map((s) => [s.conversation.id, s]));
  const owners = ownersOf(src.channels);
  const byAgent = new Map<string, Conversation[]>();
  for (const c of src.conversations) {
    const agentId = owners.get(c.channelId);
    if (!agentId) continue;
    const list = byAgent.get(agentId);
    if (list) list.push(c);
    else byAgent.set(agentId, [c]);
  }
  const out = new Map<string, { projectId?: string; opener?: string }>();
  for (const [agentId, convs] of byAgent) {
    convs.sort((a, b) => b.createdAt - a.createdAt);
    const opener = convs
      .map((c) => summaries.get(c.id)?.root)
      .find((m) => m?.authorKind === "user" && m.text)?.text;
    out.set(agentId, {
      ...(convs[0].projectId ? { projectId: convs[0].projectId } : {}),
      ...(opener ? { opener } : {}),
    });
  }
  return out;
}

/** The threads, newest activity first. Archived ones and ones whose employee
    is gone stay out; `v3ArchivedThreads` has the archived. */
export function v3Threads(src: ThreadSources): V3Thread[] {
  return threadRows(src, false);
}

/** The threads put away (`conversations.update {archived}`), newest first:
    Threads → All → Archived, where they unarchive. */
export function v3ArchivedThreads(src: ThreadSources): V3Thread[] {
  return threadRows(src, true);
}

function threadRows(src: ThreadSources, archived: boolean): V3Thread[] {
  const summaries = new Map(src.summaries.map((s) => [s.conversation.id, s]));
  const owners = ownersOf(src.channels);
  const openAsk = new Map<string, Ask>();
  const openCount = new Map<string, number>();
  for (const a of [...src.asks].sort((x, y) => x.createdAt - y.createdAt)) {
    if (a.state !== "open") continue;
    openCount.set(a.conversationId, (openCount.get(a.conversationId) ?? 0) + 1);
    if (!openAsk.has(a.conversationId)) openAsk.set(a.conversationId, a);
  }
  const rows: { last: number; thread: V3Thread }[] = [];
  for (const c of src.conversations) {
    if (!!c.archived !== archived) continue;
    const agentId = owners.get(c.channelId);
    if (!agentId) continue;
    const summary = summaries.get(c.id);
    const status = threadStatus(
      c,
      c.engineRef ? src.models[c.engineRef] : undefined,
      c.engineRef ? src.signals[c.engineRef] : undefined,
      openCount.get(c.id) ?? 0,
    );
    const last = summary?.last.createdAt ?? c.createdAt;
    const live = status === "working" || status === "needs";
    const title =
      c.title.trim() ||
      (summary ? oneLine(summary.root.text, 80) : "") ||
      "Untitled thread";
    /* What a finished thread did, in one line: its newest answer. */
    const answer =
      summary?.last.authorKind === "employee"
        ? summary.last
        : summary?.firstAnswer;
    const ask = openAsk.get(c.id);
    const context =
      c.usage?.context !== undefined && c.usage.contextWindow
        ? Math.min(
            100,
            Math.round((c.usage.context / c.usage.contextWindow) * 100),
          )
        : undefined;
    rows.push({
      last,
      thread: {
        id: c.id,
        agentId,
        title,
        status: V3_STATUS[status],
        /* Completion age is this thread's own clock (last message, else
           when it was opened). Needs you must not read a ticket for it. */
        ...(status === "unseen"
          ? {
              unseen: true,
              doneAgo: Math.max(0, Math.round((src.now - last) / MIN)),
            }
          : {}),
        startedAt: clockOrDate(c.createdAt, src.now),
        minutes: Math.max(
          0,
          Math.round(((live ? src.now : last) - c.createdAt) / MIN),
        ),
        turns: [],
        ...(context !== undefined ? { context } : {}),
        ...(c.model ? { model: modelLabel(c.model, c.provider) } : {}),
        ...(c.cwd ? { folder: c.cwd } : {}),
        ...(c.projectId ? { projectId: c.projectId } : {}),
        ...(!live && answer?.text
          ? { summary: oneLine(answer.text, 140) }
          : {}),
        ...(ask
          ? { askId: ask.id, quote: oneLine(askText(ask).text, 140) }
          : {}),
      },
    });
  }
  return rows.sort((a, b) => b.last - a.last).map((r) => r.thread);
}
