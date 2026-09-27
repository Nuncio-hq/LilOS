import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RelayClient,
  type RelaySocket,
  type SocketFactory,
} from "@lilos/client-runtime";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

/**
 * Issue #113 AC-5: recents + conversation cwd are LilOS-owned and live in
 * sqlite, so they survive a relay restart. Spawns the real relay over a temp
 * LILOS_RELAY_HOME — the spawn/ws helpers are borrowed from e2e.test.ts.
 */

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUN = process.env.LILOS_BUN_BIN ?? "bun";
const spawned: ChildProcess[] = [];
const homes: string[] = [];

afterAll(() => {
  for (const child of spawned) child.kill("SIGKILL");
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function wsFactory(): SocketFactory {
  const factory: SocketFactory = (url) => {
    const ws = new WebSocket(url);
    const listeners: Record<string, ((event: unknown) => void)[]> = {};
    ws.on("open", () => listeners.open?.forEach((f) => void f(undefined)));
    ws.on("message", (data: WebSocket.RawData) => {
      listeners.message?.forEach((f) => void f({ data: data.toString() }));
    });
    ws.on("close", (code: number, reason: Buffer) => {
      listeners.close?.forEach(
        (f) => void f({ code, reason: reason.toString() }),
      );
    });
    ws.on("error", (error: Error) => {
      listeners.error?.forEach((f) => void f(error));
    });
    const socket: RelaySocket = {
      get readyState() {
        return ws.readyState;
      },
      send: (data: string) => ws.send(data),
      close: (code?: number, reason?: string) => ws.close(code, reason),
      addEventListener(type: string, listener: (event: never) => void) {
        const list = listeners[type] ?? [];
        listeners[type] = list;
        list.push(listener as (event: unknown) => void);
      },
    };
    return socket;
  };
  return factory;
}

async function startRelay(home?: string) {
  const relayHome = home ?? mkdtempSync(join(tmpdir(), "lilos-relay-113-"));
  homes.push(relayHome);
  const child = spawn(BUN, ["run", "src/index.ts"], {
    cwd: RELAY_DIR,
    env: {
      ...process.env,
      LILOS_RELAY_HOME: relayHome,
      LILOS_RELAY_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(child);
  const address = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("relay did not start")),
      15_000,
    );
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(
        /listening on http:\/\/([0-9a-fA-F.:]+):(\d+)/,
      );
      if (match) {
        clearTimeout(timer);
        resolve(`${match[1]}:${match[2]}`);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`relay exited ${code}: ${buffer}`));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
    });
  });
  const [host, port] = address.split(":");
  const token = readFileSync(join(relayHome, "relay-token"), "utf8").trim();
  return {
    home: relayHome,
    token,
    url: `ws://${host}:${port}/ws`,
    proc: child,
  };
}

const connect = (url: string, token: string) =>
  new RelayClient({
    url,
    token,
    socketFactory: wsFactory(),
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
