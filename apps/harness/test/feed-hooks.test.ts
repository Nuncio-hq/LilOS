import type { RelaySocket, SocketFactory } from "@lilos/client-runtime";
import { RelayClient } from "@lilos/client-runtime";
import type { AppMessage } from "@lilos/contracts/app";
import type { EngineEvent } from "@lilos/contracts/engine";
import { connectFake, FakeEngine } from "@lilos/engine-fake";
import { describe, expect, it } from "vitest";
import { createRelay } from "../../relay/src/session";
import { createMemoryStore } from "../../relay/src/store";
import type { EngineConnection } from "../src/engine/client";
import { createFeedHandler } from "../src/feed";
import { Harness } from "../src/harness";
import { createMemoryLogger } from "../src/log";
import { createFakeSleepGuard } from "../src/sleep";

/**
 * The three hooks #27 added on top of the base #26 harness:
 *  - a read-only client feed (`describe` + `events.since` + live fan-out),
 *  - `steer` capability gating for mid-turn messages,
 *  - first-run auto-hire of the `default` engine profile.
 * Same in-process rig as harness.test.ts: real relay protocol machine, real
 * JSON-RPC on both sides, engine-fake driving real turns.
 */

const TOKEN = "test-token";

type Relay = ReturnType<typeof createRelay>;

const socketFor =
  (relay: Relay): SocketFactory =>
  () => {
    const listeners = new Map<string, Array<(e?: unknown) => void>>();
    const emit = (type: string, e?: unknown) =>
      queueMicrotask(() =>
        (listeners.get(type) ?? []).forEach((fn) => void fn(e)),
      );
    let peer: { receive(f: string): Promise<void>; closed(): void };
    let readyState = 0;
    const socket = {
      get readyState() {
        return readyState;
      },
      send: (frame: string) => {
        void peer.receive(frame);
      },
      close: () => {
        readyState = 3;
        peer.closed();
        emit("close", { code: 1000, reason: "closed" });
      },
      addEventListener(type: string, fn: (e?: unknown) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
    } as unknown as RelaySocket;
    peer = relay.connect({
      send: (frame) => emit("message", { data: frame }),
      close: (code, reason) => emit("close", { code, reason }),
    });
    queueMicrotask(() => {
      readyState = 1;
      emit("open");
    });
    return socket;
  };

const waitFor = async <T>(
  fn: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 10_000,
): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
};

interface World {
  relay: Relay;
  engine: FakeEngine;
  harness: Harness;
  user: RelayClient;
  log: ReturnType<typeof createMemoryLogger>;
  cleanup: () => Promise<void>;
}

async function setupWorld(
  tick = 1,
  hideCaps?: string[],
  wrap?: (conn: EngineConnection, engine: FakeEngine) => EngineConnection,
): Promise<World> {
  const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
  const engine = new FakeEngine({ tick });
  const raw = connectFake(engine) as unknown as EngineConnection;
  const engineConn = wrap ? wrap(raw, engine) : raw;
  const log = createMemoryLogger();
  const harnessRelay = new RelayClient({
    url: "mem://harness",
    token: TOKEN,
    socketFactory: socketFor(relay),
  });
  const harness = new Harness({
    relay: harnessRelay,
    sleep: createFakeSleepGuard(),
    workdir: "/tmp/lilos-test",
    log,
    hideCaps,
  });
  harness.attachEngine(engineConn);
  await harness.start();
  const user = new RelayClient({
    url: "mem://user",
    token: TOKEN,
    socketFactory: socketFor(relay),
  });
  await user.connect();
  return {
    relay,
    engine,
    harness,
    user,
    log,
    cleanup: async () => {
      user.close();
      await harness.stop();
    },
  };
}

/** Open a DM + conversation as the user; returns ids. */
async function openDmConversation(user: RelayClient) {
  const { employee } = await user.request<{ employee: { id: string } }>(
    "employees.create",
    { name: "Ada", role: "engineer", profile: "builder" },
  );
  const { channel } = await user.request<{
    channel: { id: string; employeeId: string };
  }>("channels.openDm", { employeeId: employee.id });
  return { employee, channel };
}

const postMessage = (
  user: RelayClient,
  channelId: string,
  conversationId: string,
  text: string,
) =>
  user.request<{ message: AppMessage }>("messages.post", {
    channelId,
    conversationId,
    text,
    authorKind: "user",
  });

const openConversation = (user: RelayClient, channelId: string, text: string) =>
  user.request<{ conversation: { id: string } }>("conversations.open", {
    channelId,
    text,
  });

