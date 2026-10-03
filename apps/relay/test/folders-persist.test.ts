import { RelayClient } from "@lilos/client-runtime";
import { describe, expect, it } from "vitest";
import { startRelay, wsFactory } from "./helpers";

/**
 * Issue #113 AC-5: recents + conversation cwd are LilOS-owned and live in
 * sqlite, so they survive a relay restart. Spawns the real relay over a temp
 * LILOS_RELAY_HOME — the spawn/ws helpers are borrowed from e2e.test.ts.
 */

const connect = (url: string, token: string) =>
  new RelayClient({
    url,
    token,
    socketFactory: wsFactory().factory,
    autoReconnect: false,
    client: { name: "e2e-folders" },
  });

describe("AC-5 recents + cwd survive a relay restart", () => {
  it("folders.list and conversation.cwd come back after restart", async () => {
    const first = await startRelay();
    const client = connect(first.url, first.token);
    await client.connect();

    const { employee } = await client.request<{ employee: { id: string } }>(
      "employees.create",
      { name: "Ada", role: "eng" },
    );
    const { channel } = await client.request<{ channel: { id: string } }>(
      "channels.openDm",
      { employeeId: employee.id },
    );
    const { conversation } = await client.request<{
      conversation: { id: string; cwd?: string };
    }>("conversations.open", {
      channelId: channel.id,
      text: "go",
      cwd: "/tmp/persisted-folder",
    });
    await client.request("folders.add", { path: "/tmp/added-folder" });
    client.close();
    first.proc.kill("SIGKILL");
    await new Promise<void>((r) => first.proc.once("exit", () => r()));

    const second = await startRelay(first.home);
    const back = connect(second.url, first.token);
    await back.connect();

    const { folders } = await back.request<{
      folders: { path: string; lastUsedAt: number }[];
    }>("folders.list", {});
    expect(folders.map((f) => f.path)).toEqual(
      expect.arrayContaining(["/tmp/added-folder", "/tmp/persisted-folder"]),
    );

    const { conversations } = await back.request<{
      conversations: { id: string; cwd?: string }[];
    }>("conversations.list", {});
    expect(conversations.find((c) => c.id === conversation.id)?.cwd).toBe(
      "/tmp/persisted-folder",
    );
    back.close();
  }, 30_000);
});
