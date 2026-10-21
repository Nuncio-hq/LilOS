import type { Conversation, Ticket } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import {
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
    expect(moved?.updates.at(-1)?.text).toBe(
      `${blocker.id} is done, so this can move.`,
    );
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
      expect.objectContaining({ by: "you", text: "Looked at it" }),
    ]);
  });
});