/** Collect JSON-RPC frames a feed peer receives until `pred` matches. */
const feedCollector = () => {
  const frames: { id?: unknown; method?: string; result?: unknown }[] = [];
  const send = (frame: string) => frames.push(JSON.parse(frame));
  return { send, frames };
};

describe("client feed (read-only engine surface)", () => {
  it("serves describe + events.since and fans out live events", async () => {
    const w = await setupWorld();
    try {
      const feed = createFeedHandler(w.harness);
      const a = feedCollector();
      const b = feedCollector();
      feed.attach(a.send);
      feed.attach(b.send);

      await feed.handleFrame(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "describe" }),
        a.send,
      );
      const desc = a.frames.at(-1);
      expect(desc?.id).toBe(1);
      expect((desc?.result as { name?: string })?.name).toBe("engine-fake");

      // Live fan-out: an engine event reaches every attached peer.
      const { channel } = await openDmConversation(w.user);
      await openConversation(w.user, channel.id, "Add a release note");
      const sessionEvent = await waitFor(
        () =>
          b.frames.find(
            (f) =>
              f.method === "event" &&
              (f as { params?: { type?: string } }).params?.type ===
                "turn.started",
          ),
        "turn.started broadcast",
      );
      expect(sessionEvent).toBeTruthy();

      const sessionId = (sessionEvent as { params: { sessionId: string } })
        .params.sessionId;
      await feed.handleFrame(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "events.since",
          params: { sessionId, after: 0 },
        }),
        a.send,
      );
      const replay = a.frames.at(-1) as {
        result?: { events?: EngineEvent[] };
      };
      expect(replay.result?.events?.length).toBeGreaterThan(0);
      feed.close();
    } finally {
      await w.cleanup();
    }
  });

  it("rejects writes and malformed calls with JSON-RPC errors", async () => {
    const w = await setupWorld();
    try {
      const feed = createFeedHandler(w.harness);
      const a = feedCollector();
      feed.attach(a.send);
      await feed.handleFrame(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompt" }),
        a.send,
      );
      await feed.handleFrame(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "events.since" }),
        a.send,
      );
      await feed.handleFrame("not json", a.send);
      const codes = a.frames.map(
        (f) => (f as { error?: { code: number } }).error?.code,
      );
      expect(codes).toEqual([-32601, -32602, -32700]);
      feed.close();
    } finally {
      await w.cleanup();
    }
  });

  it("a dead engine session replays empty, not an error (#300)", async () => {
    /* Pre-registry conversations carry bare ids (`s1`) the engine has no
       row for: replay must degrade to an empty transcript — relay messages
       and the persisted meter still render — instead of surfacing
       SESSION_NOT_FOUND to the client. */
    const w = await setupWorld();
    try {
      const result = (await w.harness.eventsSince("s1", 0)) as {
        events: unknown[];
        latestSeq: number;
        truncated: boolean;
        snapshot: { sessionId: string; state: string };
      };
      expect(result.events).toEqual([]);
      expect(result.latestSeq).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.snapshot).toMatchObject({
        sessionId: "s1",
        state: "closed",
      });

      const feed = createFeedHandler(w.harness);
      const a = feedCollector();
      feed.attach(a.send);
      await feed.handleFrame(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "events.since",
          params: { sessionId: "s1", after: 0 },
        }),
        a.send,
      );
      const frame = a.frames.at(-1) as {
        result?: { events?: unknown[] };
        error?: unknown;
      };
      expect(frame.error).toBeUndefined();
      expect(frame.result?.events).toEqual([]);
      feed.close();
    } finally {
      await w.cleanup();
    }
  });
});

