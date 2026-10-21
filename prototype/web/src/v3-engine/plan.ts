import { agentOf, type V3Data, type V3DataActions, type V3Draft, type V3Status, type V3Thread } from "@lilos/ui"
import type { Engine } from "./context"

/* A started ⌘K plan becomes real records: tickets that can start now get a
   working thread at once; the rest wait on the ticket before them, and the
   one that asks the chairman first stays planned. */
export function planRecords(
  d: V3Data,
  plan: Extract<V3Draft, { kind: "plan" }>,
  text: string,
): V3Data {
  const projectKey = plan.tickets[0].id.split("-")[0];
  const project = d.projects.find((p) => p.key === projectKey) ?? d.projects[0];
  const ids = new Set(plan.tickets.map((t) => t.id));
  const tickets = plan.tickets.map((t) => ({
    id: t.id,
    title: t.title,
    projectId: project.id,
    goalId: plan.goalId,
    owner: t.owner,
    status: (t.asksYou
      ? "planned"
      : t.after
        ? "waiting"
        : "working") as V3Status,
    waitingOn:
      t.after && ids.has(t.after)
        ? { kind: "ticket" as const, ticketId: t.after }
        : undefined,
    startsAt: t.asksYou ? `after ${t.after}` : undefined,
    since: 0,
    started: t.after ? undefined : "Today 12:05",
    progress: [
      {
        text: t.title,
        by: t.owner,
        took: t.after ? "" : "just started",
        state: (t.after ? "todo" : "current") as "todo" | "current",
      },
    ],
    updates: [
      { by: d.ceoId ?? d.agents[0].id, ago: 0, text: `Part of your request: “${text}”.` },
    ],
  }));
  const threads: V3Thread[] = plan.tickets
    .filter((t) => !t.after && !t.asksYou)
    .map((t) => ({
      id: `t-${t.id.toLowerCase()}`,
      ticketId: t.id,
      agentId: t.owner,
      title: t.title,
      status: "working",
      startedAt: "12:05",
      minutes: 0,
      step: 1,
      context: 3,
      model: agentOf(d, t.owner)?.model,
      folder: project.folder,
      now: { kind: "read", text: "Reading the brief", elapsed: "0s" },
      live: {
        cmd: `Starting ${t.id}`,
        lines: [
          "Read the ticket and the goal",
          "Read the project's notes",
          "Planning the first step…",
        ],
      },
      tail: ["Read the ticket and the goal", "Planning the first step…"],
      plan: [{ text: t.title, state: "current" }],
      turns: [
        {
          n: 1,
          from: "asked by CEO just now",
          took: "0m so far",
          steps: [
            { kind: "read", target: `${t.id} · the brief`, running: true },
          ],
        },
      ],
    }));
  return {
    ...d,
    tickets: [...tickets, ...d.tickets],
    threads: [...threads, ...d.threads],
    updates: [
      {
        id: `u-${plan.tickets[0].id}`,
        by: d.ceoId ?? d.agents[0].id,
        at: "12:05",
        ticketId: plan.tickets[0].id,
        kind: "plan",
        text: `Started your request “${text}” as ${plan.tickets.length} tickets.`,
      },
      ...d.updates,
    ],
  };
}

/* ⌘K's started plan. */
export function planActions({ setData, toast }: Engine): Pick<V3DataActions, "startPlan"> {
  return {
    startPlan: (plan, text) => {
      setData((d) => planRecords(d, plan, text))
      const started = plan.tickets.filter((t) => !t.after && !t.asksYou).length
      toast(`${plan.tickets.length} tickets created · ${started} ${started === 1 ? "agent" : "agents"} started`)
    },
  }
}
