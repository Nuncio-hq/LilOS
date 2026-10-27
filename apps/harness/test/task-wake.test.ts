import type { AppMessage, Conversation } from "@lilos/contracts/app";
import type { EngineEvent } from "@lilos/contracts/engine";
import { TASK_WAKE_COALESCE_MS } from "@lilos/contracts/harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessCtx, SessionBinding } from "../src/harness/ctx";
import { onRelayReady } from "../src/harness/register";
import {
  noteTaskTurn,
  noteTaskWake,
  stopTaskLoop,
} from "../src/harness/task-wake";
import { mkhome, openDmConversation, setupWorld, waitFor } from "./helpers";

/**
 * D-#844: a child task's `turn.completed` notes one wake event; the queue
 * coalesces a burst into ONE `tasks.wake` batch; the relay's durable
 * fences make replays safe. The engine-fake E2E runs the whole loop:
 * create → child thread runs → the parent wakes with the result.
 */

interface Call {
  method: string;
  params: Record<string, unknown>;
}

function fakeCtx(
  convs: Map<string, Conversation>,
  fail?: { n: number },
  request?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>,
) {
  const calls: Call[] = [];
  const ctx = {
    conversationFromAtom: (id: string) => convs.get(id),
    opts: {
      log: { warn: () => {}, info: () => {}, error: () => {} },
      relay: {
        request: async (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params: params ?? {} });
          if (request) return request(method, params ?? {});
          if (fail && fail.n === 0) {
            fail.n = 1;
            throw new Error("relay down");
          }
          return { delivered: [] };
        },
        channels: { get: () => [] },
      },
    },
  } as unknown as HarnessCtx;
  return { ctx, calls };
}

const conv = (id: string, extra: Partial<Conversation> = {}): Conversation =>
  ({
    id,
    channelId: `ch-${id}`,
    state: "idle",
    archived: false,
    ...extra,
  }) as Conversation;

const binding = (conversationId: string): SessionBinding =>
  ({ conversationId }) as SessionBinding;

const completed = (turnId: string, error?: string) =>
  ({
    type: "turn.completed",
    payload: { turnId, stopReason: "end_turn", ...(error ? { error } : {}) },
  }) as Extract<EngineEvent, { type: "turn.completed" }>;

const micro = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const fire = async () => {
  await vi.advanceTimersByTimeAsync(TASK_WAKE_COALESCE_MS);
  await micro();
};

