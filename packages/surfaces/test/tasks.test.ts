import { describe, expect, it } from "vitest";
import { callTool, SessionSurfaces } from "../src/index.js";
import { FakePtySpawner, fakeAppOps, serveGateway } from "./fakes.js";

/**
 * D-#844: the `task_*` tools — create hands a job to another employee as a
 * child thread (no approval); read/wait/cancel reach only this session's
 * own tasks; `thread`'s `thread` param resolves a child by task id,
 * thread id or title for read/follow-up and nothing else.
 */

function makeScope(session: string, appOps: ReturnType<typeof fakeAppOps>) {
  return new SessionSurfaces({
    session,
    cwd: "/tmp",
    spawnPty: new FakePtySpawner(true).spawn,
    appOps,
    binding: {
      employeeId: "emp-caller",
      channelId: "chan-caller",
      conversationId: "conv1",
    },
  });
}

const call = (scope: SessionSurfaces, name: string, args: unknown) =>
  callTool(scope, name, args);

describe("task_* tools (D-#844)", () => {
  it("task_create hands off without an approval card", async () => {
    const ops = fakeAppOps();
    const scope = makeScope("s-task", ops);
    const created = (await call(scope, "task_create", {
      agent: "Ada",
      prompt: "Audit the auth module",
      requestId: "req-1",
    })) as { task: Record<string, unknown> };
    expect(created.task.id).toBe("TASK-1");
    expect(created.task.status).toBe("running");
    expect(created.task.parentThreadId).toBe("conv1");
    expect(ops.asks).toEqual([]); // no approval (D-#844)

    // Idempotent: a retried requestId returns the stored task.
    const again = (await call(scope, "task_create", {
      agent: "Ada",
      prompt: "Audit the auth module",
      requestId: "req-1",
    })) as { task: Record<string, unknown> };
    expect(again.task.id).toBe("TASK-1");
    expect(again.task.threadId).toBe(created.task.threadId);
  });

  it("task_read / task_cancel are scoped to this session's tasks", async () => {
    const ops = fakeAppOps();
    const scope = makeScope("s-own", ops);
    await call(scope, "task_create", { agent: "Ada", prompt: "Job" });
    const read = (await call(scope, "task_read", {
      taskId: "TASK-1",
    })) as { task: Record<string, unknown> };
    expect(read.task.status).toBe("running");
    const cancelled = (await call(scope, "task_cancel", {
      taskId: "TASK-1",
    })) as { task: Record<string, unknown> };
    expect(cancelled.task.status).toBe("cancelled");
    await expect(call(scope, "task_read", { taskId: "nope" })).rejects.toThrow(
      /not_found|unknown task/,
    );
  });

  it("task_wait reports a timeout without cancelling the child", async () => {
    const ops = fakeAppOps();
    const scope = makeScope("s-wait", ops);
    await call(scope, "task_create", { agent: "Ada", prompt: "Long" });
    const waited = (await call(scope, "task_wait", {
      taskId: "TASK-1",
      timeoutMs: 30,
    })) as { task: Record<string, unknown>; timedOut: boolean };
    expect(waited.timedOut).toBe(true);
    expect(waited.task.status).toBe("running");
    // Still running — a timeout never cancels (D-#844).
    const read = (await call(scope, "task_read", {
      taskId: "TASK-1",
    })) as { task: Record<string, unknown> };
    expect(read.task.status).toBe("running");
  });
});

describe("thread follow-ups on children (D-#844)", () => {
  it("thread_read and thread_post reach a child by task id, thread id or title", async () => {
    const ops = fakeAppOps();
    const scope = makeScope("s-fu", ops);
    const created = (await call(scope, "task_create", {
      agent: "Ada",
      prompt: "Write the report",
      title: "Report run",
    })) as { task: Record<string, unknown> };
    const threadId = created.task.threadId as string;

    // Follow-up posts land on the child thread itself.
    await call(scope, "thread_post", {
      text: "add a risk section",
      thread: "TASK-1",
    });
    const read = (await call(scope, "thread_read", {
      thread: threadId,
    })) as { messages: { text: string; conversationId: string }[] };
    expect(
      read.messages.filter((m) => m.conversationId === threadId),
    ).toHaveLength(1);
    expect(read.messages[0]?.text).toBe("add a risk section");

    // By title too.
    const byTitle = (await call(scope, "thread_read", {
      thread: "Report run",
    })) as { messages: unknown[] };
    expect(byTitle.messages).toHaveLength(1);
  });

  it("a thread ref that is no child of this session is out of scope", async () => {
    const ops = fakeAppOps();
    const scope = makeScope("s-scope", ops);
    await call(scope, "task_create", { agent: "Ada", prompt: "Job" });
    await expect(
      call(scope, "thread_post", { text: "hi", thread: "conv-other" }),
    ).rejects.toThrow(/no child thread|out of scope|not_found/);
    await expect(
      call(scope, "thread_read", { thread: "TASK-99" }),
    ).rejects.toThrow(/not_found|no thread/);
  });
});

describe("gateway advertises the task area (D-#844)", () => {
  it("tools/list shows task_* when the app leg is bound", async () => {
    const { scope } = (() => {
      const s = makeScope("s-cat", fakeAppOps());
      return { scope: s };
    })();
    const api = await serveGateway({
      sessions: [{ scope, token: "tok-t" }],
    });
    try {
      const res = await fetch(`${api.baseUrl}/tools`, {
        headers: { authorization: "Bearer tok-t" },
      });
      const body = (await res.json()) as { tools: { name: string }[] };
      const names = body.tools.map((t) => t.name);
      for (const tool of [
        "task_create",
        "task_read",
        "task_wait",
        "task_cancel",
      ]) {
        expect(names).toContain(tool);
      }
    } finally {
      api.server.close();
    }
  });
});
