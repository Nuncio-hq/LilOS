import {
  formatTaskWake,
  type Task,
  type TaskStatus,
  TasksChildrenParams,
  TasksCreateParams,
  TasksScopedParams,
  TasksWakeParams,
  type TaskWakeEvent,
  type Ticket,
} from "@lilos/contracts/app";
import { openFolderOf } from "../projects";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/**
 * Agent hand-offs (D-#844). The ticket is the task record (D-#179); the
 * child is an ordinary thread with `parentId` lineage. Every method is
 * host-only — `parentConversationId` arrives from the harness's session
 * binding, never the model, so one thread can only reach tasks it made.
 * Create derives project, folder, and access from the parent (the child's
 * access is the parent's own — never broader, D-#106), asks no approval,
 * and a repeated `requestId` answers the stored task.
 */
export async function handleTasks(c: RelayCtx): Promise<false | undefined> {
  const { method, params, store, broadcast, requireHost } = c;
  switch (method) {
    case "tasks.create": {
      const parsed = TasksCreateParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      requireHost(c.peer);
      const p = parsed.data;
      const parent = await store.getConversation(p.parentConversationId);
      if (!parent) notFound("parent conversation");
      const employee = await store.getEmployee(p.employeeId);
      if (!employee) notFound("employee");
      /* The child files under the parent's project; a parent never filed
         (opened before projects) falls back to its folder's project like
         an open would (D-#771). A folder-less chat cannot carry a task
         ticket. */
      let project = parent.projectId
        ? await store.getProject(parent.projectId)
        : null;
      if (!project) {
        const folder = openFolderOf(parent, c.homeDir);
        if (!folder) {
          throw new RpcError(
            JsonRpcCode.invalidParams,
            "invalid_params",
            "the calling thread has no project or folder",
          );
        }
        const filing = await store.ensureProject({ folder });
        if (filing.created) {
          broadcast("project.upserted", { project: filing.project });
        }
        project = filing.project;
      }
      const { channel, created: channelCreated } = await store.openDmChannel(
        employee.id,
      );
      if (channelCreated) broadcast("channel.created", { channel });
      const opened = await store.createTask({
        title: p.title ?? p.prompt.replace(/\s+/g, " ").trim().slice(0, 80),
        parentConversationId: parent.id,
        employeeId: employee.id,
        channelId: channel.id,
        prompt: p.prompt,
        projectId: project.id,
        projectKey: project.key,
        access: parent.access,
        /* D-#848: the host resolves `isolation` into a `cwd` + #156
           `workspace` intent before this call — the child's folder then
           overrides the parent's; absent means shared. The task blob
           keeps where the child ran so `task_read` answers it without a
           second lookup. */
        ...((p.cwd ?? parent.cwd) !== undefined
          ? { cwd: p.cwd ?? parent.cwd }
          : {}),
        ...(p.workspace !== undefined ? { workspace: p.workspace } : {}),
        ...(p.cwd !== undefined && p.workspace?.mode === "new"
          ? { worktree: { path: p.cwd, branch: p.workspace.branch } }
          : {}),
        /* #872: the child runs on ITS agent's pick — explicit choice (the
           host already checked it against the child's runtime catalog),
           else the child employee's stored default, else absent and the
           child's engine applies its own. Never the parent's: a pick made
           for another runtime's catalog would silently fail there. */
        ...(p.model !== undefined
          ? { model: p.model }
          : employee.model
            ? { model: employee.model }
            : {}),
        ...(p.provider !== undefined ? { provider: p.provider } : {}),
        /* The employee's effort belongs to ITS model's ladder — it rides
           only when the child runs that model. */
        ...(p.effort !== undefined
          ? { effort: p.effort }
          : employee.effort &&
              (p.model === undefined || p.model === employee.model)
            ? { effort: employee.effort }
            : {}),
        ...(p.fast !== undefined ? { fast: p.fast } : {}),
        ...(p.requestId ? { requestId: p.requestId } : {}),
      });
      /* A requestId hit re-answers the stored task without re-announcing
         — the #552 dedupe rule for a repeated open. */
      if (opened.created) {
        c.emitMessage(channel.id, opened.rootMessage);
        c.emitConversation(channel.id, opened.conversation);
        broadcast("ticket.upserted", { ticket: opened.ticket });
      }
      c.respond(c.peer, c.id, {
        task: toTask(opened.ticket, employee.name),
        ticket: opened.ticket,
        conversation: opened.conversation,
        rootMessage: opened.rootMessage,
      });
      return;
    }
    case "tasks.read": {
      const parsed = TasksScopedParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      requireHost(c.peer);
      const task = await scopedTask(c, parsed.data);
      c.respond(c.peer, c.id, { task });
      return;
    }
    case "tasks.cancel": {
      const parsed = TasksScopedParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      requireHost(c.peer);
      const ticket = await store.getTicket(parsed.data.taskId);
      if (
        !ticket?.task ||
        ticket.task.parentConversationId !== parsed.data.parentConversationId
      )
        notFound("task");
      /* Terminal already — a delivered result stays delivered; cancel is
         only meaningful while the child still runs. */
      if (ticket.task.cancelledAt || ticket.task.lastResult) {
        c.respond(c.peer, c.id, { task: toTask(ticket) });
        return;
      }
      const changed = await store.updateTicket(ticket.id, {
        /* A cancelled task never wakes — `postTaskWake` drops its events
           on this stamp (D-#844). The ticket ends failed: the work did
           not finish. */
        task: { ...ticket.task, cancelledAt: c.now() },
        status: "failed",
      });
      for (const t of changed ?? [])
        broadcast("ticket.upserted", { ticket: t });
      /* Stop the child's turn the same way tickets.assign stops a prior
         hand — the channel watermark keeps a racing send from re-arming
         it (D-#403). */
      const child = await store.getConversation(
        ticket.task.childConversationId,
      );
      if (child) {
        const channel = await store.getChannel(child.channelId);
        c.emit(child.channelId, "turn.interruptRequested", {
          channelId: child.channelId,
          conversationId: child.id,
          afterSeq: channel?.lastSeq ?? 0,
        });
      }
      const agent = ticket.ownerId
        ? await store.getEmployee(ticket.ownerId)
        : null;
      c.respond(c.peer, c.id, {
        task: toTask(changed?.[0] ?? ticket, agent?.name ?? undefined),
      });
      return;
    }
    case "tasks.wake": {
      const parsed = TasksWakeParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      requireHost(c.peer);
      /* `postTaskWake`'s text callback runs inside the transaction — the
         title/agent lookup it needs is preloaded here. */
      const meta = new Map<string, { title?: string; agentName?: string }>();
      for (const event of parsed.data.events) {
        const ticket = await store.getTicket(event.taskId);
        if (!ticket) continue;
        const agent = ticket.ownerId
          ? await store.getEmployee(ticket.ownerId)
          : null;
        meta.set(event.taskId, {
          title: ticket.title,
          ...(agent ? { agentName: agent.name } : {}),
        });
      }
      const result = await store.postTaskWake(parsed.data.events, (batch) =>
        formatTaskWake(batch, (id) => meta.get(id)),
      );
      for (const message of result.messages) {
        c.emitMessage(message.channelId, message);
      }
      for (const ticket of result.tickets) {
        broadcast("ticket.upserted", { ticket });
      }
      c.respond(c.peer, c.id, { delivered: result.delivered });
      return;
    }
    case "tasks.children": {
      const parsed = TasksChildrenParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      requireHost(c.peer);
      const conversations = await store.childConversations(
        parsed.data.parentConversationId,
      );
      const tickets: Ticket[] = [];
      for (const conversation of conversations) {
        if (!conversation.ticketId) continue;
        const ticket = await store.getTicket(conversation.ticketId);
        if (ticket?.task) tickets.push(ticket);
      }
      c.respond(c.peer, c.id, { conversations, tickets });
      return;
    }
    default:
      return false;
  }
}

