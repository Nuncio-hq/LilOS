import { describe, expect, it, vi } from "vitest";
import { RelayClient } from "../src/client";
import { DEVICE_CACHE_SCHEMA_VERSION } from "../src/device-cache";
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
  emitClose(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.fire("close", { code, reason } as never);
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

  it("AC-3 employee.upserted broadcasts append and update the employees atom", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, () => socket);
    const employee = {
      id: "emp_1",
      name: "Ada",
      role: "eng",
      status: "online",
      profile: "default",
      model: "fake-small",
      now: "",
      instructions: "",
      respondTo: "me",
      createdAt: 0,
    };
    socket.emit({
      jsonrpc: "2.0",
      method: "employee.upserted",
      params: { employee },
    });
    expect(client.employees.get().map((e) => e.id)).toEqual(["emp_1"]);

    socket.emit({
      jsonrpc: "2.0",
      method: "employee.upserted",
      params: { employee: { ...employee, name: "Renamed" } },
    });
    expect(client.employees.get()).toHaveLength(1);
    expect(client.employees.get()[0]?.name).toBe("Renamed");
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

  it("keeps tombstone rows a resync snapshot omits (#377)", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, () => socket);
    const store = client.channelMessages("ch1");
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
            text: "remove me",
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
    socket.emit({
      jsonrpc: "2.0",
      method: "message.changed",
      params: {
        channelId: "ch1",
        message: {
          id: "m2",
          channelId: "ch1",
          conversationId: null,
          authorId: "u",
          authorKind: "user",
          text: "remove me",
          seq: 2,
          createdAt: 0,
          removed: true,
        },
      },
    });
    expect(store.get().messages.find((m) => m.id === "m2")?.removed).toBe(true);

    // Relay restart → instanceId changes → resync via channel.snapshot; the
    // read layer omits removed rows, so the snapshot can't carry m2's flag.
    socket.emit({
      jsonrpc: "2.0",
      method: "channel.snapshot",
      params: {
        channelId: "ch1",
        lastSeq: 3,
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
            id: "m3",
            channelId: "ch1",
            conversationId: null,
            authorId: "u",
            authorKind: "user",
            text: "new",
            seq: 3,
            createdAt: 0,
          },
        ],
      },
    });
    const messages = store.get().messages;
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(messages.find((m) => m.id === "m2")?.removed).toBe(true);
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