describe("steer capability gating", () => {
  /** Post an edit prompt, then a mid-turn message; return the second turn's fate. */
  const midTurn = async (w: World) => {
    const { channel } = await openDmConversation(w.user);
    const { conversation } = await openConversation(
      w.user,
      channel.id,
      "Add a release note to the readme",
    );
    // Hold the first turn open: wait for the approval ask.
    await waitFor(async () => {
      const { asks } = await w.user.request<{ asks: { state: string }[] }>(
        "asks.list",
        { conversationId: conversation.id },
      );
      return asks.find((a) => a.state === "open");
    }, "open approval");
    // Mid-turn user message: steered (cap) or queued (no cap).
    await postMessage(w.user, channel.id, conversation.id, "also bananas");
    return conversation;
  };

  const answeredConvs = async (w: World, conversationId: string) => {
    const { asks } = await w.user.request<{ asks: { id: string }[] }>(
      "asks.list",
      { conversationId },
    );
    for (const ask of asks) {
      await w.user
        .request("asks.respond", { askId: ask.id, outcome: "once" })
        .catch(() => {});
    }
  };

  it("steers the running turn when the engine advertises `steer`", {
    timeout: 30_000,
  }, async () => {
    const w = await setupWorld();
    try {
      const conversation = await midTurn(w);
      // turn.steered shows up in the engine log before the turn ends.
      const sessionId = await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {});
        return (
          conversations.find((c) => c.id === conversation.id)?.engineRef ??
          undefined
        );
      }, "engineRef");
      if (!sessionId) throw new Error("engineRef never set");
      // Steers drain at the next step boundary — unblock the open approval.
      await answeredConvs(w, conversation.id);
      await waitFor(async () => {
        const { events } = (await w.harness.eventsSince(sessionId, 0)) as {
          events: EngineEvent[];
        };
        return events.find((e) => e.type === "turn.steered");
      }, "turn.steered event");
    } finally {
      await w.cleanup();
    }
  });

  it("a steer that races the turn's end (not_running) still runs as the next prompt", {
    timeout: 30_000,
  }, async () => {
    /* The harness saw a running turn and steered; by the time the engine
       handled it the turn had ended (a Stop landed first), so it answered
       not_running. The message must become a prompt — not sit in the queue,
       which only drains on a turn.completed that already happened. */
    let raced = false;
    const w = await setupWorld(1, undefined, (conn) => {
      const request = conn.request.bind(conn) as EngineConnection["request"];
      return new Proxy(conn, {
        get(target, prop, receiver) {
          if (prop !== "request") return Reflect.get(target, prop, receiver);
          return async (method: string, params?: Record<string, unknown>) => {
            if (method === "session.steer" && !raced) {
              raced = true;
              // End the running turn, let the harness settle it, then answer
              // the steer exactly as the engine does for an idle session.
              await request("interrupt", { sessionId: params?.sessionId });
              await new Promise((r) => setTimeout(r, 200));
              return { status: "not_running" };
            }
            return request(method as never, params as never);
          };
        },
      }) as EngineConnection;
    });
    try {
      const conversation = await midTurn(w);
      const sessionId = await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {});
        return (
          conversations.find((c) => c.id === conversation.id)?.engineRef ??
          undefined
        );
      }, "engineRef");
      if (!sessionId) throw new Error("engineRef never set");
      // "also bananas" reaches the engine as a second turn's prompt.
      await waitFor(
        async () => {
          await answeredConvs(w, conversation.id);
          const { events } = (await w.harness.eventsSince(sessionId, 0)) as {
            events: EngineEvent[];
          };
          return events.filter((e) => e.type === "turn.started").length >= 2
            ? true
            : undefined;
        },
        "second turn from the raced steer",
        15_000,
      );
      expect(raced).toBe(true);
    } finally {
      await w.cleanup();
    }
  });

  it("queues the message as the next turn when `steer` is hidden", {
    timeout: 90_000,
  }, async () => {
    const w = await setupWorld(1, ["steer"]);
    try {
      const conversation = await midTurn(w);
      // Answer approvals until both turns finish: turn 1 (edit), then the
      // queued "also bananas" turn.
      const done = await waitFor(
        async () => {
          await answeredConvs(w, conversation.id);
          const { conversations } = await w.user.request<{
            conversations: { id: string; state: string }[];
          }>("conversations.list", {});
          return conversations.find((c) => c.id === conversation.id)?.state ===
            "idle"
            ? true
            : undefined;
        },
        "conversation idle after queued turn",
        60_000,
      );
      expect(done).toBe(true);
      // No steer call ever reached the engine.
      const sessionId = (
        await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {})
      ).conversations.find((c) => c.id === conversation.id)?.engineRef;
      expect(sessionId).toBeTruthy();
      if (!sessionId) return;
      const { events } = (await w.harness.eventsSince(sessionId, 0)) as {
        events: EngineEvent[];
      };
      expect(events.some((e) => e.type === "turn.steered")).toBe(false);
      // The queued text ran as a second turn.
      expect(
        events.filter((e) => e.type === "turn.started").length,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      await w.cleanup();
    }
  });

  it("queues a mid-turn message with attachments even though `steer` is advertised (#112)", {
    timeout: 90_000,
  }, async () => {
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await openConversation(
        w.user,
        channel.id,
        "Add a release note to the readme",
      );
      // Hold the first turn open on its approval ask.
      await waitFor(async () => {
        const { asks } = await w.user.request<{ asks: { state: string }[] }>(
          "asks.list",
          { conversationId: conversation.id },
        );
        return asks.find((a) => a.state === "open");
      }, "open approval");
      // Mid-turn message carrying an image: session.steer is text-only, so
      // this must queue and prompt (with image blocks) once the turn ends.
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      await w.user.request("messages.post", {
        channelId: channel.id,
        conversationId: conversation.id,
        text: "look at this screenshot meanwhile",
        authorKind: "user",
        attachments: [
          { name: "shot.png", mimeType: "image/png", dataBase64: png },
        ],
      });
      // Unblock approvals until both turns finish and the conv goes idle.
      const done = await waitFor(
        async () => {
          await answeredConvs(w, conversation.id);
          const { conversations } = await w.user.request<{
            conversations: { id: string; state: string }[];
          }>("conversations.list", {});
          return conversations.find((c) => c.id === conversation.id)?.state ===
            "idle"
            ? true
            : undefined;
        },
        "conversation idle after queued image turn",
        60_000,
      );
      expect(done).toBe(true);
      const sessionId = (
        await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {})
      ).conversations.find((c) => c.id === conversation.id)?.engineRef;
      expect(sessionId).toBeTruthy();
      if (!sessionId) return;
      const { events } = (await w.harness.eventsSince(sessionId, 0)) as {
        events: EngineEvent[];
      };
      // The image message never steered — it ran as the next turn.
      expect(events.some((e) => e.type === "turn.steered")).toBe(false);
      expect(
        events.filter((e) => e.type === "turn.started").length,
      ).toBeGreaterThanOrEqual(2);
      // And that second turn's prompt carried the image block — the fake's
      // reply echoes the decoded mimeType + size it was handed.
      const answer = await waitFor(async () => {
        const { messages } = await w.user.request<{ messages: AppMessage[] }>(
          "messages.list",
          { channelId: channel.id, limit: 50 },
        );
        return messages.find(
          (m) =>
            m.authorKind === "employee" &&
            m.conversationId === conversation.id &&
            m.text.includes("image/png"),
        );
      }, "answer referencing the queued image");
      expect(answer.text).toContain("image/png (70 bytes)");
      expect(answer.text).toContain("prompt content block");
    } finally {
      await w.cleanup();
    }
  });
});