/** The agent-facing view (D-#844): status derives from the fence fields —
    a result posted means the outcome, `cancelledAt` trumps, else running. */
function toTask(ticket: Ticket, agentName?: string): Task {
  const task = ticket.task;
  if (!task) throw new Error(`toTask on a non-task ticket ${ticket.id}`);
  const status: TaskStatus = task.cancelledAt
    ? "cancelled"
    : (task.lastResult?.outcome ?? "running");
  return {
    id: ticket.id,
    title: ticket.title,
    status,
    agentId: ticket.ownerId ?? "",
    ...(agentName ? { agentName } : {}),
    threadId: task.childConversationId,
    channelId: task.childChannelId,
    parentThreadId: task.parentConversationId,
    ...(task.worktree ? { worktree: task.worktree } : {}),
    ...(task.lastResult
      ? {
          result: task.lastResult.text,
          resultOutcome: task.lastResult.outcome,
          finishedAt: task.lastResult.at,
        }
      : {}),
    createdAt: ticket.createdAt,
    ...(task.cancelledAt ? { cancelledAt: task.cancelledAt } : {}),
  };
}

/** A task id another thread created is not_found — the parent-scope rule
    (D-#844): the caller only ever sees its own children. */
async function scopedTask(
  c: RelayCtx,
  p: {
    taskId: string;
    parentConversationId: string;
  },
): Promise<Task> {
  const ticket = await c.store.getTicket(p.taskId);
  if (
    !ticket?.task ||
    ticket.task.parentConversationId !== p.parentConversationId
  ) {
    notFound("task");
  }
  const agent = ticket.ownerId
    ? await c.store.getEmployee(ticket.ownerId)
    : null;
  return toTask(ticket, agent?.name ?? undefined);
}

function notFound(what: string): never {
  throw new RpcError(JsonRpcCode.notFound, "not_found", `${what} not found`);
}

/**
 * D-#844 restart catch-up: finishes a `turn.completed` replay cannot
 * re-attribute (the host was down when the child's event landed, or the
 * replay window lost it). A ticket owes a wake when the child's
 * `finishedSeq` passed the stamp `lastResult.finishedSeq` recorded — the
 * same fence `postTaskWake` applies. The turn id is unrecoverable here,
 * so the event's key is the seq it covers — a later replayed
 * `turn.completed` for that finish is dropped by the finishedSeq fence,
 * not by turnId.
 */
export async function taskWakesPending(c: RelayCtx): Promise<TaskWakeEvent[]> {
  const owed: TaskWakeEvent[] = [];
  for (const ticket of await c.store.listTickets()) {
    const task = ticket.task;
    if (!task || task.cancelledAt) continue;
    const child = await c.store.getConversation(task.childConversationId);
    if (!child || child.finishedSeq <= (task.lastResult?.finishedSeq ?? 0))
      continue;
    const { messages } = await c.store.listMessages(child.channelId, {
      conversationId: child.id,
    });
    const answer = [...messages]
      .reverse()
      .find((m) => m.authorKind === "employee");
    owed.push({
      taskId: ticket.id,
      turnId: `seq:${child.id}:${child.finishedSeq}`,
      outcome: child.turnFailure
        ? "failed"
        : child.turnStopped
          ? "stopped"
          : "finished",
      ...(answer || child.turnFailure
        ? { result: answer?.text ?? child.turnFailure?.text ?? "" }
        : {}),
    });
  }
  return owed;
}