describe("relay -> app requests + employee lifecycle (#29)", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const empFixture = (over: Record<string, unknown> = {}) => ({
    id: "e1",
    name: "Ada",
    role: "eng",
    status: "online" as const,
    profile: "reviewer",
    model: "fake-large",
    now: "idle",
    instructions: "",
    respondTo: "me" as const,
    createdAt: 1,
    ...over,
  });
  const lastSent = (socket: FakeSocket, id: string) =>
    socket.sent
      .map((raw) => JSON.parse(raw) as { id?: string })
      .find((f) => f.id === id);

  it("answers an inbound request frame through onRequest", async () => {
    const { client, socket } = makeClient({
      onRequest: async (method, params) => ({ echo: method, params }),
    });
    await connectClient(client, () => socket);

    socket.emit({
      jsonrpc: "2.0",
      id: "srv1",
      method: "agents.list",
      params: { verbose: true },
    });
    await flush();
    expect(lastSent(socket, "srv1")).toEqual({
      jsonrpc: "2.0",
      id: "srv1",
      result: { echo: "agents.list", params: { verbose: true } },
    });
  });

  it("replies -32601 when no request handler is set", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, () => socket);
    socket.emit({ jsonrpc: "2.0", id: "srv2", method: "agents.list" });
    await flush();
    const reply = lastSent(socket, "srv2") as { error?: { code: number } };
    expect(reply.error?.code).toBe(-32601);
  });

  it("passes a thrown handler error's code/message through to the relay", async () => {
    const { client, socket } = makeClient({
      onRequest: async () => {
        const e = new Error("engine not connected") as Error & {
          code: number;
        };
        e.code = -32005;
        throw e;
      },
    });
    await connectClient(client, () => socket);
    socket.emit({ jsonrpc: "2.0", id: "srv3", method: "agents.list" });
    await flush();
    const reply = lastSent(socket, "srv3") as {
      error?: { code: number; message: string };
    };
    expect(reply.error?.code).toBe(-32005);
    expect(reply.error?.message).toBe("engine not connected");
  });

  it("hire/edit/remove helpers keep the employees atom in sync", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, () => socket);

    const ada = empFixture();
    const hire = client.createEmployee({
      name: "Ada",
      role: "eng",
      profile: "reviewer",
    });
    socket.respondTo("employees.create", { employee: ada });
    expect(await hire).toEqual(ada);
    expect(client.employees.get()).toEqual([ada]);

    const renamed = { ...ada, name: "Ada Lovelace" };
    const update = client.updateEmployee("e1", { name: "Ada Lovelace" });
    socket.respondTo("employees.update", { employee: renamed });
    expect(await update).toEqual(renamed);
    expect(client.employees.get()[0]?.name).toBe("Ada Lovelace");

    const remove = client.removeEmployee("e1");
    socket.respondTo("employees.remove", { ok: true });
    await remove;
    expect(client.employees.get()).toEqual([]);
  });

  it("employee.upserted / employee.removed notifications update the atom", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, () => socket);
    const ada = empFixture();

    socket.emit({
      jsonrpc: "2.0",
      method: "employee.upserted",
      params: { employee: ada },
    });
    expect(client.employees.get()).toEqual([ada]);

    socket.emit({
      jsonrpc: "2.0",
      method: "employee.upserted",
      params: { employee: { ...ada, name: "Ada 2" } },
    });
    expect(client.employees.get()).toEqual([{ ...ada, name: "Ada 2" }]);

    socket.emit({
      jsonrpc: "2.0",
      method: "employee.removed",
      params: { employeeId: "e1" },
    });
    expect(client.employees.get()).toEqual([]);
  });

  it("channel.removed drops the channel, its conversations, and message state", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, () => socket);
    socket.emit({
      jsonrpc: "2.0",
      method: "channel.created",
      params: {
        channel: {
          id: "c1",
          kind: "dm",
          employeeId: "e1",
          lastSeq: 0,
          createdAt: 1,
        },
      },
    });
    socket.emit({
      jsonrpc: "2.0",
      method: "channel.created",
      params: {
        channel: {
          id: "c2",
          kind: "dm",
          employeeId: "e2",
          lastSeq: 0,
          createdAt: 2,
        },
      },
    });
    socket.emit({
      jsonrpc: "2.0",
      method: "conversation.updated",
      params: {
        channelId: "c1",
        conversation: {
          id: "conv1",
          channelId: "c1",
          rootMessageId: "m1",
          engineRef: null,
          state: "idle",
          title: "",
          archived: false,
          createdAt: 3,
        },
      },
    });
    socket.emit({
      jsonrpc: "2.0",
      method: "conversation.updated",
      params: {
        channelId: "c2",
        conversation: {
          id: "conv2",
          channelId: "c2",
          rootMessageId: "m2",
          engineRef: null,
          state: "idle",
          title: "",
          archived: false,
          createdAt: 4,
        },
      },
    });
    const store = client.channelMessages("c1");

    socket.emit({
      jsonrpc: "2.0",
      method: "channel.removed",
      params: { channelId: "c1" },
    });
    expect(client.channels.get().map((c) => c.id)).toEqual(["c2"]);
    expect(client.conversations.get().map((c) => c.id)).toEqual(["conv2"]);
    expect(store.get().messages).toEqual([]);
    expect(store.get().synced).toBe(false);
  });

  /* #134 AC-2: `conversation.rewound` drops every message at/after the
     rewind point from the channel store — other conversations' messages
     stay — and records the point so views holding fetched history re-render
     without the tail. */
  it("AC-2 conversation.rewound drops the tail and stamps rewinds", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, () => socket);
    const store = client.channelMessages("ch1");
    await Promise.resolve();
    const mk = (id: string, seq: number, conv: string | null) => ({
      id,
      channelId: "ch1",
      conversationId: conv,
      authorId: "u",
      authorKind: "user" as const,
      text: id,
      seq,
      createdAt: seq,
    });
    socket.emit({
      jsonrpc: "2.0",
      method: "channel.snapshot",
      params: {
        channelId: "ch1",
        lastSeq: 4,
        messages: [
          mk("m1", 1, "conv1"),
          mk("m2", 2, "conv1"),
          mk("m3", 3, "conv1"),
          mk("o1", 4, "conv2"),
        ],
      },
    });
    socket.emit({
      jsonrpc: "2.0",
      method: "channel.synced",
      params: { channelId: "ch1", lastSeq: 4 },
    });
    expect(store.get().messages.map((m) => m.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "o1",
    ]);

    socket.emit({
      jsonrpc: "2.0",
      method: "conversation.rewound",
      params: {
        channelId: "ch1",
        conversationId: "conv1",
        fromSeq: 2,
        messageId: "m2",
        removedIds: ["m2", "m3"],
        engineRewound: true,
      },
    });

    expect(store.get().messages.map((m) => m.id)).toEqual(["m1", "o1"]);
    expect(client.rewinds.get()).toEqual({
      conv1: { fromSeq: 2, removedIds: ["m2", "m3"] },
    });
    /* A second rewind of the same conversation supersedes the first point. */
    socket.emit({
      jsonrpc: "2.0",
      method: "conversation.rewound",
      params: {
        channelId: "ch1",
        conversationId: "conv1",
        fromSeq: 1,
        messageId: "m1",
        removedIds: ["m1"],
        engineRewound: false,
      },
    });
    expect(store.get().messages.map((m) => m.id)).toEqual(["o1"]);
    expect(client.rewinds.get()).toEqual({
      conv1: { fromSeq: 1, removedIds: ["m2", "m3", "m1"] },
    });
  });
});

