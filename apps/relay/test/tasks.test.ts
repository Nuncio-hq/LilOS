/**
 * D-#844: agent hand-offs. `tasks.create` opens the child as an ordinary
 * thread carrying `parentId` lineage and the parent's own access; the
 * prompt is the child's whole input. `tasks.wake` posts ONE coalesced
 * `taskWake` message per parent and stamps the ticket's fences in the
 * same write — replayed turn ids and cancelled tasks drop out. Read,
 * cancel and the `thread_*` follow-up scope reach only children the
 * calling thread created. `harness.register`'s `taskWakes` is the
 * restart catch-up.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  errorData,
  eventsNamed,
  helloed,
  lastId,
  newWorld,
  req,
  resultOf,
} from "./helpers";

const home = () => mkdtempSync(join(tmpdir(), "lilos-tasks-"));

type AnyResult = Record<string, any>;

/** Registered host + two employees: the caller's own thread (with a cwd
    so it files under a project) and the agent the task hands off to. */
async function worldWithParent(storeHome: string) {
  const { store, relay } = newWorld(storeHome);
  const host = await helloed(relay);
  await host.connection.receive(
    req("harness.register", { protocolVersion: 1, version: "0.0.0-test" }),
  );
  host.frames.length = 0;

  const mkEmployee = async (name: string) => {
    await host.connection.receive(
      req("employees.create", { name, role: "eng" }),
    );
    const { employee } = resultOf(host.frames, lastId()).result as AnyResult;
    return employee as { id: string; name: string };
  };
  const caller = await mkEmployee("Ada");
  const worker = await mkEmployee("Bea");

  await host.connection.receive(
    req("channels.openDm", { employeeId: caller.id }),
  );
  const { channel: callerChannel } = resultOf(host.frames, lastId())
    .result as AnyResult;
  await host.connection.receive(
    req("conversations.open", {
      channelId: callerChannel.id,
      text: "Plan the release",
      cwd: join(storeHome, "work"),
      access: "ask",
    }),
  );
  const { conversation: parent } = resultOf(host.frames, lastId())
    .result as AnyResult;
  host.frames.length = 0;
  return { store, relay, host, caller, worker, parent, callerChannel };
}

const createTask = async (
  host: {
    connection: { receive(d: string): Promise<void> };
    frames: unknown[];
  },
  params: Record<string, unknown>,
) => {
  await host.connection.receive(req("tasks.create", params));
  return resultOf(host.frames, lastId()).result as AnyResult;
};