describe("task wake queue (D-#844)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("notes a child finish and posts one coalesced batch", async () => {
    vi.useFakeTimers();
    const convs = new Map<string, Conversation>([
      ["child-a", conv("child-a", { parentId: "p1", ticketId: "T-1" })],
      ["child-b", conv("child-b", { parentId: "p1", ticketId: "T-2" })],
      ["plain", conv("plain")],
    ]);
    const { ctx, calls } = fakeCtx(convs);

    // A plain thread's turn end notes nothing.
    noteTaskTurn(ctx, binding("plain"), completed("t-plain"), "noise");
    await fire();
    expect(calls).toHaveLength(0);

    noteTaskTurn(ctx, binding("child-a"), completed("t-a"), "answer A");
    noteTaskTurn(ctx, binding("child-b"), completed("t-b"), "answer B");
    await fire();
    const wakes = calls.filter((c) => c.method === "tasks.wake");
    expect(wakes).toHaveLength(1);
    const events = wakes[0]!.params.events as {
      taskId: string;
      turnId: string;
      outcome: string;
      result?: string;
    }[];
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.taskId).sort()).toEqual(["T-1", "T-2"]);
    expect(events.find((e) => e.taskId === "T-1")?.result).toBe("answer A");
    expect(events.find((e) => e.taskId === "T-2")?.outcome).toBe("finished");

    /* A replayed turn.completed AFTER the post re-notes and re-posts —
       the queue's (taskId,turnId) dedupe only covers what's still
       pending; the relay's durable `wakedTurnIds` fence is what drops
       it there (proven in the relay spec). */
    noteTaskTurn(ctx, binding("child-a"), completed("t-a"), "answer A");
    await fire();
    const replay = calls.filter((c) => c.method === "tasks.wake");
    expect(replay).toHaveLength(2);
    expect(
      (replay[1]!.params.events as { turnId: string }[]).map((e) => e.turnId),
    ).toEqual(["t-a"]);
  });

  it("reports a failed turn with its error text and outcome failed", async () => {
    vi.useFakeTimers();
    const convs = new Map<string, Conversation>([
      ["child", conv("child", { parentId: "p", ticketId: "T-9" })],
    ]);
    const { ctx, calls } = fakeCtx(convs);
    noteTaskTurn(ctx, binding("child"), completed("t-f", "boom"), "");
    await fire();
    const events = calls[0]!.params.events as {
      outcome: string;
      result?: string;
    }[];
    expect(events[0]?.outcome).toBe("failed");
    expect(events[0]?.result).toBe("Error: boom");
  });

  it("restores a failed post with a fresh window — retry, not spin", async () => {
    vi.useFakeTimers();
    const fail = { n: 0 };
    const convs = new Map<string, Conversation>([
      ["child", conv("child", { parentId: "p", ticketId: "T-3" })],
    ]);
    const { ctx, calls } = fakeCtx(convs, fail);
    noteTaskWake(ctx, { taskId: "T-3", turnId: "t-1", outcome: "finished" });
    await fire();
    expect(calls.filter((c) => c.method === "tasks.wake")).toHaveLength(1);
    await fire();
    expect(calls.filter((c) => c.method === "tasks.wake")).toHaveLength(2);
  });

  it("stop drops the coalesce timer", async () => {
    vi.useFakeTimers();
    const convs = new Map<string, Conversation>([
      ["child", conv("child", { parentId: "p", ticketId: "T-4" })],
    ]);
    const { ctx, calls } = fakeCtx(convs);
    noteTaskWake(ctx, { taskId: "T-4", turnId: "t-1", outcome: "finished" });
    stopTaskLoop(ctx);
    await vi.advanceTimersByTimeAsync(TASK_WAKE_COALESCE_MS * 2);
    await micro();
    expect(calls).toHaveLength(0);
  });

  it("a timer firing ahead of the wall clock re-arms — the #873 flake", async () => {
    vi.useFakeTimers();
    /* The coalesce timer's monotonic clock can land a millisecond or two
       ahead of `Date.now()`. The early flush then polls a window that is
       still open; the old code returned without re-arming and the batch
       sat in `pending` forever — the parent never woke. A hand-driven
       `now` injects that ordering deterministically. */
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const convs = new Map<string, Conversation>([
        ["child", conv("child", { parentId: "p", ticketId: "T-8" })],
      ]);
      const { ctx, calls } = fakeCtx(convs);
      noteTaskWake(ctx, { taskId: "T-8", turnId: "t-1", outcome: "finished" });

      // The timer fires on schedule while `Date.now()` still reads
      // inside the window: poll declines, nothing is posted yet.
      await vi.advanceTimersByTimeAsync(TASK_WAKE_COALESCE_MS);
      await micro();
      expect(calls.filter((c) => c.method === "tasks.wake")).toHaveLength(0);

      // The wall clock reaches the deadline; the re-armed remainder
      // timer must deliver the batch — exactly once.
      now += TASK_WAKE_COALESCE_MS;
      await vi.advanceTimersByTimeAsync(TASK_WAKE_COALESCE_MS);
      await micro();
      const wakes = calls.filter((c) => c.method === "tasks.wake");
      expect(wakes).toHaveLength(1);
      expect(
        (wakes[0]!.params.events as { taskId: string }[]).map((e) => e.taskId),
      ).toEqual(["T-8"]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("register re-enters owed wakes — the restart catch-up", async () => {
    vi.useFakeTimers();
    const { ctx, calls } = fakeCtx(new Map(), undefined, async (method) => {
      if (method === "harness.register") {
        return {
          hostId: "h1",
          pending: [],
          taskWakes: [
            { taskId: "T-7", turnId: "seq:child:2", outcome: "finished" },
          ],
        };
      }
      return { delivered: ["T-7"] };
    });
    /* onRelayReady drives the whole handshake — the stubs serve only the
       parts this test does not exercise. */
    const c = ctx as HarnessCtx & Record<string, unknown>;
    c.started = true;
    c.registering = false;
    c.registerAgain = false;
    c.flushOutbox = async () => {};
    c.reconcileAsks = async () => {};
    c.sweepNow = async () => {};
    c.syncScheduledTasks = async () => {};
    c.watchChannel = () => {};
    c.deliver = () => Promise.resolve();
    await onRelayReady.call(ctx);
    await fire();
    const wakes = calls.filter((x) => x.method === "tasks.wake");
    expect(wakes).toHaveLength(1);
    expect(
      (wakes[0]!.params.events as { taskId: string }[]).map((e) => e.taskId),
    ).toEqual(["T-7"]);
  });
});

describe("task hand-off end-to-end (engine-fake, D-#844)", () => {
  it("a finished child wakes the parent thread with its result", async () => {
    const homeDir = mkhome();
    const w = await setupWorld({ homeDir });
    try {
      const { employee: caller, channel: callerChannel } =
        await openDmConversation(w.user);
      const { employee: worker } = await w.user.request<{
        employee: { id: string; name: string };
      }>("employees.create", { name: "Bea", role: "eng" });
      /* The task's ticket needs the parent's project (D-#854). */
      await w.user.request("projects.create", { folder: homeDir });
      const { conversation: parent } = await w.user.request<{
        conversation: { id: string; channelId: string };
      }>("conversations.open", {
        channelId: callerChannel.id,
        text: "Plan the week",
        cwd: homeDir,
      });
      // Let the parent's own root turn finish before the hand-off.
      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; finishedSeq: number }[];
        }>("conversations.list", {});
        const conv = conversations.find((c) => c.id === parent.id);
        return conv && conv.finishedSeq > 0 ? true : undefined;
      }, "parent root turn");

      /* The hand-off: what the task_create tool calls after resolving the
         agent — the harness's relay client IS the host peer. */
      const created = await w.harnessRelay.request<{
        task: { id: string; status: string; threadId: string };
        conversation: { id: string; channelId: string };
        rootMessage: { text: string };
      }>("tasks.create", {
        parentConversationId: parent.id,
        employeeId: worker.id,
        prompt: "Summarize the milestones",
        requestId: "r-1",
      });
      expect(created.task.status).toBe("running");
      expect(created.rootMessage.text).toBe("Summarize the milestones");

      /* The first waitFor times out with the same dump the second one
         carries — CI gave only "timed out waiting for parent taskWake
         message" (#873), which says nothing about where the loop broke. */
      const dump = async () => {
        const { messages: parentMsgs } = await w.user.request<{
          messages: AppMessage[];
        }>("messages.list", {
          channelId: parent.channelId,
          conversationId: parent.id,
        });
        const { conversations: convRows } = await w.user.request<{
          conversations: { id: string; engineRef?: string }[];
        }>("conversations.list", {});
        const parentMsgsConv = convRows.find((c) => c.id === parent.id);
        const { messages: childMsgs } = await w.user.request<{
          messages: AppMessage[];
        }>("messages.list", {
          channelId: created.conversation.channelId,
          conversationId: created.conversation.id,
        });
        // eslint-disable-next-line no-console
        console.log(
          "HARNESS LOG\n" +
            w.log.lines.join("\n") +
            "\nPARENT\n" +
            parentMsgs
              .map(
                (m) =>
                  `${m.seq} ${m.authorKind} ${JSON.stringify(m.text).slice(0, 80)}`,
              )
              .join("\n") +
            "\nCHILD\n" +
            childMsgs
              .map(
                (m) =>
                  `${m.seq} ${m.authorKind} ${JSON.stringify(m.text).slice(0, 80)}`,
              )
              .join("\n") +
            "\nENGINE CALLS\n" +
            w.engineCalls
              .map(
                (c) =>
                  `${c.method} ${
                    c.method === "prompt"
                      ? JSON.stringify(c.params).slice(0, 140)
                      : JSON.stringify(c.params).slice(0, 60)
                  }`,
              )
              .join("\n") +
            "\nCONVS\n" +
            convRows.map((c) => JSON.stringify(c)).join("\n") +
            "\nPARENT SESSION EVENTS\n" +
            (
              (await w.engine?.dispatch("events.since", {
                sessionId: parentMsgsConv?.engineRef ?? "",
                after: 0,
              })) as
                | { events?: { type: string; payload: unknown }[] }
                | undefined
            )?.events
              ?.map(
                (e) => `${e.type} ${JSON.stringify(e.payload).slice(0, 100)}`,
              )
              .join("\n"),
        );
      };
      // The child turn runs on the worker's channel; its finish posts one
      // taskWake onto the parent's thread.
      let wake: AppMessage;
      try {
        wake = await waitFor(async () => {
          const { messages } = await w.user.request<{
            messages: AppMessage[];
          }>("messages.list", {
            channelId: parent.channelId,
            conversationId: parent.id,
          });
          return messages.find((m) => m.taskWake === true);
        }, "parent taskWake message");
      } catch (error) {
        await dump();
        throw error;
      }
      expect(wake.text).toContain(created.task.id);
      expect(wake.conversationId).toBe(parent.id);

      // The wake is the parent's next prompt — the fake engine answers it,
      // proving the loop closed without the user typing anything.
      try {
        await waitFor(async () => {
          const { messages } = await w.user.request<{ messages: AppMessage[] }>(
            "messages.list",
            { channelId: parent.channelId, conversationId: parent.id },
          );
          const after = messages.filter((m) => m.seq > wake.seq);
          return after.find((m) => m.authorKind === "employee");
        }, "parent answer to the wake");
      } catch (error) {
        await dump();
        throw error;
      }

      // tasks.read reports the delivered result.
      const read = await w.harnessRelay.request<{
        task: { status: string; result?: string };
      }>("tasks.read", {
        taskId: created.task.id,
        parentConversationId: parent.id,
      });
      expect(read.task.status).toBe("finished");
      /* engine-fake's canned answer is what rode the wake as the
         result — the marker is in the text it produced. */
      expect(read.task.result ?? "").toContain("Short answer");
      void caller;
    } finally {
      await w.cleanup();
    }
  }, 30_000);
});
