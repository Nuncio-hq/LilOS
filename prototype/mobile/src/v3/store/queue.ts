import { agentNameOf, type V3Data } from "@lilos/ui/v3-data";
import { CEO_THREAD_ID } from "../model";
import { clockAt, nowClock } from "./clock";
import {
  ASK_ITEMS,
  type AskItem,
  UPDATE_ITEMS,
  type UpdateItem,
} from "./queue-items";
import { ceoTurn } from "./seed";
import { $data } from "./state";
import { finishTickets } from "./tickets";

/** The notification a released item turns into. */
export type Released = {
  kind: "ask" | "update";
  id: string;
  title: string;
  body: string;
};

let asks: AskItem[] = [...ASK_ITEMS];
let updates: UpdateItem[] = [...UPDATE_ITEMS];
/** Which kind came out last, so an unspecific release alternates. */
let last: "ask" | "update" = "update";

export function resetQueue(): void {
  asks = [...ASK_ITEMS];
  updates = [...UPDATE_ITEMS];
  last = "update";
}

export function queuedCount(): number {
  return asks.length + updates.length;
}

/** The next ticket number in the project: HB-14 → HB-15. */
function nextTicketId(d: V3Data, projectId: string, key: string): string {
  const nums = d.tickets
    .filter((t) => t.projectId === projectId)
    .map((t) => Number(t.id.split("-")[1]))
    .filter((n) => Number.isFinite(n));
  return `${key}-${Math.max(0, ...nums) + 1}`;
}

/** Adds the ticket, the thread and the ask, consistent with each other. */
function addAsk(d: V3Data, item: AskItem): V3Data {
  const project = d.projects.find((p) => p.id === item.projectId);
  const agent = d.agents.find((a) => a.id === item.from);
  if (!project || !agent) return d;
  const ticketId = nextTicketId(d, project.id, project.key);
  const opened = clockAt(-item.minutes);
  const steps = [
    ...item.done.map((s) => ({
      text: s.text,
      by: item.from,
      took: s.took,
      state: "done" as const,
    })),
    {
      text: `Your approval: ${item.title}`,
      by: "you",
      took: "just now",
      state: "current" as const,
    },
    ...item.todo.map((text) => ({
      text,
      by: item.from,
      took: "",
      state: "todo" as const,
    })),
  ];
  return {
    ...d,
    tickets: [
      ...d.tickets,
      {
        id: ticketId,
        title: item.ticket,
        projectId: project.id,
        goalId: item.goalId,
        owner: item.from,
        status: "needs",
        waitingOn: { kind: "you", askId: item.id },
        since: 0,
        started: `Today ${opened}`,
        progress: steps,
        ...(item.result ? { result: item.result } : {}),
        updates: [{ by: item.from, ago: 0, text: item.report }],
      },
    ],
    threads: [
      ...d.threads,
      {
        id: item.threadId,
        ticketId,
        agentId: item.from,
        title: item.ticket,
        status: "needs",
        startedAt: opened,
        openedAt: Date.now(),
        minutes: item.minutes,
        step: item.work.length + 1,
        context: 14,
        model: agent.model,
        folder: project.folder,
        askId: item.id,
        quote: item.quote,
        plan: steps.map((s) => ({ text: s.text, state: s.state })),
        turns: [
          {
            n: 1,
            from: `asked by CEO at ${opened}`,
            took: `${item.minutes}m`,
            prompt: { by: d.ceoId ?? item.from, at: opened, text: item.brief },
            steps: item.work,
            answer: item.report,
            attachments: item.attachments,
          },
        ],
      },
    ],
    asks: [
      ...d.asks,
      {
        id: item.id,
        ticketId,
        threadId: item.threadId,
        from: item.from,
        kind: "approval",
        title: item.title,
        waiting: 0,
        at: Date.now(),
        ask: item.ask,
        why: item.why,
        ifYes: item.ifYes,
        ifNo: item.ifNo,
        ...(item.spend && agent.spend
          ? {
              spend: {
                amount: item.spend,
                used: agent.spend.used,
                cap: agent.spend.cap,
              },
            }
          : {}),
        fallback: item.fallback,
      },
    ],
  };
}

/** A CEO update goes on top of the updates and into the standing thread, and
    the tickets it reports as finished are finished. */
function addUpdate(d: V3Data, item: UpdateItem): V3Data {
  const by = d.ceoId ?? d.agents[0]?.id;
  if (!by) return d;
  const at = nowClock();
  const settled = item.finishes ? finishTickets(d, item.finishes) : d;
  return {
    ...settled,
    updates: [
      {
        id: item.id,
        by,
        at,
        ticketId: item.ticketId,
        kind: "note",
        text: item.text,
      },
      ...settled.updates,
    ],
    threads: settled.threads.map((t) =>
      t.id === CEO_THREAD_ID
        ? {
            ...t,
            turns: [
              ceoTurn(Math.max(0, ...t.turns.map((u) => u.n)) + 1, {
                at,
                text: item.text,
              }),
              ...t.turns,
            ],
          }
        : t,
    ),
  };
}

/** Takes the next queued item (of `kind`, or alternating ask / update when
    omitted), adds it to the company as a real item, and returns what its
    notification says. Undefined when nothing is queued. */
export function releaseNext(kind?: "ask" | "update"): Released | undefined {
  const order: ("ask" | "update")[] = kind
    ? [kind]
    : last === "ask"
      ? ["update", "ask"]
      : ["ask", "update"];
  for (const k of order) {
    const d = $data.get();
    if (k === "ask") {
      const item = asks.shift();
      if (!item) continue;
      last = "ask";
      $data.set(addAsk(d, item));
      return {
        kind: "ask",
        id: item.id,
        title: item.title,
        body: `${agentNameOf(d, item.from)} asks: ${item.ask}`,
      };
    }
    const item = updates.shift();
    if (!item) continue;
    last = "update";
    $data.set(addUpdate(d, item));
    return {
      kind: "update",
      id: item.id,
      title: `${agentNameOf(d, d.ceoId ?? "")} update`,
      body: item.text,
    };
  }
  return undefined;
}
