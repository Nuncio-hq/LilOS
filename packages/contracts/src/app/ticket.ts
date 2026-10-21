import { z } from "zod";
import { AppMessage, AuthorKind, Conversation, Timestamp } from "./domain";

/**
 * Goals and tickets (D-#776). The relay owns both. A ticket's id is its
 * project's key plus a number (`LIL-12`). One owner. A thread links to at
 * most one ticket (`Conversation.ticketId`); assigning is the checkout that
 * opens that thread. Not: a client-side list, one thread on many tickets,
 * or a CEO type. Waiting on the CEO is the role `{kind: "ceo"}`, never a
 * person's id, so it follows whoever holds the seat. Assign's owner is
 * always an employee id ("ceo" there is whoever was hired first, until a
 * CEO is named).
 */

export const TicketStatus = z.enum([
  "planned",
  "working",
  "waiting",
  "needs",
  "stuck",
  "done",
  "failed",
]);
export type TicketStatus = z.infer<typeof TicketStatus>;

/** Absent means the ticket waits on nothing. `you` is the human. `ceo` is
    the role, resolved to whoever holds it when the ticket is shown. */
export const TicketWaitingOn = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("you") }).strict(),
  z.object({ kind: z.literal("ceo") }).strict(),
  z
    .object({
      kind: z.literal("agent"),
      agentId: z.string().min(1),
      why: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ticket"),
      ticketId: z.string().min(1),
    })
    .strict(),
]);
export type TicketWaitingOn = z.infer<typeof TicketWaitingOn>;

/** A checklist row. `done` is the only state the relay stores; the app
    paints the first unfinished row as the current one. */
export const TicketStep = z.object({
  text: z.string().min(1),
  done: z.boolean(),
  by: z.string().min(1).optional(),
});
export type TicketStep = z.infer<typeof TicketStep>;

export const TicketResult = z.object({
  pr: z
    .object({
      num: z.number().int(),
      branch: z.string(),
      add: z.number().int(),
      del: z.number().int(),
    })
    .optional(),
  files: z
    .array(z.object({ name: z.string().min(1), note: z.string() }))
    .optional(),
});
export type TicketResult = z.infer<typeof TicketResult>;

export const TicketUpdate = z.object({
  id: z.string().min(1),
  /** Who wrote it. The same kinds a message uses: `user` the human,
      `employee` an agent, `system` LilOS itself. A system note names
      nobody — a waiter unblocked when its blocker finishes is LilOS,
      not the ticket's owner. */
  authorKind: AuthorKind,
  /** Employee id, or "you" for the human. Absent when LilOS wrote it. */
  by: z.string().min(1).optional(),
  at: Timestamp,
  text: z.string(),
});
export type TicketUpdate = z.infer<typeof TicketUpdate>;

export const Goal = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  projectId: z.string().min(1),
  due: z.string(),
  why: z.string(),
  /** Absent = the human owns the goal. */
  ownerId: z.string().min(1).optional(),
  createdAt: Timestamp,
});
export type Goal = z.infer<typeof Goal>;

export const Ticket = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  projectId: z.string().min(1),
  goalId: z.string().min(1).optional(),
  /** Absent = nobody holds it yet. */
  ownerId: z.string().min(1).optional(),
  status: TicketStatus,
  waitingOn: TicketWaitingOn.optional(),
  progress: z.array(TicketStep),
  result: TicketResult.optional(),
  updates: z.array(TicketUpdate),
  stuckWhy: z.string().optional(),
  startsAt: z.string().optional(),
  statusAt: Timestamp,
  doneAt: Timestamp.optional(),
  createdAt: Timestamp,
});
export type Ticket = z.infer<typeof Ticket>;

/* ------------------------------- wire params ----------------------------- */

export const GoalsListParams = z.object({}).strict();
export const GoalsListResult = z.object({ goals: z.array(Goal) });
export type GoalsListResult = z.infer<typeof GoalsListResult>;

/** `project` is an id or a key. `ownerId` absent means the human. */
export const GoalsCreateParams = z
  .object({
    project: z.string().min(1),
    title: z.string().trim().min(1),
    due: z.string().optional(),
    why: z.string().optional(),
    ownerId: z.string().min(1).optional(),
  })
  .strict();
