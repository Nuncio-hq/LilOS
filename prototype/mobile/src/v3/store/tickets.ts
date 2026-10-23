import type { V3Data, V3ProgressStep } from "@lilos/ui/v3-data";

/** One step on a ticket's checklist: current → done, the next todo → current. */
export function advance(steps: V3ProgressStep[]): V3ProgressStep[] {
  const i = steps.findIndex((s) => s.state === "current");
  return steps.map((s, j) =>
    j === i
      ? { ...s, state: "done" as const, took: s.took.replace(" so far", "") }
      : j === i + 1
        ? { ...s, state: "current" as const, took: "just started" }
        : s,
  );
}

/** The step that was waiting on you is over; what comes after stays todo,
    because a closed ticket never did it. */
export function closeCurrent(steps: V3ProgressStep[]): V3ProgressStep[] {
  return steps.map((s) =>
    s.state === "current"
      ? { ...s, state: "done" as const, took: s.took.replace(" so far", "") }
      : s,
  );
}

/** Every step done, as on a ticket that ran to the end. */
export function completeSteps(steps: V3ProgressStep[]): V3ProgressStep[] {
  return steps.map((s) => ({
    ...s,
    state: "done" as const,
    took: s.took ? s.took.replace(" so far", "") : "just now",
  }));
}

/** Tickets that finished without going through an ask (a CEO update says so):
    the ticket is done now, its threads are done and unseen so the result shows
    up under "to look at", and nothing is left waiting on them. */
export function finishTickets(d: V3Data, ids: string[]): V3Data {
  return {
    ...d,
    tickets: d.tickets.map((t) =>
      ids.includes(t.id)
        ? {
            ...t,
            status: "done" as const,
            waitingOn: undefined,
            stuckWhy: undefined,
            fallback: undefined,
            startsAt: undefined,
            since: 0,
            doneAgo: 0,
            progress: completeSteps(t.progress),
          }
        : t,
    ),
    threads: d.threads.map((t) =>
      t.ticketId &&
      ids.includes(t.ticketId) &&
      t.status !== "done" &&
      t.status !== "failed"
        ? {
            ...t,
            status: "done" as const,
            unseen: true,
            doneAgo: 0,
            askId: undefined,
            stuck: undefined,
            now: undefined,
            live: undefined,
            tail: undefined,
          }
        : t,
    ),
    asks: d.asks.filter((a) => !a.ticketId || !ids.includes(a.ticketId)),
  };
}
