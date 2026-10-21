import type { Conversation, Ticket } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import {
  errorData,
  helloed,
  lastId,
  newRelay,
  req,
  resultOf,
  setupChannel,
} from "./helpers";

/**
 * D-#776: the relay owns goals and tickets. Assign is one step that sets
 * the owner and opens their thread. A ticket waiting on one that finishes
 * moves, in the relay, with an update.
 */

const HOME = "/Users/ada";

interface Peer {
  frames: unknown[];
  connection: { receive(data: string): Promise<void> };
}

async function call<T>(peer: Peer, method: string, params = {}): Promise<T> {
  await peer.connection.receive(req(method, params));
  return resultOf(peer.frames, lastId()).result as T;
}

async function setup() {
  const relay = newRelay({ homeDir: HOME });
  const user = await helloed(relay);
  const { employee, channel } = await setupChannel(
    user.frames,
    user.connection,
  );
  const { project } = await call<{ project: { id: string; key: string } }>(
    user,
    "projects.create",
    { folder: `${HOME}/Code/LilOS`, name: "LilOS" },
  );
  return { user, employee, channel, project };
}

describe("tickets", () => {
  it("numbers a ticket from the project key and groups a you-wait as needs", async () => {
    const { user, project } = await setup();
    const { ticket } = await call<{ ticket: Ticket }>(user, "tickets.create", {
      project: project.key,
      title: "Ship the page",
      waitingOn: { kind: "you" },
    });
    expect(ticket.id).toBe(`${project.key}-1`);
    expect(ticket.status).toBe("needs");
    expect(ticket.ownerId).toBeUndefined();
    const { ticket: second } = await call<{ ticket: Ticket }>(
      user,
      "tickets.create",
      { project: project.id, title: "Next" },
    );
    expect(second.id).toBe(`${project.key}-2`);
    expect(second.status).toBe("planned");
  });

  it("assign opens the owner's thread; reassign adds the next hand", async () => {
    const { user, employee, project } = await setup();
    const { ticket } = await call<{ ticket: Ticket }>(user, "tickets.create", {
      project: project.key,
      title: "Build it",
    });
    const first = await call<{
      ticket: Ticket;
      conversation: Conversation;
    }>(user, "tickets.assign", { id: ticket.id, ownerId: employee.id });
    expect(first.ticket.ownerId).toBe(employee.id);
    expect(first.ticket.status).toBe("working");
    expect(first.conversation.ticketId).toBe(ticket.id);
    expect(first.conversation.projectId).toBe(project.id);
    expect(first.conversation.title).toBe("Build it");

    const { employee: blair } = await call<{ employee: { id: string } }>(
      user,
      "employees.create",
      { name: "Blair", role: "Notes" },
    );
    const second = await call<{
      ticket: Ticket;
      conversation: Conversation;
    }>(user, "tickets.assign", { id: ticket.id, ownerId: blair.id });
    expect(second.ticket.ownerId).toBe(blair.id);
    expect(second.conversation.id).not.toBe(first.conversation.id);
    expect(second.conversation.ticketId).toBe(ticket.id);

    const { conversations } = await call<{ conversations: Conversation[] }>(
      user,
      "conversations.list",
      { includeArchived: true },
    );
    const hands = conversations.filter((c) => c.ticketId === ticket.id);
    expect(hands).toHaveLength(2);
  });

  it("finishing a ticket moves the one waiting on it", async () => {
    const { user, employee, project } = await setup();
    const { ticket: blocker } = await call<{ ticket: Ticket }>(
      user,
      "tickets.create",
      { project: project.key, title: "Blocker", ownerId: employee.id },
    );
    const { ticket: waiter } = await call<{ ticket: Ticket }>(
      user,
      "tickets.create",
      {
        project: project.key,
        title: "After",
        ownerId: employee.id,
        waitingOn: { kind: "ticket", ticketId: blocker.id },
      },
    );
    expect(waiter.status).toBe("waiting");
    const { tickets } = await call<{ tickets: Ticket[] }>(
      user,
      "tickets.update",
      { id: blocker.id, status: "done" },
    );
    const done = tickets.find((t) => t.id === blocker.id);
    const moved = tickets.find((t) => t.id === waiter.id);
    expect(done?.status).toBe("done");
    expect(done?.waitingOn).toBeUndefined();
    expect(moved?.status).toBe("working");
    expect(moved?.waitingOn).toBeUndefined();
    expect(moved?.updates.at(-1)).toEqual({
      id: expect.any(String),
      authorKind: "system",
      at: expect.any(Number),
      text: `${blocker.id} is done, so this can move.`,
    });
    expect(moved?.updates.at(-1)?.by).toBeUndefined();
  });

  it("a comment from a person is stamped you", async () => {
    const { user, project } = await setup();
    const { ticket } = await call<{ ticket: Ticket }>(user, "tickets.create", {
      project: project.key,
      title: "Note",
    });
    const updated = await call<{ ticket: Ticket }>(user, "tickets.comment", {
      id: ticket.id,
      text: "Looked at it",
      by: "emp_nope",
    });
    expect(updated.ticket.updates).toEqual([
      expect.objectContaining({
        authorKind: "user",
        by: "you",
        text: "Looked at it",
      }),
    ]);
  });

  it("stores waiting on the CEO as the role and derives waiting", async () => {
    const { user, project } = await setup();
    const { ticket } = await call<{ ticket: Ticket }>(user, "tickets.create", {
      project: project.key,
      title: "Sign-off",
      waitingOn: { kind: "ceo" },
    });
    expect(ticket.waitingOn).toEqual({ kind: "ceo" });
    expect(ticket.status).toBe("waiting");
    const aliased = await call<{ ticket: Ticket }>(user, "tickets.create", {
      project: project.key,
      title: "Also the seat",
      waitingOn: { kind: "agent", agentId: "ceo" },
    });
    expect(aliased.ticket.waitingOn).toEqual({ kind: "ceo" });
    expect(aliased.ticket.ownerId).toBeUndefined();
  });

  it("rejects a wait on itself, a cycle, or a ticket that is done", async () => {
    const { user, project } = await setup();
    const { ticket: a } = await call<{ ticket: Ticket }>(
      user,
      "tickets.create",
      { project: project.key, title: "A" },
    );
    const { ticket: b } = await call<{ ticket: Ticket }>(
      user,
      "tickets.create",
      {
        project: project.key,
        title: "B",
        waitingOn: { kind: "ticket", ticketId: a.id },
      },
    );
    await user.connection.receive(
      req("tickets.update", {
        id: a.id,
        waitingOn: { kind: "ticket", ticketId: a.id },
      }),
    );
    expect(errorData(user.frames, lastId())).toBe("invalid_params");
    await user.connection.receive(
      req("tickets.update", {
        id: a.id,
        waitingOn: { kind: "ticket", ticketId: b.id },
      }),
    );
    expect(errorData(user.frames, lastId())).toBe("invalid_params");
    const { ticket: done } = await call<{ ticket: Ticket }>(
      user,
      "tickets.create",
      { project: project.key, title: "Finished", status: "done" },
    );
    await user.connection.receive(
      req("tickets.create", {
        project: project.key,
        title: "Too late",
        waitingOn: { kind: "ticket", ticketId: done.id },
      }),
    );
    expect(errorData(user.frames, lastId())).toBe("invalid_params");
  });

  it("rejects an unknown goal and a goal from another project", async () => {
    const { user, project } = await setup();
    await user.connection.receive(
      req("tickets.create", {
        project: project.key,
        title: "Missing goal",
        goalId: "goal-nope",
      }),
    );
    expect(errorData(user.frames, lastId())).toBe("not_found");
    const { project: other } = await call<{ project: { id: string } }>(
      user,
      "projects.create",
      { folder: `${HOME}/Code/Other`, name: "Other" },
    );
    const { goal } = await call<{ goal: { id: string } }>(
      user,
      "goals.create",
      {
        project: other.id,
        title: "Elsewhere",
      },
    );
    await user.connection.receive(
      req("tickets.create", {
        project: project.key,
        title: "Wrong project",
        goalId: goal.id,
      }),
    );
    expect(errorData(user.frames, lastId())).toBe("invalid_params");
  });

  it("keeps status and waitingOn together, and assign uses the default access", async () => {
    const { user, employee, project } = await setup();
    const { ticket } = await call<{ ticket: Ticket }>(user, "tickets.create", {
      project: project.key,
      title: "Align",
      waitingOn: { kind: "you" },
    });
    expect(ticket.status).toBe("needs");
    const working = await call<{ tickets: Ticket[] }>(user, "tickets.update", {
      id: ticket.id,
      status: "working",
    });
    expect(working.tickets[0]?.status).toBe("working");
    expect(working.tickets[0]?.waitingOn).toBeUndefined();
    const { ticket: owned } = await call<{ ticket: Ticket }>(
      user,
      "tickets.create",
      {
        project: project.key,
        title: "Held",
        ownerId: employee.id,
        waitingOn: { kind: "you" },
      },
    );
    const cleared = await call<{ tickets: Ticket[] }>(user, "tickets.update", {
      id: owned.id,
      waitingOn: null,
    });
    expect(cleared.tickets[0]?.status).toBe("working");
    expect(cleared.tickets[0]?.waitingOn).toBeUndefined();

    await call(user, "settings.set", { key: "defaultAccess", value: "full" });
    const opened = await call<{ conversation: Conversation }>(
      user,
      "tickets.assign",
      { id: ticket.id, ownerId: employee.id },
    );
    expect(opened.conversation.access).toBe("full");
    await user.connection.receive(
      req("tickets.assign", { id: "no-such-ticket", ownerId: employee.id }),
    );
    expect(errorData(user.frames, lastId())).toBe("not_found");
  });
});
