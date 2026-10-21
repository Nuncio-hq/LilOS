import type { Goal, Ticket } from "@lilos/contracts/app";
import type { V3Goal, V3ProgressStep, V3Ticket, V3WaitingOn } from "@lilos/ui";

const MIN = 60_000;

/** Minutes from `at` until `now`, never negative. */
const ago = (at: number, now: number) =>
  Math.max(0, Math.round((now - at) / MIN));

/**
 * Relay goals and tickets become the view models the existing pages already
 * draw (D-#776). Progress on a goal is computed from its tickets by the
 * page, so a goal here is only its words. An empty owner stays empty: the
 * row says Unassigned, not that someone left.
 */
export function v3Goals(goals: readonly Goal[]): V3Goal[] {
  return goals.map((g) => ({
    id: g.id,
    title: g.title,
    projectId: g.projectId,
    due: g.due,
    why: g.why,
  }));
}

export function v3Tickets(tickets: readonly Ticket[], now: number): V3Ticket[] {
  return tickets.map((t) => ({
    id: t.id,
    title: t.title,
    projectId: t.projectId,
    ...(t.goalId ? { goalId: t.goalId } : {}),
    owner: t.ownerId ?? "",
    status: t.status,
    ...(t.waitingOn ? { waitingOn: waitingOf(t.waitingOn) } : {}),
    ...(t.stuckWhy ? { stuckWhy: t.stuckWhy } : {}),
    since: ago(t.statusAt, now),
    ...(t.startsAt ? { startsAt: t.startsAt } : {}),
    progress: stepsOf(t.progress),
    ...(t.result ? { result: t.result } : {}),
    updates: t.updates.map((u) => ({
      by: u.by,
      ago: ago(u.at, now),
      text: u.text,
    })),
    ...(t.doneAt != null ? { doneAgo: ago(t.doneAt, now) } : {}),
  }));
}

function waitingOf(w: NonNullable<Ticket["waitingOn"]>): V3WaitingOn {
  if (w.kind === "you") return { kind: "you", askId: "" };
  if (w.kind === "agent")
    return { kind: "agent", agentId: w.agentId, why: w.why ?? "" };
  return { kind: "ticket", ticketId: w.ticketId };
}

/** The first unfinished row is the current one; the relay only stores done. */
function stepsOf(steps: Ticket["progress"]): V3ProgressStep[] {
  let current = false;
  return steps.map((s) => {
    if (s.done)
      return { text: s.text, by: s.by ?? "", took: "", state: "done" };
    if (!current) {
      current = true;
      return { text: s.text, by: s.by ?? "", took: "", state: "current" };
    }
    return { text: s.text, by: s.by ?? "", took: "", state: "todo" };
  });
}
