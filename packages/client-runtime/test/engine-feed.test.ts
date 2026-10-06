import { describe, expect, it, vi } from "vitest";
import { EngineClient } from "../src/engine.js";
import type { RelaySocket } from "../src/socket.js";

type StoredListener = (event: never) => void;

/** Minimal RelaySocket — same shape as client.test.ts's FakeSocket. */
class FakeSocket implements RelaySocket {
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, StoredListener[]>();

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

  openSocket(): void {
    this.readyState = 1;
    this.fire("open");
  }
  emit(frame: unknown): void {
    this.fire("message", { data: JSON.stringify(frame) } as never);
  }
  private fire(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener(event as never);
  }

  respondTo(method: string, result: unknown): void {
    const request = this.sent
      .map((raw) => JSON.parse(raw) as { id?: string; method?: string })
      .reverse()
      .find((f) => f.method === method && f.id !== undefined);
    if (!request) throw new Error(`no ${method} request was sent`);
    this.emit({ jsonrpc: "2.0", id: request.id, result });
  }
  /** True once a request frame for `method` went out (before it is answered). */
  sawRequest(method: string): boolean {
    return this.sent.some(
      (raw) => (JSON.parse(raw) as { method?: string }).method === method,
    );
  }
}

const DESCRIBE = {
  name: "engine-fake",
  version: "0.0.0",
  protocol: { name: "lilos-engine", version: 1 },
  capabilities: [],
};

const SNAPSHOT = { sessionId: "s1", state: "running" };

const APPROVAL = {
  kind: "approval" as const,
  command: "rm -rf node_modules",
  options: ["once", "deny"],
};

const openedEvent = (seq: number, requestId: string) => ({
  seq,
  sessionId: "s1",
  type: "request.opened",
  payload: { turnId: "t1", requestId, request: APPROVAL },
});

function makeClient() {
  const socket = new FakeSocket();
  const client = new EngineClient({
    url: "ws://fake",
    socketFactory: () => socket,
    autoReconnect: false,
    requestTimeoutMs: 1_000,
    connectTimeoutMs: 1_000,
  });
  return { socket, client };
}

async function connectClient(client: EngineClient, socket: FakeSocket) {
  const pending = client.connect();
  await Promise.resolve();
  socket.openSocket();
  await Promise.resolve();
  socket.respondTo("describe", DESCRIBE);
  await pending;
}

describe("#564 feed credential on the socket URL", () => {
  it.each<[string, string, string | undefined, string]>([
    [
      "appends ?token= to a bare endpoint",
      "ws://h/ws",
      "tok",
      "ws://h/ws?token=tok",
    ],
    [
      "uses & when the endpoint already carries a query",
      "ws://h/ws?x=1",
      "tok",
      "ws://h/ws?x=1&token=tok",
    ],
    [
      "encodes the credential",
      "ws://h/ws",
      "a b/c",
      "ws://h/ws?token=a%20b%2Fc",
    ],
    [
      "omits the param entirely without a token",
      "ws://h/ws",
      undefined,
      "ws://h/ws",
    ],
  ])("%s", (_name, url, token, expected) => {
    let seen = "";
    const socket = new FakeSocket();
    const client = new EngineClient({
      url,
      token,
      socketFactory: (u) => {
        seen = u;
        return socket;
      },
      autoReconnect: false,
      requestTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });
    void client.connect().catch(() => {});
    expect(seen).toBe(expected);
    client.close();
  });
});