describe("mobile instant-connect seam (#154)", () => {
  it("AC-1 sends the device credential variant of session.hello", async () => {
    const socket = new FakeSocket();
    const client = new RelayClient({
      url: "ws://fake",
      device: { deviceId: "dev_1", credential: "cred" },
      socketFactory: () => socket,
      autoReconnect: false,
    });
    const pending = client.connect();
    await Promise.resolve();
    socket.openSocket();
    await Promise.resolve();
    const hello = socket.sent
      .map((raw) => JSON.parse(raw) as { method?: string; params?: unknown })
      .find((f) => f.method === "session.hello");
    expect(hello?.params).toMatchObject({
      deviceId: "dev_1",
      credential: "cred",
    });
    expect(hello?.params).not.toHaveProperty("token");
    socket.respondTo("session.hello", WELCOME);
    await pending;
  });

  it("AC-4 session.ping answers on the live socket", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, () => socket);
    const ping = client.ping();
    const frame = socket.sent
      .map((raw) => JSON.parse(raw) as { method?: string })
      .find((f) => f.method === "session.ping");
    expect(frame).toBeDefined();
    socket.respondTo("session.ping", { ok: true, instanceId: "inst-1" });
    await expect(ping).resolves.toBeUndefined();
  });

  it("AC-1 a device peer never sends devices.list so the directory still populates", async () => {
    // devices.list is pairing-admin scope; the relay refuses it for device
    // peers. One refused frame must not void the whole resync batch — the
    // client authenticates as a device, so it skips the call entirely.
    const socket = new FakeSocket();
    const client = new RelayClient({
      url: "ws://fake",
      device: { deviceId: "dev_1", credential: "cred" },
      socketFactory: () => socket,
      requestTimeoutMs: 200,
      connectTimeoutMs: 200,
      autoReconnect: false,
    });
    const pending = client.connect();
    await Promise.resolve();
    socket.openSocket();
    await Promise.resolve();
    socket.respondTo("session.hello", WELCOME);
    await pending;
    socket.respondTo("employees.list", {
      employees: [
        {
          id: "e1",
          name: "Ada",
          role: "eng",
          status: "online",
          profile: "default",
          model: "fake-small",
          now: "",
          instructions: "",
        },
      ],
    });
    socket.respondTo("channels.list", { channels: [] });
    socket.respondTo("conversations.list", { conversations: [] });
    socket.respondTo("conversations.summaries", { summaries: [] });
    socket.respondTo("profile.get", { profile: {} });
    socket.respondTo("asks.list", { asks: [] });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    await flush();
    await flush();
    expect(client.directoryReady.get()).toBe(true);
    expect(client.employees.get().map((e) => e.id)).toEqual(["e1"]);
    const methods = socket.sent.map(
      (raw) => (JSON.parse(raw) as { method?: string }).method,
    );
    expect(methods).not.toContain("devices.list");
  });

  it("AC-2 hydrate seeds the directory and watermarks; subscribe resumes with afterSeq", async () => {
    const { client, socket } = makeClient();
    client.hydrate({
      schemaVersion: DEVICE_CACHE_SCHEMA_VERSION,
      savedAt: 1,
      employees: [
        {
          id: "e1",
          name: "Ada",
          role: "eng",
          status: "online",
          profile: "p",
          model: "m",
          now: "n",
          instructions: "",
          respondTo: "anyone",
          createdAt: 1,
        },
      ],
      channels: [
        { id: "ch1", kind: "dm", employeeId: "e1", lastSeq: 5, createdAt: 1 },
      ],
      conversations: [],
      conversationSummaries: [],
      profile: { userName: "Oscar" },
      asks: [],
      watermarks: { ch1: 5 },
    });
    // Cache-first: atoms render before the socket even exists.
    expect(client.employees.get().map((e) => e.name)).toEqual(["Ada"]);
    expect(client.profile.get().userName).toBe("Oscar");

    client.channelMessages("ch1"); // subscribed intent survives the reconnect
    await connectClient(client, () => socket);
    await Promise.resolve();
    await Promise.resolve();
    const subscribe = socket.sent
      .map(
        (raw) =>
          JSON.parse(raw) as {
            method?: string;
            params?: { afterSeq?: number };
          },
      )
      .find((f) => f.method === "channel.subscribe");
    expect(subscribe?.params?.afterSeq).toBe(5);
  });

  it("a revoked socket close (4403) surfaces device_revoked, not socket_closed", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, () => socket);

    socket.emitClose(4403, "device revoked");
    expect(client.state.get()).toBe("closed");
    expect(client.lastSocketError).toMatchObject({
      code: "device_revoked",
      message: "device revoked",
      data: { closeCode: 4403 },
    });
  });

  it("a plain transport close stays socket_closed and keeps the close code", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, () => socket);

    socket.emitClose(1006, "abnormal");
    expect(client.lastSocketError).toMatchObject({
      code: "socket_closed",
      data: { closeCode: 1006, closeReason: "abnormal" },
    });
  });

  it("AC-2 snapshot() exports exactly what hydrate() needs", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, () => socket);
    const snap = client.snapshot();
    expect(snap.schemaVersion).toBe(DEVICE_CACHE_SCHEMA_VERSION);
    expect(snap.employees).toEqual([]);
    expect(typeof snap.savedAt).toBe("number");

    const { client: cold } = makeClient();
    cold.hydrate(snap);
    expect(cold.snapshot()).toEqual({ ...snap, savedAt: expect.any(Number) });
  });
});

