import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os, { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RelayClient,
  type RelaySocket,
  type SocketFactory,
} from "@lilos/client-runtime";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUN = process.env.LILOS_BUN_BIN ?? "bun";
const spawned: ChildProcess[] = [];
const homes: string[] = [];

afterAll(() => {
  for (const child of spawned) child.kill("SIGKILL");
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/** ws-package → RelaySocket adapter (Node has no usable DOM WebSocket). */
function wsFactory(): {
  factory: SocketFactory;
  last: () => WebSocket | undefined;
} {
  let last: WebSocket | undefined;
  const factory: SocketFactory = (url) => {
    const ws = new WebSocket(url);
    last = ws;
    const listeners: Record<string, ((event: unknown) => void)[]> = {};
    ws.on("open", () => {
      listeners.open?.forEach((f) => {
        f(undefined);
      });
    });
    ws.on("message", (data: WebSocket.RawData) => {
      listeners.message?.forEach((f) => {
        f({ data: data.toString() });
      });
    });
    ws.on("close", (code: number, reason: Buffer) => {
      listeners.close?.forEach((f) => {
        f({ code, reason: reason.toString() });
      });
    });
    ws.on("error", (error: Error) => {
      listeners.error?.forEach((f) => {
        f(error);
      });
    });
    const listenersFor = (type: string) => (listeners[type] ??= []);
    const socket: RelaySocket = {
      get readyState() {
        return ws.readyState;
      },
      send: (data: string) => ws.send(data),
      close: (code?: number, reason?: string) => ws.close(code, reason),
      addEventListener(type: string, listener: (event: never) => void) {
        listenersFor(type).push(listener as (event: unknown) => void);
      },
    };
    return socket;
  };
  return { factory, last: () => last };
}

async function startRelay(env: Record<string, string> = {}): Promise<{
  home: string;
  host: string;
  port: number;
  token: string;
  url: string;
}> {
  const home =
    env.LILOS_RELAY_HOME ?? mkdtempSync(join(tmpdir(), "lilos-relay-test-"));
  homes.push(home);
  const child = spawn(BUN, ["run", "src/index.ts"], {
    cwd: RELAY_DIR,
    env: {
      ...process.env,
      LILOS_RELAY_HOME: home,
      LILOS_RELAY_PORT: "0",
      ...env,
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
  const token = readFileSync(join(home, "relay-token"), "utf8").trim();
  return {
    home,
    host,
    port: Number(port),
    token,
    url: `ws://${host}:${port}/ws`,
  };
}

async function tcpConnect(host: string, port: number, timeoutMs = 1500) {
  return new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("connect timeout"));
    }, timeoutMs);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

interface Listenable<T> {
  get(): T;
  listen(cb: (value: T) => void): () => void;
}

function waitFor<T>(atom: Listenable<T>, pred: (value: T) => boolean) {
  return new Promise<void>((resolve) => {
    if (pred(atom.get())) return resolve();
    const unsub = atom.listen((value) => {
      if (pred(value)) {
        unsub();
        resolve();
      }
    });
  });
}

function lanAddress(): string | undefined {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal)
        return address.address;
    }
  }
  return undefined;
}

