import { describe, expect, it } from "vitest";
import { RelayClient } from "../src/client";
import type { RelaySocket } from "../src/socket";

type StoredListener = (event: unknown) => void;

class FakeSocket implements RelaySocket {
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, StoredListener[]>();

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as StoredListener);
    this.listeners.set(type, list);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }

  /* test-side driving */
  openSocket(): void {
    this.readyState = 1;
    this.fire("open");
  }
  emit(frame: unknown): void {
    this.fire("message", { data: JSON.stringify(frame) } as never);
  }
  emitClose(): void {
    this.readyState = 3;
    this.fire("close", { code: 1006, reason: "" } as never);
  }
  private fire(type: string, event?: never): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** Respond to the most recent request frame matching a method. */
  respondTo(method: string, result: unknown): void {
    const request = this.sent
      .map((raw) => JSON.parse(raw) as { id?: string; method?: string })
      .reverse()
      .find((f) => f.method === method && f.id !== undefined);
    if (!request) throw new Error(`no ${method} request was sent`);
    this.emit({ jsonrpc: "2.0", id: request.id, result });
  }
  failTo(
    method: string,
    error: { code: number; message: string; data?: unknown },
  ): void {
    const request = this.sent
      .map((raw) => JSON.parse(raw) as { id?: string; method?: string })
      .reverse()
      .find((f) => f.method === method && f.id !== undefined);
    if (!request) throw new Error(`no ${method} request was sent`);
    this.emit({ jsonrpc: "2.0", id: request.id, error });
  }
}

function makeClient(
  options: Partial<ConstructorParameters<typeof RelayClient>[0]> = {},
) {
  const socket = new FakeSocket();
  const client = new RelayClient({
    url: "ws://fake",
    token: "tok",
    socketFactory: () => socket,
    requestTimeoutMs: 200,
    connectTimeoutMs: 200,
    autoReconnect: false,
    ...options,
  });
  return { socket, client };
}

const WELCOME = {
  protocolVersion: 1,
  relayVersion: "0.0.0",
  instanceId: "inst-1",
};

/** Drives the socket through open + hello while connect() is in flight. */
async function connectClient(client: RelayClient, getSocket: () => FakeSocket) {
  const pending = client.connect();
  await Promise.resolve();
  const socket = getSocket();
  socket.openSocket();
  await Promise.resolve();
  socket.respondTo("session.hello", WELCOME);
  await pending;
  // Answer the resync directory reads so later request counting is clean.
  socket.respondTo("employees.list", { employees: [] });
  socket.respondTo("channels.list", { channels: [] });
  socket.respondTo("conversations.list", { conversations: [] });
}

