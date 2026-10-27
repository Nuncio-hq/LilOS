import { describe, expect, it } from "vitest";
import { setupWorld, waitFor } from "./helpers";

/**
 * D-#835 + #846 + #872 — the Employee record is the one source of an
 * agent's default model + effort: `session.start` takes the conversation
 * pick, else the employee's own pin, else nothing (the runtime's own
 * default). The legacy `codingAgents` KV row is never read — a stale row
 * must not outvote what the agent page shows. Per-thread picks and
 * per-job `task_create` overrides (both land on the conversation row) win.
 */

const hireAndOpen = async (
  w: Awaited<ReturnType<typeof setupWorld>>,
  employee: { name: string; profile: string },
) => {
  const { employee: e } = await w.user.request<{ employee: { id: string } }>(
    "employees.create",
    { name: employee.name, role: "engineer", profile: employee.profile },
  );
  const { channel } = await w.user.request<{
    channel: { id: string; employeeId: string };
  }>("channels.openDm", { employeeId: e.id });
  return channel;
};

const startParams = (w: Awaited<ReturnType<typeof setupWorld>>) =>
  waitFor(async () => {
    const call = w.engineCalls.find((c) => c.method === "session.start");
    return call ? (call.params as Record<string, unknown>) : undefined;
  }, "session.start params");

describe("employee default -> session.start (#846, #872)", () => {
  it("a KV row written after the hire fills nothing — the runtime's own default applies", async () => {
    const w = await setupWorld();
    try {
      const channel = await hireAndOpen(w, { name: "Devin", profile: "devin" });
      await w.user.request("settings.set", {
        key: "codingAgents",
        value: { devin: { model: "fake-smart", effort: "high" } },
      });
      await w.user.request("conversations.open", {
        channelId: channel.id,
        text: "hi",
      });
      const params = await startParams(w);
      expect(params.model).toBeUndefined();
      expect(params.effort).toBeUndefined();
    } finally {
      await w.cleanup();
    }
  });

  it("a model pin with no effort never inherits the KV effort", async () => {
    const w = await setupWorld();
    try {
      await w.user.request("settings.set", {
        key: "codingAgents",
        value: { devin: { model: "fake-smart", effort: "high" } },
      });
      const { employee: e } = await w.user.request<{
        employee: { id: string };
      }>("employees.create", {
        name: "Devin",
        role: "engineer",
        profile: "devin",
      });
      await w.user.request("employees.update", {
        id: e.id,
        model: "fake-reasoning",
        effort: "",
      });
      const { channel } = await w.user.request<{ channel: { id: string } }>(
        "channels.openDm",
        { employeeId: e.id },
      );
      await w.user.request("conversations.open", {
        channelId: channel.id,
        text: "hi",
      });
      const params = await startParams(w);
      expect(params.model).toBe("fake-reasoning");
      expect(params.effort).toBeUndefined();
    } finally {
      await w.cleanup();
    }
  });

  /* #872: the agent page's Default model/effort is the employee record's
     pin — the one source every runtime's sessions read. */
  it("the employee pin is the default, whatever the KV says", async () => {
    const w = await setupWorld();
    try {
      await w.user.request("settings.set", {
        key: "codingAgents",
        value: { devin: { model: "fake-smart", effort: "high" } },
      });
      const { employee: e } = await w.user.request<{
        employee: { id: string };
      }>("employees.create", {
        name: "Devin",
        role: "engineer",
        profile: "devin",
      });
      await w.user.request("employees.update", {
        id: e.id,
        model: "fake-reasoning",
        effort: "low",
      });
      const { channel } = await w.user.request<{
        channel: { id: string };
      }>("channels.openDm", { employeeId: e.id });
      await w.user.request("conversations.open", {
        channelId: channel.id,
        text: "hi",
      });
      const params = await startParams(w);
      expect(params).toMatchObject({ model: "fake-reasoning", effort: "low" });
    } finally {
      await w.cleanup();
    }
  });

  it("a conversation pin beats the employee default", async () => {
    const w = await setupWorld({ attachEngine: false });
    try {
      await w.user.request("settings.set", {
        key: "codingAgents",
        value: { devin: { model: "fake-smart", effort: "high" } },
      });
      // Pin the thread BEFORE the engine exists — the same path a
      // task_create override takes (the row carries the pick into start).
      const channel = await hireAndOpen(w, { name: "Devin", profile: "devin" });
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", { channelId: channel.id, text: "hi" });
      await w.user.request("conversations.setModel", {
        conversationId: conversation.id,
        model: "fake-reasoning",
        effort: "low",
      });
      // Settle before attach: the pin landed on the row and the send parked
      // in `early` (the attach loop flushes only what it finds there).
      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; model?: string | null }[];
        }>("conversations.list", {});
        return conversations.find((c) => c.id === conversation.id)?.model ===
          "fake-reasoning"
          ? true
          : undefined;
      }, "conversation.model pin");
      await waitFor(
        async () =>
          w.log.lines.some(
            (l) =>
              l.includes("message held for engine") &&
              l.includes(conversation.id),
          )
            ? true
            : undefined,
        "send parked in early",
      );
      const conn = w.engineConn;
      if (!conn) throw new Error("world built without an engine");
      w.harness.attachEngine(conn);
      const params = await startParams(w);
      expect(params).toMatchObject({
        model: "fake-reasoning",
        effort: "low",
      });
    } finally {
      await w.cleanup();
    }
  });

  /* The employee's effort is a rung on ITS model's ladder — a thread that
     picked another model must not wear it. */
  it("the employee effort rides only its own model", async () => {
    const w = await setupWorld();
    try {
      const { employee } = await w.user.request<{
        employee: import("@lilos/contracts/app").Employee;
      }>("employees.create", {
        name: "Devin",
        role: "engineer",
        profile: "devin",
        model: "fake-smart",
      });
      const emp = { ...employee, effort: "high" };
      const sp = (conv?: { model?: string; effort?: string }) =>
        (
          w.harness as unknown as {
            sessionParams: (
              e: unknown,
              a: string,
              c?: unknown,
            ) => Promise<Record<string, unknown>>;
          }
        ).sessionParams(emp, "devin", conv);
      expect(await sp()).toMatchObject({ model: "fake-smart", effort: "high" });
      expect(await sp({ model: "fake-smart" })).toMatchObject({
        effort: "high",
      });
      const other = await sp({ model: "fake-reasoning" });
      expect(other.model).toBe("fake-reasoning");
      expect(other.effort).toBeUndefined();
      expect(
        await sp({ model: "fake-reasoning", effort: "low" }),
      ).toMatchObject({ model: "fake-reasoning", effort: "low" });
    } finally {
      await w.cleanup();
    }
  });

  it("a non-coding-agent employee never sees the KV", async () => {
    const w = await setupWorld();
    try {
      await w.user.request("settings.set", {
        key: "codingAgents",
        value: { devin: { model: "fake-smart", effort: "high" } },
      });
      const channel = await hireAndOpen(w, {
        name: "Ada",
        profile: "builder",
      });
      await w.user.request("conversations.open", {
        channelId: channel.id,
        text: "hi",
      });
      const params = await startParams(w);
      expect(params.model).toBeUndefined();
      expect(params.effort).toBeUndefined();
    } finally {
      await w.cleanup();
    }
  });
});