describe("asks read model (#155)", () => {
  const askFixture = (over: Record<string, unknown> = {}) => ({
    id: "ask_1",
    channelId: "ch1",
    conversationId: "conv1",
    turnId: "t1",
    requestId: "r1",
    request: {
      kind: "approval" as const,
      command: "patch README.md",
      options: ["once", "always", "deny"],
    },
    state: "open" as const,
    createdAt: 1,
    ...over,
  });

  /** Answer every directory read so the refresh fully lands. */
  const answerDirectory = (socket: FakeSocket, asks: unknown[] = []) => {
    socket.respondTo("employees.list", { employees: [] });
    socket.respondTo("channels.list", {
      channels: [
        { id: "ch1", kind: "dm", employeeId: "e1", lastSeq: 0, createdAt: 1 },
      ],
    });
    socket.respondTo("conversations.list", { conversations: [] });
    socket.respondTo("conversations.summaries", { summaries: [] });
    socket.respondTo("profile.get", { profile: {} });
    socket.respondTo("devices.list", { devices: [] });
    socket.respondTo("asks.list", { asks });
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("AC-3 asks.list seeds the asks atom; ask.opened/ask.resolved upsert live", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, () => socket);
    answerDirectory(socket, [askFixture()]);
    await flush();
    expect(client.asks.get().map((a) => a.id)).toEqual(["ask_1"]);

    const second = askFixture({ id: "ask_2", createdAt: 2 });
    socket.emit({
      jsonrpc: "2.0",
      method: "ask.opened",
      params: { channelId: "ch1", ask: second },
    });
    expect(client.asks.get().map((a) => a.id)).toEqual(["ask_1", "ask_2"]);

    socket.emit({
      jsonrpc: "2.0",
      method: "ask.resolved",
      params: {
        channelId: "ch1",
        ask: { ...second, state: "resolved", outcome: "once", resolvedAt: 3 },
      },
    });
    expect(client.asks.get().find((a) => a.id === "ask_2")?.state).toBe(
      "resolved",
    );

    // channel.subscribe replays the channel's ask set — dedupe by id.
    socket.emit({
      jsonrpc: "2.0",
      method: "ask.opened",
      params: { channelId: "ch1", ask: askFixture() },
    });
    expect(client.asks.get()).toHaveLength(2);
  });

  it("channel.removed drops the channel's asks", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, () => socket);
    answerDirectory(socket, [
      askFixture(),
      askFixture({ id: "ask_9", channelId: "ch2", createdAt: 2 }),
    ]);
    await flush();
    expect(client.asks.get()).toHaveLength(2);

    socket.emit({
      jsonrpc: "2.0",
      method: "channel.removed",
      params: { channelId: "ch1" },
    });
    expect(client.asks.get().map((a) => a.id)).toEqual(["ask_9"]);
  });

  it("AC-1 channel.synced re-pulls conversations: a turn that went active before subscribe still lands", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, () => socket);
    answerDirectory(socket);
    await flush();

    // A DM channel the app subscribes late — its conversation went active
    // between the directory refresh and the subscribe (no replay for it).
    client.channelMessages("ch1");
    socket.respondTo("channel.subscribe", { channel: { id: "ch1" } });
    socket.emit({
      jsonrpc: "2.0",
      method: "channel.synced",
      params: { channelId: "ch1", lastSeq: 0 },
    });
    socket.respondTo("conversations.list", {
      conversations: [
        {
          id: "conv_live",
          channelId: "ch1",
          rootMessageId: "m1",
          engineRef: null,
          state: "active",
          title: "summarize the repo layout",
          titleSource: "auto",
          archived: false,
          deliveredSeq: 1,
          createdAt: 2,
        },
      ],
    });
    await flush();
    expect(client.conversations.get().map((c) => c.id)).toEqual(["conv_live"]);
  });
});

