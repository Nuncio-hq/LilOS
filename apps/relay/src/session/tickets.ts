import {
  type Goal,
  GoalsCreateParams,
  GoalsListParams,
  type Project,
  TicketsAssignParams,
  TicketsCommentParams,
  TicketsCreateParams,
  TicketsListParams,
  TicketsReadParams,
  TicketsUpdateParams,
  type TicketWaitingOn,
} from "@lilos/contracts/app";
import { ConversationAccess } from "@lilos/contracts/engine";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/**
 * Goals and tickets (D-#776). The relay owns the records. Assign checks the
 * ticket, then opens the owner's thread in the same transaction as the
 * owner write, at the company's default access. Waiting on the CEO is the
 * role `{kind: "ceo"}`, never an employee id. "ceo" as an owner is whoever
 * was hired first, until a CEO is named.
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
      if (parsed.data.goalId) {
        await goalOnProject(store, parsed.data.goalId, project.id);
      }
      const waitingOn = parsed.data.waitingOn
        ? await resolveWaiting(store, parsed.data.waitingOn)
        : undefined;
      if (waitingOn?.kind === "ticket") {
        const taken = await store.listTickets(project.id);
        const number = taken.reduce((m, t) => Math.max(m, t.number), 0) + 1;
        await assertWaiting(store, `${project.key}-${number}`, waitingOn);
      }
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
      broadcast("ticket.upserted", {
        ticket,
        ...actorOf(c, parsed.data.actorId),
      });
      c.respond(c.peer, c.id, { ticket });
      return;
    }
    case "tickets.update": {
      const parsed = TicketsUpdateParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const { id, waitingOn, actorId, ...rest } = parsed.data;
      const current = await store.getTicket(id);
      if (!current) notFound("ticket");
      if (rest.goalId)
        await goalOnProject(store, rest.goalId, current.projectId);
      const resolved =
        waitingOn === undefined
          ? undefined
          : waitingOn
            ? await resolveWaiting(store, waitingOn)
            : null;
      const keepsWait =
        rest.status !== "working" &&
        rest.status !== "planned" &&
        rest.status !== "done";
      if (resolved && keepsWait) await assertWaiting(store, id, resolved);
      const changed = await store.updateTicket(id, {
        ...rest,
        ...(resolved !== undefined ? { waitingOn: resolved } : {}),
      });
      if (!changed) notFound("ticket");
      for (const ticket of changed)
        broadcast("ticket.upserted", { ticket, ...actorOf(c, actorId) });
      c.respond(c.peer, c.id, { tickets: changed });
      return;
    }
    case "tickets.assign": {
      const parsed = TicketsAssignParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      /* Missing ticket: stop before the channel exists, so a failed assign
         never leaves a channel nobody was told about. */
      if (!(await store.getTicket(parsed.data.id))) notFound("ticket");
      const ownerId = await personId(store, parsed.data.ownerId);
      const storedDefault = ConversationAccess.safeParse(
        await store.getSetting("defaultAccess"),
      );
      const access = storedDefault.success ? storedDefault.data : "ask";
      const { channel, created } = await store.openDmChannel(ownerId);
      const opened = await store.assignTicket({
        id: parsed.data.id,
        ownerId,
        channelId: channel.id,
        access,
      });
      if (!opened) notFound("ticket");
      /* A new owner's channel is not in an already-open client. Announce
         it before the thread event so the client subscribes and the hand
         shows up; an existing channel is already subscribed. */
      if (created) broadcast("channel.created", { channel });
      broadcast("ticket.upserted", {
        ticket: opened.ticket,
        ...actorOf(c, parsed.data.actorId),
      });
      c.emitMessage(opened.conversation.channelId, opened.rootMessage);
      c.emitConversation(opened.conversation.channelId, opened.conversation);
      /* The previous hand hears it was handed on, and a running or stuck
         thread stops so it leaves Stuck (D-#777). */
      await handOffPrevious(
        c,
        opened.ticket.id,
        opened.conversation.id,
        ownerId,
      );
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

