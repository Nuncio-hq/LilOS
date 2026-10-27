import { z } from "zod";
import {
  AppMessage,
  AuthorKind,
  Conversation,
  Timestamp,
  WorkspaceIntent,
} from "./domain";

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
  /** Absent when the project that owned it was removed (D-#854) — a goal
      keeps its record, it just belongs to no project. */
  projectId: z.string().min(1).optional(),
  due: z.string(),
  why: z.string(),
  /** Absent = the human owns the goal. */
  ownerId: z.string().min(1).optional(),
  createdAt: Timestamp,
});
export type Goal = z.infer<typeof Goal>;

/**
 * The orchestration half of a task ticket (D-#844). The ticket IS the task
 * record (D-#179 — no job/subagent table); this blob carries the lineage
 * and the wake bookkeeping. `wakedTurnIds` is the relay's exactly-once
 * fence: a rebound engine session replays `turn.completed`, so the note
 * and the post both check it before a wake goes out. `lastResult.finishedSeq`
 * additionally fences the restart catch-up scan, which cannot know the
 * turn id a finished-only replay would carry.
 */
export const TicketTask = z.object({
  /** The thread that created the task — every task op scopes to it. */
  parentConversationId: z.string().min(1),
  /** The child's own thread — an ordinary conversation with `parentId`. */
  childConversationId: z.string().min(1),
  /** The child's channel — internal routing the app leg needs for
      follow-up reads/posts; set once at create. */
  childChannelId: z.string().min(1),
  /** D-#848: where the child ran when isolation forked a worktree —
      the task record's own memory (its thread can later move folders).
      Absent = the child shares the parent's folder. */
  worktree: z
    .strictObject({ path: z.string().min(1), branch: z.string().min(1) })
    .optional(),
  /** The creating call's idempotency key — unique per parent thread. */
  requestId: z.string().min(1).optional(),
  /** Set by `tasks.cancel`; a cancelled task never wakes the parent. */
  cancelledAt: Timestamp.optional(),
  /** Child turn ids whose result was already delivered (the fence above). */
  wakedTurnIds: z.array(z.string().min(1)).optional(),
  /** The last delivered result, so `tasks.read`/`task_wait` answer it. */
  lastResult: z
    .object({
      turnId: z.string().min(1),
      outcome: z.enum(["finished", "stopped", "failed"]),
      text: z.string(),
      /** The child's `finishedSeq` when the wake posted — the catch-up
          fence (D-#844). */
      finishedSeq: z.int().min(0),
      at: Timestamp,
    })
    .strict()
    .optional(),
});
export type TicketTask = z.infer<typeof TicketTask>;

export const Ticket = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  /** Absent when the project that owned it was removed (D-#854) — a ticket
      keeps its record, it just belongs to no project. */
  projectId: z.string().min(1).optional(),
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
  /** Present on an agent hand-off ticket (D-#844) — absent elsewhere. */
  task: TicketTask.optional(),
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

/* --------------------------- tasks (D-#844) ------------------------------ */

/** Cap on a child's result inlined into the parent's wake — `task_read`
    has the whole thread past it. */
export const TASK_RESULT_MAX_BYTES = 8 * 1024;

/** What an agent reads back — derived from the ticket's task blob;
    `running` until the child turn ends or the task is cancelled. */