describe("tasks.create (D-#844)", () => {
  it("opens a child thread with the prompt only, parent lineage, and the parent's access", async () => {
    const dir = home();
    const { host, worker, parent, callerChannel } = await worldWithParent(dir);

    const r = await createTask(host, {
      parentConversationId: parent.id,
      employeeId: worker.id,
      prompt: "Draft the changelog for v2",
      title: "Changelog draft",
    });
    expect(r.task.id).toMatch(/^.+-\d+$/);
    expect(r.task.status).toBe("running");
    expect(r.task.threadId).toBe(r.conversation.id);
    expect(r.task.parentThreadId).toBe(parent.id);
    expect(r.task.agentName).toBe("Bea");

    // The child is an ordinary thread: same project, parent lineage, the
    // parent's own access — never broader (D-#106).
    expect(r.conversation.parentId).toBe(parent.id);
    expect(r.conversation.projectId).toBe(parent.projectId);
    expect(r.conversation.access).toBe("ask");
    expect(r.conversation.cwd).toBe(join(dir, "work"));
    // Its channel is the worker's DM — not the parent's.
    expect(r.conversation.channelId).not.toBe(callerChannel.id);
    expect(r.ticket.task.childConversationId).toBe(r.conversation.id);
    expect(r.ticket.task.parentConversationId).toBe(parent.id);
    expect(r.ticket.ownerId).toBe(worker.id);
    expect(r.ticket.status).toBe("working");

    // The root message is the prompt and nothing else — no parent
    // transcript is copied (D-#844).
    expect(r.rootMessage.conversationId).toBe(r.conversation.id);
    expect(r.rootMessage.text).toBe("Draft the changelog for v2");
    expect(r.rootMessage.authorKind).toBe("user");

    // The child's thread/message emits are channel-scoped — subscribers
    // of the worker's DM see them. The ticket announce is a broadcast.
    expect(eventsNamed(host.frames, "ticket.upserted")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          ticket: expect.objectContaining({ id: r.ticket.id }),
        }),
      }),
    ]);
  });

  it("rejects a non-host caller", async () => {
    const dir = home();
    const { relay, worker, parent } = await worldWithParent(dir);
    const user = await helloed(relay);
    await user.connection.receive(
      req("tasks.create", {
        parentConversationId: parent.id,
        employeeId: worker.id,
        prompt: "nope",
      }),
    );
    expect(errorData(user.frames, lastId())).toBe("forbidden");
  });

  it("answers a repeated requestId with the same task — no second child", async () => {
    const dir = home();
    const { host, worker, parent } = await worldWithParent(dir);
    const params = {
      parentConversationId: parent.id,
      employeeId: worker.id,
      prompt: "Summarize open PRs",
      requestId: "req-7",
    };
    const first = await createTask(host, params);
    host.frames.length = 0;
    const second = await createTask(host, params);
    expect(second.task.id).toBe(first.task.id);
    expect(second.conversation.id).toBe(first.conversation.id);
    expect(second.rootMessage.id).toBe(first.rootMessage.id);
    // No re-announcement: a hit replays the stored answer only.
    expect(eventsNamed(host.frames, "ticket.upserted")).toEqual([]);
  });

  it("refuses a folder-less parent — a chat carries no project to file under", async () => {
    const dir = home();
    const { host, worker, callerChannel } = await worldWithParent(dir);
    // A thread opened with no cwd has no folder and no project (D-#771).
    await host.connection.receive(
      req("conversations.open", {
        channelId: callerChannel.id,
        text: "Just chatting",
      }),
    );
    const { conversation: plain } = resultOf(host.frames, lastId())
      .result as AnyResult;
    expect(plain.projectId).toBeUndefined();

    await host.connection.receive(
      req("tasks.create", {
        parentConversationId: plain.id,
        employeeId: worker.id,
        prompt: "anywhere",
      }),
    );
    expect(errorData(host.frames, lastId())).toBe("invalid_params");
  });
});

describe("tasks.read / tasks.children scoping (D-#844)", () => {
  it("reads its own task and hides another thread's task", async () => {
    const dir = home();
    const { host, worker, parent, caller, callerChannel } =
      await worldWithParent(dir);
    const created = await createTask(host, {
      parentConversationId: parent.id,
      employeeId: worker.id,
      prompt: "Triage the backlog",
    });

    await host.connection.receive(
      req("tasks.read", {
        taskId: created.task.id,
        parentConversationId: parent.id,
      }),
    );
    const read = resultOf(host.frames, lastId()).result as AnyResult;
    expect(read.task.id).toBe(created.task.id);
    expect(read.task.status).toBe("running");

    // A second thread on the same employee is not the parent.
    await host.connection.receive(
      req("conversations.open", {
        channelId: callerChannel.id,
        text: "Unrelated thread",
        cwd: join(dir, "work"),
      }),
    );
    const { conversation: other } = resultOf(host.frames, lastId())
      .result as AnyResult;
    await host.connection.receive(
      req("tasks.read", {
        taskId: created.task.id,
        parentConversationId: other.id,
      }),
    );
    expect(errorData(host.frames, lastId())).toBe("not_found");

    // tasks.children lists only this thread's children.
    await host.connection.receive(
      req("tasks.children", { parentConversationId: parent.id }),
    );
    const kids = resultOf(host.frames, lastId()).result as AnyResult;
    expect(kids.conversations.map((c: AnyResult) => c.id)).toEqual([
      created.conversation.id,
    ]);
    expect(kids.tickets.map((t: AnyResult) => t.id)).toEqual([
      created.ticket.id,
    ]);

    await host.connection.receive(
      req("tasks.children", { parentConversationId: other.id }),
    );
    const none = resultOf(host.frames, lastId()).result as AnyResult;
    expect(none.conversations).toEqual([]);
    expect(none.tickets).toEqual([]);
    void caller;
  });
});