/** Host-only. A user client's `actorId` is ignored so the model cannot
    name someone else (D-#777). */
function actorOf(
  c: RelayCtx,
  actorId: string | undefined,
): { actorId?: string } {
  return c.isHost(c.peer) && actorId ? { actorId } : {};
}

/** "Handed to <agent>" in the previous thread. Stop it when it is still
    running or stuck, and clear the stuck mark so it leaves Stuck. An idle
    thread only gets the note. */
async function handOffPrevious(
  c: RelayCtx,
  ticketId: string,
  openedId: string,
  ownerId: string,
): Promise<void> {
  const hands = await c.store.threadsOnTicket(ticketId);
  const previous = hands.find((thread) => thread.id !== openedId);
  if (!previous) return;
  const employees = await c.store.listEmployees();
  const name = employees.find((e) => e.id === ownerId)?.name ?? "another agent";
  const { message } = await c.store.appendMessage({
    channelId: previous.channelId,
    conversationId: previous.id,
    authorId: "system",
    authorKind: "system",
    text: `Handed to ${name}`,
  });
  c.emitMessage(previous.channelId, message);
  const wasStuck = previous.stuck != null;
  if (wasStuck) {
    const cleared = await c.store.updateConversation(previous.id, {
      stuck: null,
    });
    if (cleared) c.emitConversation(previous.channelId, cleared);
  }
  if (previous.state === "active" || wasStuck) {
    const channel = await c.store.getChannel(previous.channelId);
    c.emit(previous.channelId, "turn.interruptRequested", {
      channelId: previous.channelId,
      conversationId: previous.id,
      afterSeq: channel?.lastSeq ?? 0,
    });
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

async function goalOnProject(
  store: RelayCtx["store"],
  id: string,
  projectId: string,
): Promise<Goal> {
  const hit = (await store.listGoals()).find((g) => g.id === id);
  if (!hit) notFound("goal");
  if (hit.projectId !== projectId) {
    throw new RpcError(
      JsonRpcCode.invalidParams,
      "invalid_params",
      "goal is in another project",
    );
  }
  return hit;
}

/** "ceo" is whoever was hired first. A real id must be an employee.
    Waiting on the CEO does not come through here — that stays a role. */
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
  if (waiting.kind === "ceo") return { kind: "ceo" };
  if (waiting.kind === "agent") {
    /* The string "ceo" is the role, not the earliest employee. Storing an
       id would freeze the wait on that person when the seat changes. */
    if (waiting.agentId === "ceo") return { kind: "ceo" };
    return { ...waiting, agentId: await personId(store, waiting.agentId) };
  }
  return waiting;
}

/** A ticket cannot wait on itself, on a cycle, or on one that is already
    done (D-#776). Same shape as `assertReportsTo`: self and a cycle are
    invalid_params, an unknown ticket is not_found. */
async function assertWaiting(
  store: RelayCtx["store"],
  selfId: string,
  waiting: TicketWaitingOn,
): Promise<void> {
  if (waiting.kind !== "ticket") return;
  if (waiting.ticketId === selfId) {
    throw new RpcError(
      JsonRpcCode.invalidParams,
      "invalid_params",
      "a ticket cannot wait on itself",
    );
  }
  const seen = new Set<string>([selfId]);
  let cur: string | undefined = waiting.ticketId;
  let direct = true;
  while (cur) {
    if (seen.has(cur)) {
      throw new RpcError(
        JsonRpcCode.invalidParams,
        "invalid_params",
        "waitingOn would cycle",
      );
    }
    seen.add(cur);
    const ticket = await store.getTicket(cur);
    if (!ticket) notFound("ticket");
    if (direct && ticket.status === "done") {
      throw new RpcError(
        JsonRpcCode.invalidParams,
        "invalid_params",
        "a ticket cannot wait on one that is done",
      );
    }
    direct = false;
    cur =
      ticket.waitingOn?.kind === "ticket"
        ? ticket.waitingOn.ticketId
        : undefined;
  }
}