describe("directory refresh for a paired phone", () => {
  const employee = {
    id: "emp_1",
    name: "Ada",
    role: "eng",
    status: "online",
    profile: "default",
    model: "fake-small",
    now: "",
    instructions: "",
    respondTo: "me",
    createdAt: 0,
  };

  /** Answers every directory read like the relay does for a device peer. */
  async function refreshAsPhone(device?: {
    deviceId: string;
    credential: string;
  }) {
    const { client, socket } = makeClient(device ? { device } : {});
    const pending = client.connect();
    await Promise.resolve();
    socket.openSocket();
    await Promise.resolve();
    socket.respondTo("session.hello", WELCOME);
    await pending;
    socket.respondTo("employees.list", { employees: [employee] });
    socket.respondTo("channels.list", { channels: [] });
    socket.respondTo("conversations.list", { conversations: [] });
    socket.respondTo("conversations.summaries", { summaries: [] });
    socket.respondTo("profile.get", { profile: { name: "", company: "" } });
    socket.respondTo("asks.list", { asks: [] });
    const askedDevices = socket.sent.some(
      (raw) =>
        (JSON.parse(raw) as { method?: string }).method === "devices.list",
    );
    if (askedDevices)
      socket.failTo("devices.list", {
        code: -32003,
        message: "forbidden",
        data: { code: "forbidden" },
      });
    await new Promise((r) => setTimeout(r, 0));
    return { client, askedDevices };
  }

  it("a phone (device credential) gets employees even though devices.list is admin-only", async () => {
    const { client, askedDevices } = await refreshAsPhone({
      deviceId: "dev_1",
      credential: "devcred_x",
    });
    expect(askedDevices).toBe(false);
    expect(client.employees.get().map((e) => e.id)).toEqual(["emp_1"]);
    expect(client.directoryReady.get()).toBe(true);
  });

  it("a refused devices.list never blanks the directory", async () => {
    const { client, askedDevices } = await refreshAsPhone();
    expect(askedDevices).toBe(true);
    expect(client.employees.get().map((e) => e.id)).toEqual(["emp_1"]);
    expect(client.directoryReady.get()).toBe(true);
  });
});

