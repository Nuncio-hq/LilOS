import type {
  Ticket,
  TicketStatus,
  TicketStep,
  TicketUpdate,
  TicketWaitingOn,
} from "@lilos/contracts/app";

/**
 * Ticket rules shared by the sqlite store and the memory store (D-#776).
 * The stores persist; this file only decides the next record. Assign's
 * thread and the number allocation stay in the store, inside the same
 * transaction as the owner write.
 */

export function initialStatus(input: {
  status?: TicketStatus;
  waitingOn?: TicketWaitingOn;
}): TicketStatus {
  if (input.status) return input.status;
  const waiting = input.waitingOn;
  if (!waiting) return "planned";
  if (waiting.kind === "you") return "needs";
  return "waiting";
}

/** A planned ticket becomes working when someone is checked out on it.
    Anything already waiting, stuck, or finished keeps its status. */
export function checkout(ticket: Ticket, ownerId: string, at: number): Ticket {
  if (ticket.status !== "planned") return { ...ticket, ownerId };
  return { ...ticket, ownerId, status: "working", statusAt: at };
}

export type TicketWrite = {
  title?: string;
  goalId?: string | null;
  status?: TicketStatus;
  waitingOn?: TicketWaitingOn | null;
  progress?: TicketStep[];
  result?: Ticket["result"] | null;
  startsAt?: string | null;
  stuckWhy?: string | null;
};

const drop = <T extends object, K extends keyof T>(row: T, key: K): T => {
  const next = { ...row };
  delete next[key];
  return next;
};

/** Apply a field write. Status is the caller's; becoming done is stamped
    here and finished off by `finish`, which also wakes waiters. */
export function applyWrite(
  ticket: Ticket,
  patch: TicketWrite,
  at: number,
): Ticket {
  let next: Ticket = { ...ticket, updates: [...ticket.updates] };
  if (patch.title !== undefined) next = { ...next, title: patch.title };
  if (patch.goalId === null) next = drop(next, "goalId");
  else if (patch.goalId !== undefined) next = { ...next, goalId: patch.goalId };
  if (patch.progress !== undefined)
    next = { ...next, progress: patch.progress };
  if (patch.result === null) next = drop(next, "result");
  else if (patch.result !== undefined) next = { ...next, result: patch.result };
  if (patch.startsAt === null) next = drop(next, "startsAt");
  else if (patch.startsAt !== undefined)
    next = { ...next, startsAt: patch.startsAt };
  if (patch.stuckWhy === null) next = drop(next, "stuckWhy");
  else if (patch.stuckWhy !== undefined)
    next = { ...next, stuckWhy: patch.stuckWhy };
  if (patch.waitingOn === null) next = drop(next, "waitingOn");
  else if (patch.waitingOn !== undefined)
    next = { ...next, waitingOn: patch.waitingOn };
  if (patch.status !== undefined && patch.status !== ticket.status) {
    next = {
      ...next,
      status: patch.status,
      statusAt: at,
      ...(patch.status === "done" ? { doneAt: at } : {}),
    };
  }
  return next;
}

/** A finished ticket waits on nothing. */
export function finish(ticket: Ticket, at: number): Ticket {
  const next = drop(ticket, "waitingOn");
  return {
    ...next,
    status: "done",
    statusAt: ticket.status === "done" ? ticket.statusAt : at,
    doneAt: ticket.doneAt ?? at,
  };
}

/** The waiter can move: working when someone holds it, otherwise planned.
    The update names the ticket that unblocked it. */
export function wakeWaiter(
  waiter: Ticket,
  done: Ticket,
  at: number,
  update: TicketUpdate,
): Ticket {
  const next = drop(waiter, "waitingOn");
  return {
    ...next,
    status: waiter.ownerId ? "working" : "planned",
    statusAt: at,
    updates: [
      ...waiter.updates,
      { ...update, text: `${done.id} is done, so this can move.` },
    ],
  };
}

export function withUpdate(ticket: Ticket, update: TicketUpdate): Ticket {
  return { ...ticket, updates: [...ticket.updates, update] };
}