describe("EngineClient session feed (#84 ac-32 race)", () => {
  it("keeps a live request.opened that lands while events.since is in flight", async () => {
    const { socket, client } = makeClient();
    await connectClient(client, socket);

    const feed = client.sessionFeed("s1");
    // sessionFeed kicked a resync — the events.since request is on the wire.
    await vi.waitFor(() =>
      expect(socket.sawRequest("events.since")).toBe(true),
    );

    // The losing ordering the e2e flake caught: a request.opened lands on
    // the live socket while the replay is in flight, then the replay result
    // (snapshotted before the open) overwrote openRequests and dropped it.
    socket.emit({
      jsonrpc: "2.0",
      method: "event",
      params: openedEvent(5, "r1"),
    });
    expect(feed.get().openRequests.map((r) => r.requestId)).toEqual(["r1"]);

    socket.respondTo("events.since", {
      events: [],
      latestSeq: 4,
      truncated: false,
      openRequests: [],
      snapshot: SNAPSHOT,
    });

    await vi.waitFor(() => expect(feed.get().synced).toBe(true));
    // The replay must not clobber the open ask that landed mid-flight.
    expect(feed.get().openRequests.map((r) => r.requestId)).toEqual(["r1"]);
    expect(feed.get().events.map((e) => e.seq)).toEqual([5]);
    expect(feed.get().latestSeq).toBe(5);
  });

  it("a live request.resolved landing mid-replay removes a replayed open ask", async () => {
    const { socket, client } = makeClient();
    await connectClient(client, socket);

    const feed = client.sessionFeed("s1");
    await vi.waitFor(() =>
      expect(socket.sawRequest("events.since")).toBe(true),
    );

    socket.emit({
      jsonrpc: "2.0",
      method: "event",
      params: {
        seq: 6,
        sessionId: "s1",
        type: "request.resolved",
        payload: { requestId: "r9", outcome: "deny" },
      },
    });
    socket.respondTo("events.since", {
      events: [openedEvent(5, "r9")],
      latestSeq: 5,
      truncated: false,
      openRequests: [
        { requestId: "r9", turnId: "t1", request: APPROVAL, seq: 5 },
      ],
      snapshot: SNAPSHOT,
    });

    await vi.waitFor(() => expect(feed.get().synced).toBe(true));
    expect(feed.get().openRequests).toEqual([]);
  });

  it("AC-1 a feed created before ready replays from 0, not the live watermark", async () => {
    const { socket, client } = makeClient();
    const pending = client.connect();
    await Promise.resolve();
    socket.openSocket();
    await Promise.resolve();

    /* Reload-mid-turn (#180): the feed atom exists while connect() is still
       resolving; live events bump latestSeq before the deferred resync. */
    const feed = client.sessionFeed("s1");
    socket.emit({
      jsonrpc: "2.0",
      method: "event",
      params: openedEvent(5, "r1"),
    });
    expect(feed.get().latestSeq).toBe(5);

    socket.respondTo("describe", DESCRIBE);
    await pending;
    await vi.waitFor(() =>
      expect(socket.sawRequest("events.since")).toBe(true),
    );
    /* after must be 0 — replaying from the live watermark (5) drops every
       earlier event: turn.started, early deltas, plan.updated. */
    const since = socket.sent
      .map(
        (raw) =>
          JSON.parse(raw) as { method?: string; params?: { after?: number } },
      )
      .find((f) => f.method === "events.since");
    expect(since?.params?.after).toBe(0);

    socket.respondTo("events.since", {
      events: [openedEvent(2, "r0"), openedEvent(5, "r1")],
      latestSeq: 5,
      truncated: false,
      openRequests: [
        { requestId: "r0", turnId: "t1", request: APPROVAL, seq: 2 },
        { requestId: "r1", turnId: "t1", request: APPROVAL, seq: 5 },
      ],
      snapshot: SNAPSHOT,
    });
    await vi.waitFor(() => expect(feed.get().synced).toBe(true));
    expect(feed.get().events.map((e) => e.seq)).toEqual([2, 5]);
    expect(feed.get().openRequests.map((r) => r.requestId)).toEqual([
      "r0",
      "r1",
    ]);
  });

  it("#179 retries a failed events.since instead of bricking the feed", async () => {
    vi.useFakeTimers();
    const { socket, client } = makeClient();
    try {
      await connectClient(client, socket);

      const feed = client.sessionFeed("s1");
      await vi.waitFor(() =>
        expect(socket.sawRequest("events.since")).toBe(true),
      );

      // A transient engine-link failure (the feed's ENGINE_DOWN code).
      const req = socket.sent
        .map((raw) => JSON.parse(raw) as { id?: string; method?: string })
        .reverse()
        .find((f) => f.method === "events.since" && f.id !== undefined);
      socket.emit({
        jsonrpc: "2.0",
        id: req?.id,
        error: { code: -32020, message: "engine not connected" },
      });
      await vi.waitFor(() => expect(feed.get().error).toBeTruthy());

      // First retry fires ~2s later and succeeds — the feed heals itself.
      await vi.advanceTimersByTimeAsync(2_100);
      socket.respondTo("events.since", {
        events: [
          {
            seq: 1,
            sessionId: "s1",
            type: "subagent.started",
            payload: {
              turnId: "t1",
              subagentId: "sa-1",
              name: "helper",
              task: "scan",
            },
          },
        ],
        latestSeq: 1,
        truncated: false,
        openRequests: [],
        snapshot: SNAPSHOT,
      });
      await vi.waitFor(() => expect(feed.get().synced).toBe(true));
      expect(feed.get().error).toBeUndefined();
      expect(feed.get().events.map((e) => e.type)).toEqual([
        "subagent.started",
      ]);
    } finally {
      client.close();
      vi.useRealTimers();
    }
  });

  it("#179 a session_not_found replay error is terminal — no retry", async () => {
    vi.useFakeTimers();
    const { socket, client } = makeClient();
    try {
      await connectClient(client, socket);

      const feed = client.sessionFeed("s1");
      await vi.waitFor(() =>
        expect(socket.sawRequest("events.since")).toBe(true),
      );
      const req = socket.sent
        .map((raw) => JSON.parse(raw) as { id?: string; method?: string })
        .reverse()
        .find((f) => f.method === "events.since" && f.id !== undefined);
      socket.emit({
        jsonrpc: "2.0",
        id: req?.id,
        error: { code: -32001, message: "session_not_found: no session s1" },
      });
      await vi.waitFor(() => expect(feed.get().error).toBeTruthy());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(
        socket.sent.filter((r) => r.includes("events.since")),
      ).toHaveLength(1);
    } finally {
      client.close();
      vi.useRealTimers();
    }
  });

  it("a live event landing before the first replay does not move the replay cursor", async () => {
    /* The ac-140 CI flake: the dm page subscribes a feed while the engine
       socket is still connecting. Frames landing in that window used to move
       `latestSeq`, and the first `events.since` then started mid-turn — the
       turn's prefix never arrived and it rendered as a partial phantom row. */
    const { socket, client } = makeClient();
    const feed = client.sessionFeed("s1"); // subscribed while still connecting
    const pending = client.connect();
    await Promise.resolve();
    socket.openSocket();
    await Promise.resolve();

    // Mid-turn: turn.started (seq 3) already went out before this socket
    // attached; only the tail arrives live. latestSeq jumps past the gap.
    socket.emit({
      jsonrpc: "2.0",
      method: "event",
      params: {
        seq: 7,
        sessionId: "s1",
        type: "turn.delta",
        payload: { turnId: "t1", stream: "text", delta: "tail " },
      },
    });
    expect(feed.get().latestSeq).toBe(7);
    expect(feed.get().coverageSeq).toBe(0);

    socket.respondTo("describe", DESCRIBE);
    await pending;
    await vi.waitFor(() =>
      expect(socket.sawRequest("events.since")).toBe(true),
    );

    // The replay must fetch from 0 — not from the live-inflated seq — or
    // seqs 1-6 are never delivered.
    const request = socket.sent
      .map(
        (raw) =>
          JSON.parse(raw) as { method?: string; params?: { after?: number } },
      )
      .find((f) => f.method === "events.since");
    expect(request?.params?.after).toBe(0);

    socket.respondTo("events.since", {
      events: [
        {
          seq: 1,
          sessionId: "s1",
          type: "session.started",
          payload: { agent: "default", cwd: "/w", model: "fake-fresh" },
        },
        {
          seq: 3,
          sessionId: "s1",
          type: "turn.started",
          payload: { turnId: "t1", model: "fake-fresh" },
        },
        {
          seq: 5,
          sessionId: "s1",
          type: "turn.delta",
          payload: { turnId: "t1", stream: "text", delta: "head " },
        },
        {
          seq: 9,
          sessionId: "s1",
          type: "turn.completed",
          payload: { turnId: "t1", stopReason: "end_turn" },
        },
      ],
      latestSeq: 9,
      truncated: false,
      openRequests: [],
      snapshot: SNAPSHOT,
    });

    await vi.waitFor(() => expect(feed.get().synced).toBe(true));
    expect(feed.get().events.map((e) => e.seq)).toEqual([1, 3, 5, 7, 9]);
    expect(feed.get().coverageSeq).toBe(9);
  });

  it("contiguous live events extend the coverage watermark; gaps stall it", async () => {
    /* After the first replay, in-order live events keep the watermark at
       latestSeq so a reconnect resync stays incremental. */
    const { socket, client } = makeClient();
    await connectClient(client, socket);
    const feed = client.sessionFeed("s1");
    await vi.waitFor(() =>
      expect(socket.sawRequest("events.since")).toBe(true),
    );
    socket.respondTo("events.since", {
      events: [],
      latestSeq: 4,
      truncated: false,
      openRequests: [],
      snapshot: SNAPSHOT,
    });
    await vi.waitFor(() => expect(feed.get().synced).toBe(true));
    expect(feed.get().coverageSeq).toBe(4);

    const delta = (seq: number) => ({
      jsonrpc: "2.0" as const,
      method: "event" as const,
      params: {
        seq,
        sessionId: "s1",
        type: "turn.delta",
        payload: { turnId: "t1", stream: "text", delta: "x" },
      },
    });
    socket.emit(delta(5));
    expect(feed.get().coverageSeq).toBe(5);
    // A skipped seq must not pretend the gap is covered — the next resync
    // refetches it.
    socket.emit(delta(8));
    expect(feed.get().coverageSeq).toBe(5);
    expect(feed.get().latestSeq).toBe(8);
  });
});