export const TaskStatus = z.enum([
  "running",
  "finished",
  "stopped",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** The agent-facing task view: the ticket's task blob flattened for the
    `task_*` tools — never the raw ticket (D-#844). */
export const Task = z.object({
  /** The task/ticket id (`LIL-12`). */
  id: z.string().min(1),
  title: z.string().min(1),
  status: TaskStatus,
  /** The employee doing the work. */
  agentId: z.string().min(1),
  agentName: z.string().optional(),
  /** The child thread the task runs as — `thread_read`/`thread_post`
      reach it (parent-scoped). */
  threadId: z.string().min(1),
  /** The child's channel — internal routing, not a place (D-#25); the
      app leg needs it to scope follow-up reads/posts. */
  channelId: z.string().min(1),
  /** The parent thread — the only thread allowed to read/wait/cancel. */
  parentThreadId: z.string().min(1),
  /** Where the child works when isolation forked a worktree (D-#848);
      absent = it shares the parent's folder. */
  worktree: z
    .strictObject({ path: z.string().min(1), branch: z.string().min(1) })
    .optional(),
  /** The finished turn's text, capped at TASK_RESULT_MAX_BYTES. */
  result: z.string().optional(),
  resultOutcome: z.enum(["finished", "stopped", "failed"]).optional(),
  createdAt: Timestamp,
  finishedAt: Timestamp.optional(),
  cancelledAt: Timestamp.optional(),
});
export type Task = z.infer<typeof Task>;

/** Host-only: the calling session's thread is the scope (the `agent` tool
    param resolves to an employee id in the app leg). Access, cwd and
    project derive from the parent conversation — never requested. */
export const TasksCreateParams = z
  .object({
    parentConversationId: z.string().min(1),
    employeeId: z.string().min(1),
    /** The child's whole input — its thread opens with this and nothing
        else; the parent's history is never copied (D-#844). */
    prompt: z.string().min(1),
    title: z.string().trim().min(1).optional(),
    /** The caller's idempotency key — a repeat returns the same task
        (T3 `clientRequestId`, D-#844). */
    requestId: z.string().min(1).max(200).optional(),
    /** Optional model pick for the child thread (same fields as
        `conversations.open`). */
    model: z.string().min(1).optional(),
    provider: z.string().optional(),
    effort: z.string().optional(),
    fast: z.boolean().optional(),
    /** Host-only (D-#848): the harness resolves `isolation` into the
        `conversations.open.workspace` intent a workstream open already
        carries (#156) — `cwd` the new worktree dir, `workspace.repoPath`
        the repo it forks. Absent = the child inherits the parent's
        folder (shared). */
    cwd: z.string().min(1).optional(),
    workspace: WorkspaceIntent.optional(),
  })
  .strict();
export type TasksCreateParams = z.infer<typeof TasksCreateParams>;
export const TasksCreateResult = z.object({
  task: Task,
  ticket: Ticket,
  conversation: Conversation,
  rootMessage: AppMessage,
});
export type TasksCreateResult = z.infer<typeof TasksCreateResult>;

/** `parentConversationId` is host-supplied — the scope check; a task id
    another thread created reads `not_found` (D-#844). */
export const TasksScopedParams = z
  .object({
    taskId: z.string().min(1),
    parentConversationId: z.string().min(1),
  })
  .strict();
export type TasksScopedParams = z.infer<typeof TasksScopedParams>;
/** Shared envelope for `tasks.read`/`tasks.cancel`. */
export const TaskEnvelope = z.object({ task: Task });
export type TaskEnvelope = z.infer<typeof TaskEnvelope>;

/** The harness's batch post: one coalesced parent wake per call. The
    relay drops events already delivered (`wakedTurnIds`) and every
    cancelled task, then posts one `taskWake` message and stamps each
    surviving ticket — the write and the post stay atomic (D-#844). */
export const TaskWakeEvent = z
  .object({
    taskId: z.string().min(1),
    /** The child turn whose end this reports — the replay fence key. */
    turnId: z.string().min(1),
    outcome: z.enum(["finished", "stopped", "failed"]),
    /** Inlined result text, already capped at TASK_RESULT_MAX_BYTES. */
    result: z.string().optional(),
  })
  .strict();
export type TaskWakeEvent = z.infer<typeof TaskWakeEvent>;
export const TasksWakeParams = z
  .object({ events: z.array(TaskWakeEvent).min(1).max(50) })
  .strict();
export type TasksWakeParams = z.infer<typeof TasksWakeParams>;
export const TasksWakeResult = z.object({
  /** Task ids this call actually posted + stamped — a replayed turn id
      drops out, so the caller knows what really woke the parent. */
  delivered: z.array(z.string()),
});
export type TasksWakeResult = z.infer<typeof TasksWakeResult>;

/** The caller's live child threads — the `thread_*` follow-up scope
    lookup (D-#844). Host-only plumbing, never a tool. */
export const TasksChildrenParams = z
  .object({ parentConversationId: z.string().min(1) })
  .strict();
export type TasksChildrenParams = z.infer<typeof TasksChildrenParams>;
export const TasksChildrenResult = z.object({
  /** The parent's live child threads. */
  conversations: z.array(Conversation),
  /** Their task tickets — the threadId ↔ taskId map for `thread` params. */
  tickets: z.array(Ticket),
});
export type TasksChildrenResult = z.infer<typeof TasksChildrenResult>;

/** Cut a result to the wake's inline cap (D-#844) — utf8 bytes, on a
    code-point boundary. */
export function capTaskResult(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= TASK_RESULT_MAX_BYTES) return text;
  let end = TASK_RESULT_MAX_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/**
 * The wake text the parent reads as its next prompt — one line per child
 * turn, result inlined (D-#844). `lookup` supplies title/agentName so the
 * line names who reported. The cap lands HERE, not on the stored result —
 * `lastResult` keeps the full text so `task_read` answers what the wake
 * cut (thread_read has the whole transcript either way).
 */
export function formatTaskWake(
  events: readonly TaskWakeEvent[],
  lookup: (
    taskId: string,
  ) => { title?: string; agentName?: string } | undefined,
): string {
  const lines = ["Your task results:"];
  for (const event of events) {
    const meta = lookup(event.taskId);
    const name = meta?.agentName ? ` (${meta.agentName})` : "";
    const title = meta?.title ? ` "${meta.title}"` : "";
    const head = `- ${event.taskId}${title}${name} ${event.outcome}`;
    const result = event.result?.trim();
    lines.push(result ? `${head}: ${capTaskResult(result)}` : head);
  }
  lines.push(
    "Use task_read for the record or thread_read on the child thread for the transcript.",
  );
  return lines.join("\n");
}
