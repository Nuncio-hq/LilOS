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

const CLEARS_WAIT = new Set<TicketStatus>(["working", "planned", "done"]);

/**
 * Status and what the ticket waits on are one fact (D-#776). Waiting on you
 * is needs; waiting on an agent, a ticket, or the CEO is waiting. No wait,
 * and a status that only exists because of one, is working when someone
 * holds it and planned otherwise. Working, planned, and done never wait.
 */
export function initialStatus(input: {
  status?: TicketStatus;
  waitingOn?: TicketWaitingOn;
  ownerId?: string;
}): { status: TicketStatus; waitingOn?: TicketWaitingOn } {
  if (input.status && CLEARS_WAIT.has(input.status)) {
    return { status: input.status };
  }
  if (input.waitingOn) {
    return {
      status: input.waitingOn.kind === "you" ? "needs" : "waiting",
      waitingOn: input.waitingOn,
    };
  }
  if (input.status === "needs" || input.status === "waiting") {
    return { status: input.ownerId ? "working" : "planned" };
  }
  return { status: input.status ?? "planned" };
}

const drop = <T extends object, K extends keyof T>(row: T, key: K): T => {
  const next = { ...row };
  delete next[key];
  return next;
};

/** A planned ticket becomes working when someone is checked out on it, and
    that move drops the wait (working never waits). Anything already
    waiting, stuck, or finished keeps its status. */
export function checkout(ticket: Ticket, ownerId: string, at: number): Ticket {
  if (ticket.status !== "planned") return { ...ticket, ownerId };
  return {
    ...drop(ticket, "waitingOn"),
    ownerId,
    status: "working",
    statusAt: at,
  };
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

const stamp = (ticket: Ticket, status: TicketStatus, at: number): Ticket =>
  ticket.status === status
    ? ticket
    : {
        ...ticket,
        status,
        statusAt: at,
        ...(status === "done" ? { doneAt: ticket.doneAt ?? at } : {}),
      };

/** Apply a field write, then make status and waitingOn agree. Becoming
    done is finished off by `finish`, which also wakes waiters. */
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
    next = stamp(next, patch.status, at);
  }
  /* Moving to working, planned, or done drops the wait. A wait that remains
     sets the status. Clearing a wait (or a needs/waiting status with nothing
     to wait on) is working when owned, otherwise planned — unless this write
     named another status, such as stuck. */
  if (patch.status && CLEARS_WAIT.has(patch.status)) {
    next = drop(next, "waitingOn");
  } else if (next.waitingOn) {
    next = stamp(next, next.waitingOn.kind === "you" ? "needs" : "waiting", at);
  } else if (
    patch.waitingOn === null &&
    (patch.status === undefined ||
      patch.status === "needs" ||
      patch.status === "waiting")
  ) {
    next = stamp(next, next.ownerId ? "working" : "planned", at);
  } else if (next.status === "needs" || next.status === "waiting") {
    next = stamp(next, next.ownerId ? "working" : "planned", at);
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