describe("EngineClient session feed (#431 truncated replay)", () => {
  it("a truncated answer on a nonzero watermark refetches from 0 and flags historyTrimmed", async () => {
    const { socket, client } = makeClient();
    await connectClient(client, socket);

    const feed = client.sessionFeed("s1");
    await vi.waitFor(() =>
      expect(socket.sawRequest("events.since")).toBe(true),
    );
    // First sync: coverage lands at 5.
    socket.respondTo("events.since", {
      events: [
        {
          seq: 5,
          sessionId: "s1",
          type: "turn.delta",
          payload: { turnId: "t1", stream: "text", delta: "x" },
        },
      ],
      latestSeq: 5,
      truncated: false,
      openRequests: [],
      snapshot: SNAPSHOT,
    });
    await vi.waitFor(() => expect(feed.get().coverageSeq).toBe(5));

    // Socket drop -> reconnect -> resync from coverageSeq. The engine's cap
    // dropped frames inside the range (droppedSeq > 5): truncated.
    (client as unknown as { resyncFeeds(): Promise<void> }).resyncFeeds();
    await vi.waitFor(() => {
      const reqs = socket.sent.filter((raw) => raw.includes("events.since"));
      expect(reqs.length).toBeGreaterThanOrEqual(2);
    });
    // Answer the coverage-watermark request with truncated.
    const coverageReq = socket.sent
      .map(
        (raw) =>
          JSON.parse(raw) as {
            id?: string;
            method?: string;
            params?: { after?: number };
          },
      )
      .reverse()
      .find((f) => f.method === "events.since" && f.params?.after === 5);
    expect(coverageReq).toBeTruthy();
    socket.emit({
      jsonrpc: "2.0",
      id: coverageReq?.id,
      result: {
        events: [],
        latestSeq: 9,
        truncated: true,
        openRequests: [],
        snapshot: SNAPSHOT,
      },
    });

    // The client must refetch the retained log from 0 rather than patch.
    await vi.waitFor(() => {
      const afterZero = socket.sent
        .map(
          (raw) =>
            JSON.parse(raw) as {
              method?: string;
              params?: { after?: number };
            },
        )
        .filter((f) => f.method === "events.since");
      expect(
        afterZero.filter((f) => f.params?.after === 0).length,
      ).toBeGreaterThanOrEqual(2);
    });
    const retainedTail = [
      {
        seq: 7,
        sessionId: "s1",
        type: "turn.recap",
        payload: { turnId: "t1", text: "whole turn", reasoning: "" },
      },
      {
        seq: 9,
        sessionId: "s1",
        type: "turn.completed",
        payload: { turnId: "t1", stopReason: "end_turn" },
      },
    ];
    socket.respondTo("events.since", {
      events: retainedTail,
      latestSeq: 9,
      truncated: true,
      openRequests: [],
      snapshot: SNAPSHOT,
    });
    await vi.waitFor(() => expect(feed.get().latestSeq).toBe(9));
    expect(feed.get().historyTrimmed).toBe(true);
    /* The retained tail merges in; the held delta@5 stays (it was live —
       only the engine's copy was dropped). */
    expect(feed.get().events.map((e) => e.seq)).toEqual([5, 7, 9]);
  });

  it("a clean (non-truncated) replay leaves historyTrimmed false", async () => {
    const { socket, client } = makeClient();
    await connectClient(client, socket);
    const feed = client.sessionFeed("s1");
    await vi.waitFor(() =>
      expect(socket.sawRequest("events.since")).toBe(true),
    );
    socket.respondTo("events.since", {
      events: [],
      latestSeq: 1,
      truncated: false,
      openRequests: [],
      snapshot: SNAPSHOT,
    });
    await vi.waitFor(() => expect(feed.get().synced).toBe(true));
    expect(feed.get().historyTrimmed).toBe(false);
  });
});