describe("#571 incremental conversation summaries", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  const mkMsg = (over: Record<string, unknown> = {}) => ({
    id: "m-x",
    channelId: "ch1",
    conversationId: "conv1",
    authorId: "me",
    authorKind: "user",
    text: "hi",
    seq: 3,
    createdAt: 3,
    ...over,
  });
  const mkSummary = (
    convId: string,
    over: Record<string, unknown> = {},
    msgOver: Record<string, unknown> = {},
    rootOver: Record<string, unknown> = {},
  ) => ({
    conversation: {
      id: convId,
      channelId: "ch1",
      rootMessageId: `${convId}-root`,
      engineRef: null,
      state: "idle",
      title: convId,
      titleSource: "auto",
      archived: false,
      deliveredSeq: 0,
      createdAt: 1,
    },
    root: mkMsg({
      id: `${convId}-root`,
      conversationId: convId,
      seq: 1,
      ...rootOver,
    }),
    last: mkMsg({
      id: `${convId}-last`,
      conversationId: convId,
      seq: 2,
      ...msgOver,
    }),
    messageCount: 2,
    ...over,
  });

  /** Connects and answers every directory read with `summaries` seeded. */
  async function connectWithSummaries(summaries: unknown[]) {
    const { client, socket } = makeClient();
    const pending = client.connect();
    await Promise.resolve();
    socket.openSocket();
    await Promise.resolve();
    socket.respondTo("session.hello", WELCOME);
    await pending;
    socket.respondTo("employees.list", { employees: [] });
    socket.respondTo("channels.list", { channels: [] });
    socket.respondTo("conversations.list", { conversations: [] });
    socket.respondTo("conversations.summaries", { summaries });
    socket.respondTo("profile.get", { profile: {} });
    socket.respondTo("asks.list", { asks: [] });
    socket.respondTo("devices.list", { devices: [] });
    await flush();
    socket.sent.length = 0;
    return { client, socket };
  }
  const summaryRequests = (socket: FakeSocket) =>
    socket.sent
      .map((raw) => JSON.parse(raw) as { method?: string; params?: unknown })
      .filter((f) => f.method === "conversations.summaries");

  it("a new message patches last/count in place — no fetch", async () => {
    const { client, socket } = await connectWithSummaries([mkSummary("conv1")]);
    socket.emit({
      jsonrpc: "2.0",
      method: "message.created",
      params: {
        channelId: "ch1",
        message: mkMsg({ id: "m3", seq: 3, text: "newest" }),
      },
    });
    const [s] = client.conversationSummaries.get();
    expect(s.last.text).toBe("newest");
    expect(s.last.seq).toBe(3);
    expect(s.messageCount).toBe(3);
    expect(summaryRequests(socket)).toHaveLength(0);
  });

  it("a long incoming message gets the 500-char preview cap locally", async () => {
    const { client, socket } = await connectWithSummaries([mkSummary("conv1")]);
    socket.emit({
      jsonrpc: "2.0",
      method: "message.created",
      params: {
        channelId: "ch1",
        message: mkMsg({
          id: "m3",
          seq: 3,
          authorKind: "employee",
          text: `A${"y".repeat(600)}`,
        }),
      },
    });
    const [s] = client.conversationSummaries.get();
    expect(s.last.text).toHaveLength(500);
    expect(s.last.truncated).toBe(true);
    /* First non-user reply initializes firstAnswer too. */
    expect(s.firstAnswer?.text).toHaveLength(500);
    expect(summaryRequests(socket)).toHaveLength(0);
  });

  it("a message for an unknown conversation fetches one scoped summary", async () => {
    const { client, socket } = await connectWithSummaries([mkSummary("conv1")]);
    socket.emit({
      jsonrpc: "2.0",
      method: "message.created",
      params: {
        channelId: "ch1",
        message: mkMsg({ id: "m1", conversationId: "conv2", seq: 9 }),
      },
    });
    const reqs = summaryRequests(socket);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].params).toEqual({
      conversationId: "conv2",
      includeArchived: true,
    });
    socket.respondTo("conversations.summaries", {
      summaries: [mkSummary("conv2", {}, { id: "m1", seq: 9 })],
    });
    await flush();
    expect(
      client.conversationSummaries.get().map((s) => s.conversation.id),
    ).toEqual(["conv1", "conv2"]);
  });

  it("a dropped/removed flag flip refetches only that conversation", async () => {
    const { socket } = await connectWithSummaries([
      mkSummary("conv1"),
      mkSummary("conv2"),
    ]);
    socket.emit({
      jsonrpc: "2.0",
      method: "message.changed",
      params: {
        channelId: "ch1",
        message: mkMsg({
          id: "m2",
          conversationId: "conv2",
          seq: 2,
          dropped: true,
        }),
        flags: ["dropped"],
      },
    });
    const reqs = summaryRequests(socket);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].params).toEqual({
      conversationId: "conv2",
      includeArchived: true,
    });
  });

  it("a claimed-only flag flip does not refetch the summary", async () => {
    const { socket } = await connectWithSummaries([mkSummary("conv1")]);
    socket.emit({
      jsonrpc: "2.0",
      method: "message.changed",
      params: {
        channelId: "ch1",
        message: mkMsg({
          id: "m2",
          conversationId: "conv1",
          seq: 2,
          claimed: true,
        }),
        flags: ["claimed"],
      },
    });
    expect(summaryRequests(socket)).toHaveLength(0);
  });

  /* #134 AC-5 regression: the relay emits `conversation.rewound`, then
     posts the "Rewound to before…" note as `message.created` — both before
     it ever sees the scoped summaries request the first event sent. The
     note's local patch must not cancel that fetch: the response carries
     `root.rewound`, the flag that keeps the dead root off the open
     thread (a stale copy renders it as the row). */
  it("the rewind note's patch must not cancel the scoped refetch", async () => {
    const { client, socket } = await connectWithSummaries([mkSummary("conv1")]);
    socket.emit({
      jsonrpc: "2.0",
      method: "conversation.rewound",
      params: {
        channelId: "ch1",
        conversationId: "conv1",
        fromSeq: 1,
        messageId: "conv1-root",
        removedIds: ["conv1-root", "conv1-last"],
        engineRewound: true,
      },
    });
    socket.emit({
      jsonrpc: "2.0",
      method: "message.created",
      params: {
        channelId: "ch1",
        message: mkMsg({
          id: "note1",
          conversationId: "conv1",
          authorKind: "system",
          seq: 4,
          text: "Rewound to before your message — 2 messages dropped.",
        }),
      },
    });
    expect(summaryRequests(socket)).toHaveLength(1);
    /* The note's patch is optimistic; the response is the authority. */
    socket.respondTo("conversations.summaries", {
      summaries: [
        mkSummary(
          "conv1",
          { messageCount: 1 },
          {
            id: "note1",
            seq: 4,
            authorKind: "system",
            text: "Rewound to before your message — 2 messages dropped.",
          },
          { rewound: true },
        ),
      ],
    });
    await flush();
    const [s] = client.conversationSummaries.get();
    expect(s.root.rewound).toBe(true);
    expect(s.last.text).toBe(
      "Rewound to before your message — 2 messages dropped.",
    );
    expect(s.messageCount).toBe(1);
  });

  /* #666: `conversation.updated` rides the channel subscription only — a
     frame emitted between the directory read and the subscribe going live
     is lost for good, and nothing re-reads the summary's embedded
     conversation. The post-sync conversations re-pull must heal
     `s.conversation` too, or a reloaded DM row keeps its stale copy
     forever — the ac-583 dark-leg flake: a finished turn's `turnFailure`
     never lands on the row. */
  it("channel.synced heals the summary's embedded conversation (#666)", async () => {
    const staleConv = {
      id: "conv1",
      channelId: "ch1",
      rootMessageId: "conv1-root",
      engineRef: "sess_1",
      state: "active",
      title: "conv1",
      titleSource: "auto",
      archived: false,
      deliveredSeq: 0,
      createdAt: 1,
    };
    const freshConv = {
      ...staleConv,
      state: "idle",
      turnFailure: { kind: "model", text: "engine-fake: scripted failure" },
    };
    const { client, socket } = await connectWithSummaries([
      mkSummary("conv1", { conversation: staleConv }),
    ]);

    /* Subscribe → synced; the missed conversation.updated is never
       emitted — only the re-pull's fresh row can heal the copy. */
    client.channelMessages("ch1");
    socket.respondTo("channel.subscribe", { channel: { id: "ch1" } });
    socket.emit({
      jsonrpc: "2.0",
      method: "channel.synced",
      params: { channelId: "ch1", lastSeq: 0 },
    });
    socket.respondTo("conversations.list", {
      conversations: [
        freshConv,
        { ...staleConv, id: "conv2", rootMessageId: "conv2-root" },
      ],
    });
    /* The channel-scoped summaries re-pull carries the fresh row AND a
       conv opened inside the same gap (no row at all before). */
    socket.respondTo("conversations.summaries", {
      summaries: [
        mkSummary("conv1", { conversation: freshConv }),
        mkSummary("conv2"),
      ],
    });
    await flush();
    const [s] = client.conversationSummaries.get();
    expect(s.conversation.state).toBe("idle");
    expect(s.conversation.turnFailure?.text).toBe(
      "engine-fake: scripted failure",
    );
    expect(
      client.conversationSummaries.get().map((x) => x.conversation.id),
    ).toEqual(["conv1", "conv2"]);
    /* One channel-scoped pull — no per-conversation fetches. */
    const reqs = summaryRequests(socket);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].params).toEqual({
      channelId: "ch1",
      includeArchived: true,
    });
  });

  /* The one race a ticket does guard: two scoped fetches overlap because
     relay handlers interleave at awaits — the older response landing last
     must not roll the row back. */
  it("an older overlapping scoped response can't roll back a newer one", async () => {
    const { client, socket } = await connectWithSummaries([mkSummary("conv1")]);
    const flip = (id: string) =>
      socket.emit({
        jsonrpc: "2.0",
        method: "message.changed",
        params: {
          channelId: "ch1",
          message: mkMsg({
            id,
            conversationId: "conv1",
            seq: 2,
            removed: true,
          }),
          flags: ["removed"],
        },
      });
    flip("m2");
    flip("m2b");
    const reqs = summaryRequests(socket).map((f) => (f as { id?: string }).id);
    expect(reqs).toHaveLength(2);
    /* Newer request answers first… */
    socket.emit({
      jsonrpc: "2.0",
      id: reqs[1],
      result: {
        summaries: [mkSummary("conv1", {}, { text: "fresh", seq: 5 })],
      },
    });
    await flush();
    expect(client.conversationSummaries.get()[0].last.text).toBe("fresh");
    /* …then the older response lands — discarded, not applied. */
    socket.emit({
      jsonrpc: "2.0",
      id: reqs[0],
      result: {
        summaries: [mkSummary("conv1", {}, { text: "stale", seq: 4 })],
      },
    });
    await flush();
    expect(client.conversationSummaries.get()[0].last.text).toBe("fresh");
  });
});