describe("relay e2e (real Bun process + bun:sqlite)", () => {
  it("AC-6 binds 127.0.0.1 by default; LILOS_RELAY_HOST is configuration only", async () => {
    const relay = await startRelay();
    expect(relay.host).toBe("127.0.0.1");
    // Loopback works.
    await tcpConnect("127.0.0.1", relay.port);
    // Non-loopback refuses: nothing else on the LAN interface can reach it.
    const lan = lanAddress();
    if (lan) {
      await expect(tcpConnect(lan, relay.port)).rejects.toThrow();
    }
    // ...until the operator opts in via configuration.
    const open = await startRelay({ LILOS_RELAY_HOST: "0.0.0.0" });
    if (lan) {
      await expect(tcpConnect(lan, open.port)).resolves.toBeUndefined();
    }
  }, 30_000);

  it("AC-2 + AC-3 end to end: employee → DM → conversation, ordered messages, resume without gaps", async () => {
    const relay = await startRelay();
    const aliceSockets = wsFactory();
    const alice = new RelayClient({
      url: relay.url,
      token: relay.token,
      socketFactory: aliceSockets.factory,
      autoReconnect: false,
      reconnectMinDelayMs: 50,
      client: { name: "e2e-alice" },
    });
    const bob = new RelayClient({
      url: relay.url,
      token: relay.token,
      socketFactory: wsFactory().factory,
      autoReconnect: false,
      client: { name: "e2e-bob" },
    });
    await alice.connect();
    await bob.connect();

    // AC-2: seed an employee, open their DM channel, open a conversation.
    const { employee } = await bob.request<{
      employee: { id: string; name: string };
    }>("employees.create", { name: "Ada", role: "engineer" });
    const { channel } = await bob.request<{ channel: { id: string } }>(
      "channels.openDm",
      { employeeId: employee.id },
    );
    const messages = alice.channelMessages(channel.id);
    // Wait until the subscription is synced before posting.
    await waitFor(messages, (s) => s.synced);

    const { conversation } = await bob.request<{
      conversation: { id: string; rootMessageId: string };
    }>("conversations.open", {
      channelId: channel.id,
      text: "please review the deploy",
      title: "deploy review",
    });
    expect(conversation.rootMessageId).toBeTruthy();

    // Alice is subscribed: the root message lands live as seq 1.
    await waitFor(messages, (s) => s.messages.length === 1);
    expect(messages.get().messages.map((m) => m.seq)).toEqual([1]);

    // Force-drop Alice's socket, then keep posting while she is down.
    const drop = waitFor(alice.state, (s) => s === "closed");
    aliceSockets.last()?.close();
    await drop;
    expect(alice.state.get()).toBe("closed");

    await bob.request("messages.post", {
      channelId: channel.id,
      text: "missed-2",
    });
    await bob.request("messages.post", {
      channelId: channel.id,
      text: "missed-3",
    });
    await bob.request("messages.post", {
      channelId: channel.id,
      text: "missed-4",
    });

    // Reconnect: hello + resubscribe with afterSeq=watermark(1) replays 2..4.
    await alice.connect();
    await waitFor(messages, (s) => s.synced && s.messages.length === 4);
    const finalState = messages.get();
    expect(finalState.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(finalState.messages.map((m) => m.text)).toEqual([
      "please review the deploy",
      "missed-2",
      "missed-3",
      "missed-4",
    ]);
    alice.close();
    bob.close();
  }, 30_000);

  it("AC-3 attachments survive a relay restart: refs on sqlite, bytes on disk", async () => {
    const first = await startRelay();
    const bob = new RelayClient({
      url: first.url,
      token: first.token,
      socketFactory: wsFactory().factory,
      autoReconnect: false,
      client: { name: "e2e-attachments" },
    });
    await bob.connect();
    const { employee } = await bob.request<{ employee: { id: string } }>(
      "employees.create",
      { name: "Ada", role: "engineer" },
    );
    const { channel } = await bob.request<{ channel: { id: string } }>(
      "channels.openDm",
      { employeeId: employee.id },
    );
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const { message } = await bob.request<{
      message: { attachments?: { id: string; sizeBytes: number }[] };
    }>("messages.post", {
      channelId: channel.id,
      text: "screenshot",
      attachments: [
        { name: "shot.png", mimeType: "image/png", dataBase64: png },
      ],
    });
    const refId = message.attachments?.[0]?.id;
    expect(refId).toBeTruthy();
    bob.close();
    spawned[spawned.length - 1]?.kill("SIGKILL");

    // Fresh process over the same home: the ref comes back via sqlite,
    // the bytes via the file blob store.
    const second = await startRelay({ LILOS_RELAY_HOME: first.home });
    const back = new RelayClient({
      url: second.url,
      token: first.token,
      socketFactory: wsFactory().factory,
      autoReconnect: false,
      client: { name: "e2e-attachments-2" },
    });
    await back.connect();
    const { messages: list } = await back.request<{
      messages: { attachments?: { id: string }[]; text: string }[];
    }>("messages.list", { channelId: channel.id });
    const restored = list.find((m) => m.attachments?.[0]?.id === refId);
    expect(restored).toBeTruthy();
    const got = await back.request<{
      attachment: { id: string; name: string; mimeType: string };
      dataBase64: string;
    }>("attachments.get", { id: refId });
    expect(got.attachment).toMatchObject({
      id: refId,
      name: "shot.png",
      mimeType: "image/png",
    });
    expect(got.dataBase64).toBe(png);
    back.close();
  }, 30_000);

  it("AC-7 (#92) the Edit-models hide list survives a relay restart on sqlite", async () => {
    const first = await startRelay();
    const client = new RelayClient({
      url: first.url,
      token: first.token,
      socketFactory: wsFactory().factory,
      autoReconnect: false,
      client: { name: "e2e-settings" },
    });
    await client.connect();
    const hidden = {
      providers: ["hpc"],
      models: ["devin::devin/claude-opus-5"],
    };
    await client.request("settings.set", {
      key: "modelVisibility",
      value: hidden,
    });
    const { value: got } = await client.request<{ value: unknown }>(
      "settings.get",
      { key: "modelVisibility" },
    );
    expect(got).toEqual(hidden);
    client.close();
    spawned[spawned.length - 1]?.kill("SIGKILL");

    // Fresh process over the same LILOS_RELAY_HOME → same sqlite file.
    const second = await startRelay({ LILOS_RELAY_HOME: first.home });
    const back = new RelayClient({
      url: second.url,
      token: first.token,
      socketFactory: wsFactory().factory,
      autoReconnect: false,
      client: { name: "e2e-settings-2" },
    });
    await back.connect();
    const { value: restored } = await back.request<{ value: unknown }>(
      "settings.get",
      { key: "modelVisibility" },
    );
    expect(restored).toEqual(hidden);
    back.close();
  }, 30_000);

  it("AC-4 live: a newer client is told to update the server", async () => {
    const relay = await startRelay();
    const newer = new RelayClient({
      url: relay.url,
      token: relay.token,
      socketFactory: wsFactory().factory,
      protocolVersion: 99,
      autoReconnect: false,
    });
    await expect(newer.connect()).rejects.toMatchObject({
      code: "protocol_version_mismatch",
      data: expect.objectContaining({ update: "server", clientVersion: 99 }),
    });
    // The "update the client" direction is covered in the in-process
    // session test (APP_PROTOCOL_VERSION is 1 — no older valid version).
    newer.close();
  }, 30_000);
});