export type GoalsCreateParams = z.infer<typeof GoalsCreateParams>;

export const GoalResult = z.object({ goal: Goal });
export type GoalResult = z.infer<typeof GoalResult>;

export const GoalUpsertedEvent = z.object({ goal: Goal });
export type GoalUpsertedEvent = z.infer<typeof GoalUpsertedEvent>;

export const TicketsListParams = z
  .object({ project: z.string().min(1).optional() })
  .strict();
export type TicketsListParams = z.infer<typeof TicketsListParams>;
export const TicketsListResult = z.object({ tickets: z.array(Ticket) });
export type TicketsListResult = z.infer<typeof TicketsListResult>;

export const TicketsReadParams = z.object({ id: z.string().min(1) }).strict();
export type TicketsReadParams = z.infer<typeof TicketsReadParams>;

export const TicketResultEnvelope = z.object({ ticket: Ticket });
export type TicketResultEnvelope = z.infer<typeof TicketResultEnvelope>;

export const TicketsCreateParams = z
  .object({
    project: z.string().min(1),
    title: z.string().trim().min(1),
    goalId: z.string().min(1).optional(),
    ownerId: z.string().min(1).optional(),
    status: TicketStatus.optional(),
    waitingOn: TicketWaitingOn.optional(),
    progress: z.array(TicketStep).optional(),
    startsAt: z.string().optional(),
    stuckWhy: z.string().optional(),
    /** Host-only. The employee who wrote the ticket, so a CEO wake can
        ignore the CEO's own action (D-#777). A user client cannot set it. */
    actorId: z.string().min(1).optional(),
  })
  .strict();
export type TicketsCreateParams = z.infer<typeof TicketsCreateParams>;

/** Owner changes only through `tickets.assign` — checkout is that one
    transaction, not a field on an update. `null` clears an optional. */
export const TicketsUpdateParams = z
  .object({
    id: z.string().min(1),
    title: z.string().trim().min(1).optional(),
    goalId: z.string().min(1).nullable().optional(),
    status: TicketStatus.optional(),
    waitingOn: TicketWaitingOn.nullable().optional(),
    progress: z.array(TicketStep).optional(),
    result: TicketResult.nullable().optional(),
    startsAt: z.string().nullable().optional(),
    stuckWhy: z.string().nullable().optional(),
    /** Host-only. See `TicketsCreateParams.actorId` (D-#777). */
    actorId: z.string().min(1).optional(),
  })
  .strict();
export type TicketsUpdateParams = z.infer<typeof TicketsUpdateParams>;

export const TicketsChangedResult = z.object({ tickets: z.array(Ticket) });
export type TicketsChangedResult = z.infer<typeof TicketsChangedResult>;

/** `ownerId` may be "ceo": the relay stores an employee id, never a role. */
export const TicketsAssignParams = z
  .object({
    id: z.string().min(1),
    ownerId: z.string().min(1),
    /** Host-only. See `TicketsCreateParams.actorId` (D-#777). */
    actorId: z.string().min(1).optional(),
  })
  .strict();
export type TicketsAssignParams = z.infer<typeof TicketsAssignParams>;

export const TicketsAssignResult = z.object({
  ticket: Ticket,
  conversation: Conversation,
  rootMessage: AppMessage,
});
export type TicketsAssignResult = z.infer<typeof TicketsAssignResult>;

/** `by` is host-only. A person's comment is stamped "you". */
export const TicketsCommentParams = z
  .object({
    id: z.string().min(1),
    text: z.string().trim().min(1),
    by: z.string().min(1).optional(),
  })
  .strict();
export type TicketsCommentParams = z.infer<typeof TicketsCommentParams>;

export const TicketUpsertedEvent = z.object({
  ticket: Ticket,
  /** Present when the host named the employee who wrote the ticket (D-#777). */
  actorId: z.string().min(1).optional(),
});
export type TicketUpsertedEvent = z.infer<typeof TicketUpsertedEvent>;