describe("ws upgrade credential (#625)", () => {
  /* The relay authenticates the upgrade itself — a browser WebSocket can't
     set headers, so the credential rides the socket URL (`?token=` or
     `?deviceId=&credential=`), the same carrier the #564 feed gate uses. */
  it("the install token or device credential is appended to the socket URL", () => {
    const urls: string[] = [];
    const socket = new FakeSocket();
    const capture = (url: string) => {
      urls.push(url);
      return socket;
    };
    const tokenClient = new RelayClient({
      url: "ws://relay/ws",
      token: "tok",
      socketFactory: capture,
      connectTimeoutMs: 50,
      autoReconnect: false,
    });
    void tokenClient.connect().catch(() => {});
    const deviceClient = new RelayClient({
      url: "ws://relay/ws",
      device: { deviceId: "dev_1", credential: "cred x/y" },
      socketFactory: capture,
      connectTimeoutMs: 50,
      autoReconnect: false,
    });
    void deviceClient.connect().catch(() => {});
    expect(urls).toEqual([
      "ws://relay/ws?token=tok",
      "ws://relay/ws?deviceId=dev_1&credential=cred%20x%2Fy",
    ]);
    tokenClient.close();
    deviceClient.close();
  });

  /* The gate refuses with HTTP 401 — a socket-level error with no status
     reaches the client, so RelayClient probes /healthz once: reachable ⇒
     the credential was refused ⇒ `unauthenticated` (fatal, e.g. the
     revoked-phone re-pair flow); unreachable ⇒ transient connect_failed. */
  it("a refused upgrade reads unauthenticated when the relay's HTTP answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok")),
    );
    try {
      const { socket, client } = makeClient();
      const p = client.connect();
      socket.emitClose(1006, "");
      await expect(p).rejects.toMatchObject({ code: "unauthenticated" });
      expect(fetch).toHaveBeenCalledWith(
        "http://fake/healthz",
        expect.anything(),
      );
      expect(client.fatal.get()?.code).toBe("unauthenticated");
      client.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a refused upgrade stays connect_failed when the relay is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    try {
      const { socket, client } = makeClient();
      const p = client.connect();
      socket.emitClose(1006, "");
      await expect(p).rejects.toMatchObject({ code: "connect_failed" });
      expect(client.fatal.get()).toBeUndefined();
      client.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
