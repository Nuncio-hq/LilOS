import { describe, expect, it } from "vitest";
import { setupWorld, waitFor } from "./helpers";

/**
 * D-#835 + #846 — the owner's stored per-coding-agent default (the
 * `codingAgents` KV) fills `session.start`'s model/effort when neither the
 * conversation pin nor the employee record named one. The KV keys on the
 * employee's agent handle (`profile`); a per-thread pick or a per-job
 * `task_create` override (both land on the conversation row) still win.
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

describe("codingAgents KV default -> session.start (#846)", () => {
  it("a stored devin default fills model + effort when nothing is pinned", async () => {
    const w = await setupWorld();
    try {
      await w.user.request("settings.set", {
        key: "codingAgents",
        value: { devin: { model: "fake-smart", effort: "high" } },
      });
      const channel = await hireAndOpen(w, { name: "Devin", profile: "devin" });
      await w.user.request("conversations.open", {
        channelId: channel.id,
        text: "hi",
      });
      const params = await startParams(w);
      expect(params).toMatchObject({ model: "fake-smart", effort: "high" });
    } finally {
      await w.cleanup();
    }
  });

  it("a conversation pin beats the stored default", async () => {
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