describe("RelayClient", () => {
  it("handshakes, exposes state, and resolves requests", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, () => socket);
    expect(client.state.get()).toBe("ready");

    const listPromise = client.request<{ employees: unknown[] }>(
      "employees.list",
      {},
    );
    socket.respondTo("employees.list", { employees: [{ id: "e1" }] });
    expect((await listPromise).employees).toHaveLength(1);
  });

  it("rejects connect with a typed error on protocol_version_mismatch", async () => {
    const { client, socket } = makeClient();
    const pending = client.connect();
    await Promise.resolve();
    socket.openSocket();
    await Promise.resolve();
    socket.failTo("session.hello", {
      code: -32002,
      message: "protocol version mismatch",
      data: {
        code: "protocol_version_mismatch",
        update: "server",
        clientVersion: 1,
        serverVersion: 2,
      },
    });
    await expect(pending).rejects.toMatchObject({
      code: "protocol_version_mismatch",
      data: { update: "server" },
    });
    expect(client.state.get()).not.toBe("ready");
  });

  it("AC-3 parks live frames during catch-up, flushed in order after synced", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, () => socket);
    const store = client.channelMessages("ch1");
    // channelMessages() marks the channel catching-up synchronously; a live
    // frame arriving before the snapshot+synced pair must not dispatch early.
    socket.emit({
      jsonrpc: "2.0",
      method: "message.created",
      params: {
        channelId: "ch1",
        message: {
          id: "m3",
          channelId: "ch1",
          conversationId: null,
          authorId: "e",
          authorKind: "employee",
          text: "live",
          seq: 3,
          createdAt: 0,
        },
      },
    });
    socket.emit({
      jsonrpc: "2.0",
      method: "channel.snapshot",
      params: {
        channelId: "ch1",
        lastSeq: 2,
        messages: [
          {
            id: "m1",
            channelId: "ch1",
            conversationId: null,
            authorId: "u",
            authorKind: "user",
            text: "a",
            seq: 1,
            createdAt: 0,
          },
          {
            id: "m2",
            channelId: "ch1",
            conversationId: null,
            authorId: "u",
            authorKind: "user",
            text: "b",
            seq: 2,
            createdAt: 0,
          },
        ],
      },
    });
    expect(store.get().synced).toBe(false);
    expect(store.get().messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    socket.emit({
      jsonrpc: "2.0",
      method: "channel.synced",
      params: { channelId: "ch1", lastSeq: 3 },
    });
    expect(store.get().synced).toBe(true);
    expect(store.get().messages.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("drops duplicate and stale message.created frames by seq", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, () => socket);
    const store = client.channelMessages("ch1");
    await Promise.resolve();

    // Simulate subscribe handshake: snapshot lastSeq=2, then synced.
    socket.emit({
      jsonrpc: "2.0",
      method: "channel.snapshot",
      params: {
        channelId: "ch1",
        lastSeq: 2,
        messages: [
          {
            id: "m1",
            channelId: "ch1",
            conversationId: null,
            authorId: "u",
            authorKind: "user",
            text: "a",
            seq: 1,
            createdAt: 0,
          },
          {
            id: "m2",
            channelId: "ch1",
            conversationId: null,
            authorId: "u",
            authorKind: "user",
            text: "b",
            seq: 2,
            createdAt: 0,
          },
        ],
      },
    });
    socket.emit({
      jsonrpc: "2.0",
      method: "channel.synced",
      params: { channelId: "ch1", lastSeq: 2 },
    });
    expect(store.get().messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(store.get().synced).toBe(true);

    const mk = (id: string, seq: number) => ({
      jsonrpc: "2.0",
      method: "message.created",
      params: {
        channelId: "ch1",
        message: {
          id,
          channelId: "ch1",
          conversationId: null,
          authorId: "u",
          authorKind: "user" as const,
          text: id,
          seq,
          createdAt: 0,
        },
      },
    });
    // Duplicate seq 3 then stale seq 2 — neither lands twice.
    socket.emit(mk("m3", 3));
    socket.emit(mk("m3-dupe", 3));
    socket.emit(mk("m2-again", 2));
    socket.emit(mk("m4", 4));
    expect(store.get().messages.map((m) => m.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
  });

  it("a restarted relay instance clears watermarks so resubscribe snapshots", async () => {
    const sockets: FakeSocket[] = [];
    const client = new RelayClient({
      url: "ws://fake",
      token: "tok",
      socketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      autoReconnect: false,
    });
    await connectClient(client, () => sockets[0]);
    const store = client.channelMessages("ch1");
    sockets[0].emit({
      jsonrpc: "2.0",
      method: "channel.snapshot",
      params: { channelId: "ch1", lastSeq: 5, messages: [] },
    });
    sockets[0].emit({
      jsonrpc: "2.0",
      method: "channel.synced",
      params: { channelId: "ch1", lastSeq: 5 },
    });
    expect(store.get().lastSeq).toBe(5);

    // Relay process restarts → new instanceId → client must NOT trust seq 5.
    sockets[0].emitClose();
    const reconnect = client.connect();
    await Promise.resolve();
    const second = sockets[1];
    second.openSocket();
    await Promise.resolve();
    second.respondTo("session.hello", { ...WELCOME, instanceId: "inst-2" });
    await reconnect;
    second.respondTo("employees.list", { employees: [] });
    second.respondTo("channels.list", { channels: [] });
    second.respondTo("conversations.list", { conversations: [] });
    await Promise.resolve();
    await Promise.resolve();

    const subscribe = second.sent
      .map(
        (raw) =>
          JSON.parse(raw) as {
            method?: string;
            params?: { afterSeq?: number };
          },
      )
      .find((f) => f.method === "channel.subscribe");
    expect(subscribe?.params?.afterSeq).toBeUndefined();
  });
});