describe("first-run auto-hire", () => {
  /* AC-3 (#193): the first-run hire must leave a DM channel behind — the
     same `channels.openDm` the web hire path makes — or the new employee's
     DM renders a perpetual skeleton. */
  it("AC-3 opens a DM channel for the auto-hired employee", async () => {
    const w = await setupWorld();
    try {
      const employees = await waitFor(async () => {
        const { employees } = await w.user.request<{
          employees: { id: string }[];
        }>("employees.list", {});
        return employees.length > 0 ? employees : undefined;
      }, "auto-hired employee");
      const channel = await waitFor(async () => {
        const { channels } = await w.user.request<{
          channels: { id: string; kind: string; employeeId?: string }[];
        }>("channels.list", {});
        return channels.find(
          (c) => c.kind === "dm" && c.employeeId === employees[0].id,
        );
      }, "DM channel for the auto-hired employee");
      expect(channel).toBeTruthy();
    } finally {
      await w.cleanup();
    }
  });

  it("hires the `default` engine profile when the roster is empty", async () => {
    const w = await setupWorld();
    try {
      const employees = await waitFor(async () => {
        const { employees } = await w.user.request<{
          employees: { id: string; agentRef?: string }[];
        }>("employees.list", {});
        return employees.length > 0 ? employees : undefined;
      }, "auto-hired employee");
      expect(employees).toHaveLength(1);
      expect(w.log.lines.some((l) => l.includes("hired first employee"))).toBe(
        true,
      );
    } finally {
      await w.cleanup();
    }
  });

  it("does not double-hire when an employee already exists", async () => {
    const w = await setupWorld();
    try {
      // Pre-existing employee → the auto-hire hook stays silent.
      await w.user.request("employees.create", {
        name: "Ada",
        role: "engineer",
        profile: "builder",
      });
      const engine = new FakeEngine({ tick: 1 });
      const conn = connectFake(engine) as unknown as EngineConnection;
      w.harness.attachEngine(conn);
      await new Promise((r) => setTimeout(r, 300));
      const { employees } = await w.user.request<{
        employees: { id: string }[];
      }>("employees.list", {});
      // auto-hire already ran on first attach (1 hired) + manual = 2 total,
      // and the second attach must not add another.
      expect(employees.length).toBeLessThanOrEqual(2);
      const hires = w.log.lines.filter((l) =>
        l.includes("hired first employee"),
      );
      expect(hires.length).toBe(1);
    } finally {
      await w.cleanup();
    }
  });
});