describe("tasks.wake (D-#844)", () => {
  it("posts one coalesced taskWake on the parent and stamps each ticket", async () => {
    const dir = home();
    const { store, host, worker, parent, callerChannel } =
      await worldWithParent(dir);
    const a = await createTask(host, {
      parentConversationId: parent.id,
      employeeId: worker.id,
      prompt: "Job A",
    });
    const b = await createTask(host, {
      parentConversationId: parent.id,
      employeeId: worker.id,
      prompt: "Job B",
    });
    /* The wake message lands on the parent's channel — subscribe so the
       host sees channel-scoped emits like the app's client does. */
    await host.connection.receive(
      req("channel.subscribe", { channelId: callerChannel.id }),
    );
    host.frames.length = 0;

    await host.connection.receive(
      req("tasks.wake", {
        events: [
          {
            taskId: a.task.id,
            turnId: "turn-a1",
            outcome: "finished",
            result: "A is done",
          },
          {
            taskId: b.task.id,
            turnId: "turn-b1",
            outcome: "failed",
            result: "B exploded",
          },
        ],
      }),
    );
    const r = resultOf(host.frames, lastId()).result as AnyResult;
    expect(r.delivered.sort()).toEqual([a.task.id, b.task.id].sort());

    // ONE message on the parent thread, carrying both results.
    const posted = eventsNamed(host.frames, "message.created").map(
      (e) => (e as AnyResult).params.message,
    );
    const wakes = posted.filter((m) => m.taskWake === true);
    expect(wakes).toHaveLength(1);
    const wake = wakes[0];
    expect(wake.conversationId).toBe(parent.id);
    expect(wake.channelId).toBe(callerChannel.id);
    expect(wake.authorKind).toBe("system");
    expect(wake.text).toContain(a.task.id);
    expect(wake.text).toContain(b.task.id);
    expect(wake.text).toContain("A is done");
    expect(wake.text).toContain("failed");

    // Fences landed on both tickets; outcomes flip the ticket state.
    const ta = await store.getTicket(a.task.id);
    const tb = await store.getTicket(b.task.id);
    expect(ta?.task?.wakedTurnIds).toContain("turn-a1");
    expect(ta?.task?.lastResult?.outcome).toBe("finished");
    expect(ta?.status).toBe("done");
    expect(tb?.status).toBe("failed");

    // The wake owes the parent a turn like a user send does.
    const pending = await store.listPendingTurns();
    const owed = pending.find((p) => p.conversation.id === parent.id);
    expect(owed?.message.taskWake).toBe(true);

    // A replayed event for the same turn ids delivers nothing.
    await host.connection.receive(
      req("tasks.wake", {
        events: [
          {
            taskId: a.task.id,
            turnId: "turn-a1",
            outcome: "finished",
            result: "A is done",
          },
        ],
      }),
    );
    const again = resultOf(host.frames, lastId()).result as AnyResult;
    expect(again.delivered).toEqual([]);
  });

  it("caps the inlined result at 8 KiB — the ticket keeps the full text", async () => {
    const dir = home();
    const { store, host, worker, parent, callerChannel } =
      await worldWithParent(dir);
    const created = await createTask(host, {
      parentConversationId: parent.id,
      employeeId: worker.id,
      prompt: "Write the long report",
    });
    await host.connection.receive(
      req("channel.subscribe", { channelId: callerChannel.id }),
    );
    host.frames.length = 0;

    const big = "résumé ".repeat(1600) + "END"; // >8 KiB, multi-byte
    await host.connection.receive(
      req("tasks.wake", {
        events: [
          {
            taskId: created.task.id,
            turnId: "turn-big",
            outcome: "finished",
            result: big,
          },
        ],
      }),
    );
    const posted = eventsNamed(host.frames, "message.created").map(
      (e) => (e as AnyResult).params.message,
    );
    const wake = posted.find((m) => m.taskWake === true);
    expect(wake).toBeDefined();
    // The inline copy is capped on a code-point boundary — no replacement
    // char — and tells the agent where the rest lives.
    const inlined = new TextEncoder().encode(wake.text);
    const fullBytes = new TextEncoder().encode(big);
    expect(inlined.length).toBeLessThan(fullBytes.length);
    expect(wake.text).not.toContain("END");
    expect(wake.text).not.toContain("�");
    expect(wake.text).toContain("task_read");

    // tasks.read answers the FULL result — the cap is a wake-line rule.
    await host.connection.receive(
      req("tasks.read", {
        taskId: created.task.id,
        parentConversationId: parent.id,
      }),
    );
    const read = resultOf(host.frames, lastId()).result as AnyResult;
    expect(read.task.result).toBe(big);
    const ticket = await store.getTicket(created.task.id);
    expect(ticket?.task?.lastResult?.text).toBe(big);
  });

  it("drops a wake for a cancelled task", async () => {
    const dir = home();
    const { host, worker, parent } = await worldWithParent(dir);
    const created = await createTask(host, {
      parentConversationId: parent.id,
      employeeId: worker.id,
      prompt: "Long job",
    });
    // Watch the child's channel — the interrupt is a channel event.
    await host.connection.receive(
      req("channel.subscribe", { channelId: created.conversation.channelId }),
    );
    host.frames.length = 0;
    await host.connection.receive(
      req("tasks.cancel", {
        taskId: created.task.id,
        parentConversationId: parent.id,
      }),
    );
    const cancelled = resultOf(host.frames, lastId()).result as AnyResult;
    expect(cancelled.task.status).toBe("cancelled");
    // The child turn is interrupted on its own channel.
    expect(
      eventsNamed(host.frames, "turn.interruptRequested").length,
    ).toBeGreaterThan(0);

    host.frames.length = 0;
    await host.connection.receive(
      req("tasks.wake", {
        events: [
          {
            taskId: created.task.id,
            turnId: "turn-c1",
            outcome: "stopped",
          },
        ],
      }),
    );
    const r = resultOf(host.frames, lastId()).result as AnyResult;
    expect(r.delivered).toEqual([]);
    expect(eventsNamed(host.frames, "message.created")).toEqual([]);
  });
});

