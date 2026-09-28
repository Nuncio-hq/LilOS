import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os, { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  exchangePairingGrant,
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

/**
 * Connect, retrying refusal until the deadline. A refused socket is the
 * observable answer to "nothing bound yet" — the relay's tailnet bind lands
 * just after its "listening" line, so callers race startup.
 */
async function tcpConnect(host: string, port: number, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error("connect timeout");
  for (;;) {
    const attempt = await new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host, port });
      socket.on("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", reject);
    }).then(
      () => null,
      (error: unknown) => error,
    );
    if (attempt === null) return;
    lastError = attempt;
    if (Date.now() >= deadline) throw lastError;
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** A free loopback port for tests that bind two listeners on one port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

interface HelloFrame {
  result?: { protocolVersion?: number };
  error?: { message: string; data?: { code?: string } };
}

/** Raw ws device hello — the phone leg the RelayClient can't speak (#153). */
async function deviceHelloRaw(
  url: string,
  deviceId: string,
  credential: string,
): Promise<{ ws: WebSocket; frame: HelloFrame }> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const frame = await new Promise<HelloFrame>((resolve, reject) => {
    ws.once("message", (data: WebSocket.RawData) => {
      resolve(JSON.parse(data.toString()) as HelloFrame);
    });
    ws.once("error", reject);
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "hello-1",
        method: "session.hello",
        params: { protocolVersion: 1, deviceId, credential },
      }),
    );
  });
  return { ws, frame };
}

/** Device hello that asserts the welcome, returning the live socket. */
async function deviceHello(url: string, deviceId: string, credential: string) {
  const { ws, frame } = await deviceHelloRaw(url, deviceId, credential);
  if (frame.error) throw new Error(`hello failed: ${frame.error.message}`);
  return { ws, welcome: frame.result ?? {} };
}

function waitForWsClose(ws: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => {
    ws.once("close", (code: number) => resolve({ code }));
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

  it("AC-1+3+4 phone pairing over the Tailscale listener (env-seamed)", async () => {
    // LILOS_RELAY_TAILSCALE_* pin a fake tailnet identity on this machine's
    // LAN address: a real non-loopback bind + real probe result — no
    // tailscaled needed. A fixed port keeps the listener's address stable
    // across the restart leg below (port 0 → different ephemeral ports).
    const lan = lanAddress();
    if (!lan) {
      console.warn("no LAN address — skipping the tailnet-bind e2e");
      return;
    }
    const port = await freePort();
    const relay = await startRelay({
      LILOS_RELAY_PORT: String(port),
      LILOS_RELAY_TAILSCALE_IP: lan,
      LILOS_RELAY_TAILSCALE_NAME: "mac.tailnet.test",
    });
    const mac = new RelayClient({
      url: relay.url,
      token: relay.token,
      socketFactory: wsFactory().factory,
      autoReconnect: false,
      client: { name: "e2e-mac" },
    });
    await mac.connect();

    // Off by default: nothing answers on the tailnet address.
    await expect(tcpConnect(lan, relay.port)).rejects.toThrow();

    // Pair phone = turn on access + mint a grant; the offer advertises the
    // MagicDNS name (never loopback) on the tailnet listener's own port.
    const { offer } = await mac.request<{
      offer: { host: string; code: string; expiresAt: number };
    }>("pairing.offer", {});
    expect(offer.host).toBe(`mac.tailnet.test:${port}`);
    expect(offer.code).toHaveLength(12);
    const tsPort = port;
    await tcpConnect(lan, tsPort);

    // The phone exchanges the grant over the tailnet listener's HTTP side…
    const exchanged = await exchangePairingGrant(`http://${lan}:${tsPort}`, {
      code: offer.code,
      name: "Test iPhone",
    });
    expect(exchanged.deviceId).toMatch(/^dev_/);
    expect(exchanged.credential).toMatch(/^devcred_/);

    // …then hellos on the tailnet ws with its device credential.
    const phone = await deviceHello(
      `ws://${lan}:${tsPort}/ws`,
      exchanged.deviceId,
      exchanged.credential,
    );
    expect(phone.welcome.protocolVersion).toBe(1);
    const phoneClosed = waitForWsClose(phone.ws);

    // AC-2: the spent grant can't be replayed.
    await expect(
      exchangePairingGrant(`http://${lan}:${tsPort}`, { code: offer.code }),
    ).rejects.toMatchObject({ name: "PairingExchangeFailed", reason: "used" });

    // AC-4: the Mac sees the phone and revoking it drops its socket.
    const { devices } = await mac.request<{
      devices: {
        id: string;
        name: string;
        pairedAt: number;
        lastSeenAt: number;
      }[];
    }>("devices.list", {});
    expect(devices).toEqual([
      expect.objectContaining({
        id: exchanged.deviceId,
        name: "Test iPhone",
      }),
    ]);
    await mac.request("devices.revoke", { deviceId: exchanged.deviceId });
    expect((await phoneClosed).code).toBe(4403);
    const zombie = await deviceHelloRaw(
      `ws://${lan}:${tsPort}/ws`,
      exchanged.deviceId,
      exchanged.credential,
    );
    expect(zombie.frame.error?.data?.code).toBe("unauthenticated");

    // The choice survives a restart: a fresh process on the same home
    // rebinds the tailnet address at startup — before any pairing.offer.
    spawned[spawned.length - 1]?.kill("SIGKILL");
    await startRelay({
      LILOS_RELAY_HOME: relay.home,
      LILOS_RELAY_PORT: String(port),
      LILOS_RELAY_TAILSCALE_IP: lan,
      LILOS_RELAY_TAILSCALE_NAME: "mac.tailnet.test",
    });
    await tcpConnect(lan, port, 5_000);
    mac.close();
  }, 60_000);

  it("AC-1 Tailscale down → pairing.offer answers tailscale_unavailable", async () => {
    // A missing binary is the honest "not installed" probe failure.
    const relay = await startRelay({
      LILOS_TAILSCALE_BIN: "/nonexistent-tailscale-bin",
    });
    const mac = new RelayClient({
      url: relay.url,
      token: relay.token,
      socketFactory: wsFactory().factory,
      autoReconnect: false,
      client: { name: "e2e-mac-down" },
    });
    await mac.connect();
    await expect(mac.request("pairing.offer", {})).rejects.toMatchObject({
      code: "tailscale_unavailable",
    });
    mac.close();
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
