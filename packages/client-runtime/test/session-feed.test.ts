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
  emitClose(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.fire("close", { code, reason } as never);
  }
  private fire(type: string, event?: never): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

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
  /** All request frames sent for a method, in order. */
  requestsOf(method: string) {
    return this.sent
      .map(
        (raw) =>
          JSON.parse(raw) as { id?: string; method?: string; params?: unknown },
      )
      .filter((f) => f.method === method && f.id !== undefined);
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

/* The request -> resolve -> .then -> atom chain needs a macrotask hop —
   one microtask is too shallow. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/* The directory row behind every feed this file opens — conv-1 is the
   known conversation (#596's gone gate reads the synced directory). */
const CONV = {
  id: "conv-1",
  channelId: "ch-1",
  rootMessageId: "m1",
  engineRef: "sess-1",
  state: "active",
  title: "hi",
  titleSource: "auto",
  archived: false,
  deliveredSeq: 1,
  createdAt: 0,
};

/* refreshDirectory awaits all of these on (re)connect — answer the lot so
   a test client lands `directoryReady` the way the real app does. */
const answerDirectory = (socket: FakeSocket) => {
  socket.respondTo("employees.list", { employees: [] });
  socket.respondTo("channels.list", { channels: [] });
  socket.respondTo("conversations.list", { conversations: [CONV] });
  socket.respondTo("conversations.summaries", { summaries: [] });
  socket.respondTo("profile.get", { profile: {} });
  socket.respondTo("devices.list", { devices: [] });
  socket.respondTo("asks.list", { asks: [] });
};

async function connectClient(client: RelayClient, socket: FakeSocket) {
  const pending = client.connect();
  await flush();
  socket.openSocket();
  await flush();
  socket.respondTo("session.hello", WELCOME);
  await pending;
  answerDirectory(socket);
  await flush();
}

const ev = (seq: number, over: Record<string, unknown> = {}) => ({
  seq,
  sessionId: "sess-1",
  type: "turn.delta",
  payload: { turnId: "t1", stream: "text", delta: `d${seq}` },
  ...over,
});
const SNAPSHOT = { sessionId: "sess-1", state: "working", openRequests: [] };

describe("AC-1 sessionFeed — conversation-scoped engine feed (#157)", () => {
  it("replays via session.events, then merges live engine.event frames", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, socket);

    const feed = client.sessionFeed("conv-1");
    expect(feed.get().synced).toBe(false);
    socket.respondTo("session.events", {
      events: [ev(1), ev(2)],
      latestSeq: 2,
      truncated: false,
      openRequests: [],
      snapshot: SNAPSHOT,
    });
    await flush();
    expect(feed.get().synced).toBe(true);
    expect(feed.get().events.map((e) => e.seq)).toEqual([1, 2]);
    expect(feed.get().sessionId).toBe("sess-1");
    expect(feed.get().coverageSeq).toBe(2);

    // A live frame appends; a replayed duplicate of it does not.
    socket.emit({
      jsonrpc: "2.0",
      method: "engine.event",
      params: {
        channelId: "ch-1",
        conversationId: "conv-1",
        sessionId: "sess-1",
        event: ev(3),
      },
    });
    socket.emit({
      jsonrpc: "2.0",
      method: "engine.event",
      params: {
        channelId: "ch-1",
        conversationId: "conv-1",
        sessionId: "sess-1",
        event: ev(3),
      },
    });
    expect(feed.get().events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(feed.get().coverageSeq).toBe(3);
  });

  it("reconnect replays from the watermark (no full reload)", async () => {
    const { client, socket } = makeClient({ autoReconnect: false });
    await connectClient(client, socket);
    const feed = client.sessionFeed("conv-1");
    socket.respondTo("session.events", {
      events: [ev(1), ev(2)],
      latestSeq: 2,
      truncated: false,
      openRequests: [],
      snapshot: SNAPSHOT,
    });
    await flush();

    // Disconnect → connect() again → resync re-sends session.events after:2.
    socket.emitClose();
    const pending = client.connect();
    await flush();
    socket.openSocket();
    await flush();
    socket.respondTo("session.hello", WELCOME);
    await pending;
    answerDirectory(socket);
    const replays = socket.requestsOf("session.events");
    expect(replays).toHaveLength(2);
    expect(replays[1]?.params).toMatchObject({
      conversationId: "conv-1",
      after: 2,
    });
    socket.respondTo("session.events", {
      events: [ev(3)],
      latestSeq: 3,
      truncated: false,
      openRequests: [],
      snapshot: SNAPSHOT,
    });
    await flush();
    expect(feed.get().events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("a frame arriving before the replay is kept, deduped by sessionId|seq", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, socket);
    const feed = client.sessionFeed("conv-1");
    // Live frame beats the replay round trip.
    socket.emit({
      jsonrpc: "2.0",
      method: "engine.event",
      params: {
        channelId: "ch-1",
        conversationId: "conv-1",
        sessionId: "sess-1",
        event: ev(5),
      },
    });
    socket.respondTo("session.events", {
      events: [ev(4), ev(5)],
      latestSeq: 5,
      truncated: false,
      openRequests: [],
      snapshot: SNAPSHOT,
    });
    await flush();
    expect(feed.get().events.map((e) => e.seq)).toEqual([4, 5]);
  });

  it("a rebound session resets seq space — same seq on a new sessionId isn't dropped", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, socket);
    const feed = client.sessionFeed("conv-1");
    socket.respondTo("session.events", {
      events: [ev(1)],
      latestSeq: 1,
      truncated: false,
      openRequests: [],
      snapshot: SNAPSHOT,
    });
    await flush();
    socket.emit({
      jsonrpc: "2.0",
      method: "engine.event",
      params: {
        channelId: "ch-1",
        conversationId: "conv-1",
        sessionId: "sess-2",
        event: { ...ev(1), sessionId: "sess-2" },
      },
    });
    const got = feed.get();
    expect(got.sessionId).toBe("sess-2");
    expect(got.events.map((e) => `${e.sessionId}:${e.seq}`)).toEqual([
      "sess-1:1",
      "sess-2:1",
    ]);
  });

  it("not_found = no engine bound yet: a synced, empty feed", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, socket);
    const feed = client.sessionFeed("conv-1");
    socket.failTo("session.events", {
      code: -32001,
      message: "not_found",
      data: { code: "not_found" },
    });
    await flush();
    expect(feed.get().synced).toBe(true);
    expect(feed.get().events).toEqual([]);
  });

  it("a conversation gaining engineRef resyncs an empty feed", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, socket);
    const feed = client.sessionFeed("conv-1");
    socket.failTo("session.events", {
      code: -32001,
      message: "not_found",
      data: { code: "not_found" },
    });
    await flush();
    expect(feed.get().synced).toBe(true);

    socket.emit({
      jsonrpc: "2.0",
      method: "conversation.updated",
      params: {
        channelId: "ch-1",
        conversation: {
          id: "conv-1",
          channelId: "ch-1",
          rootMessageId: "m1",
          engineRef: "sess-1",
          state: "active",
          title: "hi",
          titleSource: "auto",
          archived: false,
          deliveredSeq: 1,
          createdAt: 0,
        },
      },
    });
    const replay = socket.requestsOf("session.events").at(-1);
    expect(replay?.params).toMatchObject({
      conversationId: "conv-1",
      after: 0,
    });
  });

  it("a rebind while disconnected replays the new session's full log", async () => {
    const { client, socket } = makeClient({ autoReconnect: false });
    await connectClient(client, socket);
    const feed = client.sessionFeed("conv-1");
    socket.respondTo("session.events", {
      events: [ev(1), ev(2), ev(3), ev(4), ev(5)],
      latestSeq: 5,
      truncated: false,
      openRequests: [],
      snapshot: SNAPSHOT,
    });
    await flush();
    expect(feed.get().coverageSeq).toBe(5);

    // The host rebinds conv-1 to sess-2 while the phone is away; seq
    // restarts at 1 in the new session's space.
    socket.emitClose();
    const pending = client.connect();
    await flush();
    socket.openSocket();
    await flush();
    socket.respondTo("session.hello", WELCOME);
    await pending;
    answerDirectory(socket);
    await flush();

    // The resync sent `after: 5` — in sess-1's space — but the relay answers
    // scoped to the now-bound sess-2: a stale watermark would skip its head.
    const SNAPSHOT2 = { ...SNAPSHOT, sessionId: "sess-2" };
    socket.respondTo("session.events", {
      events: [
        { ...ev(6), sessionId: "sess-2" },
        { ...ev(7), sessionId: "sess-2" },
      ],
      latestSeq: 7,
      truncated: false,
      openRequests: [],
      snapshot: SNAPSHOT2,
    });
    await flush();
    const replays = socket.requestsOf("session.events");
    expect(replays.at(-1)?.params).toMatchObject({
      conversationId: "conv-1",
      after: 0,
    });
    socket.respondTo("session.events", {
      events: [1, 2, 3, 4, 5, 6, 7].map((s) => ({
        ...ev(s),
        sessionId: "sess-2",
      })),
      latestSeq: 7,
      truncated: false,
      openRequests: [],
      snapshot: SNAPSHOT2,
    });
    await flush();
    const got = feed.get();
    expect(got.sessionId).toBe("sess-2");
    expect(got.coverageSeq).toBe(7);
    expect(
      got.events.filter((e) => e.sessionId === "sess-2").map((e) => e.seq),
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(
      got.events.filter((e) => e.sessionId === "sess-1").map((e) => e.seq),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("a skipped live seq refetches the hole instead of stalling forever (#400)", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, socket);
    const feed = client.sessionFeed("conv-1");
    socket.respondTo("session.events", {
      events: [ev(1), ev(2)],
      latestSeq: 2,
      truncated: false,
      openRequests: [],
      snapshot: SNAPSHOT,
    });
    await flush();
    expect(feed.get().coverageSeq).toBe(2);

    // seq 3 was lost in a broadcast window; seq 4 arrives live.
    socket.emit({
      jsonrpc: "2.0",
      method: "engine.event",
      params: {
        channelId: "ch-1",
        conversationId: "conv-1",
        sessionId: "sess-1",
        event: ev(4),
      },
    });
    await flush();
    expect(feed.get().events.map((e) => e.seq)).toEqual([1, 2, 4]);
    // The stall triggered a second replay covering the gap.
    const replays = socket.requestsOf("session.events");
    expect(replays).toHaveLength(2);
    expect(replays.at(-1)?.params).toMatchObject({ after: 2 });
    socket.respondTo("session.events", {
      events: [ev(3), ev(4)],
      latestSeq: 4,
      truncated: false,
      openRequests: [],
      snapshot: SNAPSHOT,
    });
    await flush();
    expect(feed.get().events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(feed.get().coverageSeq).toBe(4);
  });

  it("#596 a thread the synced directory doesn't know never fetches — not on open, not on reconnect", async () => {
    const { client, socket } = makeClient();
    await connectClient(client, socket);
    expect(client.directoryReady.get()).toBe(true);

    /* The deep link's id is simply absent: the feed settles synced-and-
       empty with no session.events round trip at all — before this gate
       it got `not_found` at open, then re-pulled on every reconnect
       forever (the gone card's HUD kept counting). */
    const feed = client.sessionFeed("conv-gone");
    await flush();
    expect(feed.get().synced).toBe(true);
    expect(socket.requestsOf("session.events")).toHaveLength(0);

    socket.emitClose();
    const pending = client.connect();
    await flush();
    socket.openSocket();
    await flush();
    socket.respondTo("session.hello", WELCOME);
    await pending;
    answerDirectory(socket);
    await flush();
    expect(socket.requestsOf("session.events")).toHaveLength(0);

    /* The gate is a skip, not a tombstone: if the conversation appears
       after all (a conversation.updated lands while the feed lives),
       the feed syncs like any fresh one. */
    socket.emit({
      jsonrpc: "2.0",
      method: "conversation.updated",
      params: {
        channelId: "ch-1",
        conversation: { ...CONV, id: "conv-gone" },
      },
    });
    await flush();
    const replay = socket.requestsOf("session.events").at(-1);
    expect(replay?.params).toMatchObject({
      conversationId: "conv-gone",
      after: 0,
    });
  });
});