describe("tasks.cancel (D-#844)", () => {
  it("is parent-scoped and interrupts the child turn", async () => {
    const dir = home();
    const { store, host, worker, parent, callerChannel } =
      await worldWithParent(dir);
    const created = await createTask(host, {
      parentConversationId: parent.id,
      employeeId: worker.id,
      prompt: "Sweep the yard",
    });

    // Another thread cannot cancel it.
    await host.connection.receive(
      req("conversations.open", {
        channelId: callerChannel.id,
        text: "Elsewhere",
        cwd: join(dir, "work"),
      }),
    );
    const { conversation: other } = resultOf(host.frames, lastId())
      .result as AnyResult;
    await host.connection.receive(
      req("tasks.cancel", {
        taskId: created.task.id,
        parentConversationId: other.id,
      }),
    );
    expect(errorData(host.frames, lastId())).toBe("not_found");

    await host.connection.receive(
      req("tasks.cancel", {
        taskId: created.task.id,
        parentConversationId: parent.id,
      }),
    );
    const r = resultOf(host.frames, lastId()).result as AnyResult;
    expect(r.task.status).toBe("cancelled");
    const ticket = await store.getTicket(created.task.id);
    expect(ticket?.task?.cancelledAt).toBeTypeOf("number");
    expect(ticket?.status).toBe("failed");
  });
});

describe("harness.register taskWakes catch-up (D-#844)", () => {
  it("returns the wake a finished child is still owed", async () => {
    const dir = home();
    const { store, relay, host, worker, parent } = await worldWithParent(dir);
    const created = await createTask(host, {
      parentConversationId: parent.id,
      employeeId: worker.id,
      prompt: "Report back",
    });
    // The child's turn ended while no host was registered: the finish
    // stamp moved without a wake ever posting.
    await store.recordConversationFinish({
      conversationId: created.conversation.id,
      sessionId: "sess-child",
      eventSeq: 9,
    });
    await host.connection.receive(
      req("harness.register", { protocolVersion: 1, version: "0.0.0-test" }),
    );
    const reg = resultOf(host.frames, lastId()).result as AnyResult;
    const owed = (reg.taskWakes ?? []).filter(
      (e: AnyResult) => e.taskId === created.task.id,
    );
    expect(owed).toHaveLength(1);
    expect(owed[0].outcome).toBe("finished");
    expect(owed[0].turnId).toBe(
      `seq:${created.conversation.id}:${(await store.getConversation(created.conversation.id))!.finishedSeq}`,
    );

    // Once the wake posts, a re-register owes nothing.
    await host.connection.receive(req("tasks.wake", { events: owed }));
    await host.connection.receive(
      req("harness.register", { protocolVersion: 1, version: "0.0.0-test" }),
    );
    const reg2 = resultOf(host.frames, lastId()).result as AnyResult;
    expect(
      (reg2.taskWakes ?? []).filter(
        (e: AnyResult) => e.taskId === created.task.id,
      ),
    ).toEqual([]);
    void relay;
  });
});
