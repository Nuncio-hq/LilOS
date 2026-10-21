import type { Goal, Project, TicketWaitingOn } from "@lilos/contracts/app";
import {
  GoalsCreateParams,
  GoalsListParams,
  TicketsAssignParams,
  TicketsCommentParams,
  TicketsCreateParams,
  TicketsListParams,
  TicketsReadParams,
  TicketsUpdateParams,
} from "@lilos/contracts/app";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/**
 * Goals and tickets (D-#776). The relay owns the records. Assign is one
 * transaction in the store: set the owner and open their thread. "ceo" is
 * not a position here — until one is named, it means the earliest employee,
 * which is the default agent on a fresh company.
 */
export async function handleTickets(c: RelayCtx): Promise<false | undefined> {
  const { method, params, store, broadcast } = c;
  switch (method) {
    case "goals.list": {
      const parsed = GoalsListParams.safeParse(params ?? {});
      if (!parsed.success) throw badParams(parsed.error.issues);
      c.respond(c.peer, c.id, { goals: await store.listGoals() });
      return;
    }
    case "goals.create": {
      const parsed = GoalsCreateParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const project = await projectBy(store, parsed.data.project);
      const goal = await store.createGoal({
        projectId: project.id,
        title: parsed.data.title,
        due: parsed.data.due,
        why: parsed.data.why,
        ownerId: parsed.data.ownerId
          ? await personId(store, parsed.data.ownerId)
          : undefined,
      });
      broadcast("goal.upserted", { goal });
      c.respond(c.peer, c.id, { goal });
      return;
    }
    case "tickets.list": {
      const parsed = TicketsListParams.safeParse(params ?? {});
      if (!parsed.success) throw badParams(parsed.error.issues);
      const project = parsed.data.project
        ? await projectBy(store, parsed.data.project)
        : undefined;
      c.respond(c.peer, c.id, {
        tickets: await store.listTickets(project?.id),
      });
      return;
    }
    case "tickets.read": {
      const parsed = TicketsReadParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const ticket = await store.getTicket(parsed.data.id);
      if (!ticket) notFound("ticket");
      c.respond(c.peer, c.id, { ticket });
      return;
    }
    case "tickets.create": {
      const parsed = TicketsCreateParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const project = await projectBy(store, parsed.data.project);
      if (parsed.data.goalId) await goalBy(store, parsed.data.goalId);
      const waitingOn = parsed.data.waitingOn
        ? await resolveWaiting(store, parsed.data.waitingOn)
        : undefined;
      const ticket = await store.createTicket({
        projectId: project.id,
        projectKey: project.key,
        title: parsed.data.title,
        goalId: parsed.data.goalId,
        ownerId: parsed.data.ownerId
          ? await personId(store, parsed.data.ownerId)
          : undefined,
        status: parsed.data.status,
        waitingOn,
        progress: parsed.data.progress,
        startsAt: parsed.data.startsAt,
        stuckWhy: parsed.data.stuckWhy,
      });
      broadcast("ticket.upserted", { ticket });
      c.respond(c.peer, c.id, { ticket });
      return;
    }
    case "tickets.update": {
      const parsed = TicketsUpdateParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const { id, waitingOn, ...rest } = parsed.data;
      const changed = await store.updateTicket(id, {
        ...rest,
        ...(waitingOn !== undefined
          ? {
              waitingOn: waitingOn
                ? await resolveWaiting(store, waitingOn)
                : null,
            }
          : {}),
      });
      if (!changed) notFound("ticket");
      for (const ticket of changed) broadcast("ticket.upserted", { ticket });
      c.respond(c.peer, c.id, { tickets: changed });
      return;
    }
    case "tickets.assign": {
      const parsed = TicketsAssignParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const ownerId = await personId(store, parsed.data.ownerId);
      const { channel, created } = await store.openDmChannel(ownerId);
      const opened = await store.assignTicket({
        id: parsed.data.id,
        ownerId,
        channelId: channel.id,
      });
      if (!opened) notFound("ticket");
      /* A new owner's channel is not in an already-open client. Announce
         it before the thread event so the client subscribes and the hand
         shows up; an existing channel is already subscribed. */
      if (created) broadcast("channel.created", { channel });
      broadcast("ticket.upserted", { ticket: opened.ticket });
      c.emitMessage(opened.conversation.channelId, opened.rootMessage);
      c.emitConversation(opened.conversation.channelId, opened.conversation);
      c.respond(c.peer, c.id, opened);
      return;
    }
    case "tickets.comment": {
      const parsed = TicketsCommentParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      /* A person writes as "you". The harness is the host and names the
         employee the tool is bound to — never a model-supplied id from a
         user client. */
      const by = c.isHost(c.peer) ? parsed.data.by : "you";
      if (!by) {
        throw new RpcError(
          JsonRpcCode.invalidParams,
          "invalid_params",
          "by is required from the host",
        );
      }
      const ticket = await store.commentTicket(parsed.data.id, {
        by,
        text: parsed.data.text,
      });
      if (!ticket) notFound("ticket");
      broadcast("ticket.upserted", { ticket });
      c.respond(c.peer, c.id, { ticket });
      return;
    }
    default:
      return false;
  }
}

function notFound(what: string): never {
  throw new RpcError(JsonRpcCode.notFound, "not_found", `${what} not found`);
}

async function projectBy(
  store: RelayCtx["store"],
  ref: string,
): Promise<Project> {
  const hit = (await store.listProjects()).find(
    (p) => p.id === ref || p.key === ref,
  );
  if (!hit) notFound("project");
  return hit;
}

async function goalBy(store: RelayCtx["store"], id: string): Promise<Goal> {
  const hit = (await store.listGoals()).find((g) => g.id === id);
  if (!hit) notFound("goal");
  return hit;
}

/** "ceo" is whoever was hired first. A real id must be an employee. */
async function personId(store: RelayCtx["store"], id: string): Promise<string> {
  const employees = await store.listEmployees();
  if (id === "ceo") {
    const first = [...employees].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!first) {
      throw new RpcError(
        JsonRpcCode.notFound,
        "not_found",
        "no employee stands in yet",
      );
    }
    return first.id;
  }
  if (!employees.some((e) => e.id === id)) notFound("employee");
  return id;
}

async function resolveWaiting(
  store: RelayCtx["store"],
  waiting: TicketWaitingOn,
): Promise<TicketWaitingOn> {
  if (waiting.kind === "agent") {
    return { ...waiting, agentId: await personId(store, waiting.agentId) };
  }
  if (waiting.kind === "ticket" && !(await store.getTicket(waiting.ticketId))) {
    notFound("ticket");
  }
  return waiting;
}
