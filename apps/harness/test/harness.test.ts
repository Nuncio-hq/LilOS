import type {
  ChannelMessagesState,
  RelaySocket,
  SocketFactory,
} from "@lilos/client-runtime";
import { RelayClient } from "@lilos/client-runtime";
import type { AppMessage, Ask, WelcomeResult } from "@lilos/contracts/app";
import { connectFake, FakeEngine } from "@lilos/engine-fake";
import type { CheckpointStore } from "@lilos/host";
import { describe, expect, it } from "vitest";
import { createRelay } from "../../relay/src/session";
import { createMemoryStore } from "../../relay/src/store";
import {
  connectEngineWs,
  type EngineConnection,
  EngineRpcError,
} from "../src/engine/client";
import { fakeEngineLauncher } from "../src/engine/launcher";
import {
  type EngineHostState,
  EngineSupervisor,
} from "../src/engine/supervisor";
import { Harness } from "../src/harness";
import { createMemoryLogger } from "../src/log";
import { createFakeSleepGuard } from "../src/sleep";

/**
 * Harness <-> relay E2E with engine-fake in-process (AC-1..AC-6). The relay
 * runs as a real createRelay() protocol machine; the socket is a bridge into
 * it, so every assertion crosses the real JSON-RPC surface on both sides.
 */

const TOKEN = "test-token";

type Relay = ReturnType<typeof createRelay>;

/** A RelaySocket that talks straight into a relay.connect() peer. */
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
  engineConn: EngineConnection;
  engineCalls: { method: string; params: unknown }[];
  /** Every socket the harness's RelayClient has opened — close() drops it. */
  relaySockets: RelaySocket[];
  harnessRelay: RelayClient;
  harness: Harness;
  sleep: ReturnType<typeof createFakeSleepGuard>;
  user: RelayClient;
  log: ReturnType<typeof createMemoryLogger>;
  cleanup: () => Promise<void>;
}

async function setupWorld(
  tick = 1,
  attachEngine = true,
  engineOpts?: ConstructorParameters<typeof FakeEngine>[0],
  checkpoints?: CheckpointStore,
): Promise<World> {
  const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
  const engine = new FakeEngine({ tick, ...engineOpts });
  const engineConn = connectFake(engine) as unknown as EngineConnection;
  const engineCalls: { method: string; params: unknown }[] = [];
  const origRequest = engineConn.request.bind(engineConn);
  engineConn.request = <T = unknown>(
    method: string,
    params?: unknown,
  ): Promise<T> => {
    engineCalls.push({ method, params });
    return origRequest<T>(method, params);
  };
  const relaySockets: RelaySocket[] = [];
  const capturingFactory =
    (inner: SocketFactory): SocketFactory =>
    (url: string) => {
      const s = inner(url);
      relaySockets.push(s);
      return s;
    };
  const sleep = createFakeSleepGuard();
  const log = createMemoryLogger();
  const harnessRelay = new RelayClient({
    url: "mem://harness",
    token: TOKEN,
    socketFactory: capturingFactory(socketFor(relay)),
    reconnectMinDelayMs: 20,
  });
  const harness = new Harness({
    relay: harnessRelay,
    sleep,
    workdir: "/tmp/lilos-test",
    log,
    ...(checkpoints ? { checkpoints } : {}),
  });
  if (attachEngine) harness.attachEngine(engineConn);
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
    engineConn,
    engineCalls,
    relaySockets,
    harnessRelay,
    harness,
    sleep,
    user,
    log,
    cleanup: async () => {
      user.close();
      await harness.stop();
    },
  };
}

const listConvMessages = (user: RelayClient, channelId: string) =>
  user.request<{ messages: AppMessage[] }>("messages.list", {
    channelId,
    limit: 200,
  });

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

describe("workspace harness", () => {
  it("AC-1 registers as the engine host and maps a conversation to an engine session", async () => {
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string; engineRef: string | null };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Summarize the repo layout",
      });
      expect(conversation.engineRef).toBeNull();

      // A second harness must not be able to take the host role.
      const squatter = new RelayClient({
        url: "mem://squatter",
        token: TOKEN,
        socketFactory: socketFor(w.relay),
      });
      const welcome = (await squatter.connect()) as WelcomeResult;
      expect(welcome.engineHost?.connected).toBe(true);
      await expect(
        squatter.request("harness.register", {
          protocolVersion: 1,
          version: "0.0.0-test",
        }),
      ).rejects.toThrow();
      squatter.close();

      // The user message became an engine session: engineRef lands on the
      // conversation and state flips while the turn runs / after it ends.
      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {});
        return conversations.find((c) => c.id === conversation.id)?.engineRef;
      }, "conversation engineRef");
    } finally {
      await w.cleanup();
    }
  });

  it("AC-3 posts the turn's final answer to the relay as a visible message", async () => {
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Summarize the repo layout",
      });
      const answer = await waitFor(async () => {
        const { messages } = await w.user.request<{
          messages: AppMessage[];
        }>("messages.list", { channelId: channel.id, limit: 50 });
        return messages.find(
          (m) =>
            m.authorKind === "employee" && m.conversationId === conversation.id,
        );
      }, "employee answer");
      expect(answer.text.length).toBeGreaterThan(0);
    } finally {
      await w.cleanup();
    }
  });

  it("AC-1b hires the employee onto the engine before session.start", async () => {
    const w = await setupWorld();
    try {
      // No `profile` on the employee: the engine has no agent named after it
      // yet, so the harness must `agents.create` one or session.start fails.
      const { employee } = await w.user.request<{ employee: { id: string } }>(
        "employees.create",
        { name: "Grace", role: "reviewer" },
      );
      const { channel } = await w.user.request<{
        channel: { id: string };
      }>("channels.openDm", { employeeId: employee.id });
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Summarize the repo layout",
      });
      const answer = await waitFor(async () => {
        const { messages } = await w.user.request<{
          messages: AppMessage[];
        }>("messages.list", { channelId: channel.id, limit: 50 });
        return messages.find(
          (m) =>
            m.authorKind === "employee" && m.conversationId === conversation.id,
        );
      }, "hired employee answer");
      expect(answer.text.length).toBeGreaterThan(0);
    } finally {
      await w.cleanup();
    }
  });

  it("AC-4 round-trips an approval ask end to end", async () => {
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Add a footer to the page",
      });
      const ask = await waitFor(async () => {
        const { asks } = await w.user.request<{ asks: Ask[] }>("asks.list", {
          conversationId: conversation.id,
          state: "open",
        });
        return asks.find((a) => a.request.kind === "approval");
      }, "open approval ask");
      expect(ask.request.kind).toBe("approval");

      const { ask: resolved } = await w.user.request<{ ask: Ask }>(
        "asks.respond",
        { askId: ask.id, outcome: "once" },
      );
      expect(resolved.state).toBe("resolved");
      expect(resolved.outcome).toBe("once");

      // The script can raise further asks; keep approving until the turn ends.
      await waitFor(async () => {
        const { asks } = await w.user.request<{ asks: Ask[] }>("asks.list", {
          conversationId: conversation.id,
          state: "open",
        });
        for (const a of asks)
          await w.user.request("asks.respond", {
            askId: a.id,
            outcome: "once",
          });
        const { messages } = await w.user.request<{
          messages: AppMessage[];
        }>("messages.list", { channelId: channel.id, limit: 50 });
        return messages.find(
          (m) =>
            m.authorKind === "employee" && m.conversationId === conversation.id,
        );
      }, "post-approval answer");
    } finally {
      await w.cleanup();
    }
  });

  it("AC-4b refuses ask kinds the contract cannot carry (sudo/secret/vault)", async () => {
    // The refuse boundary is the WS edge: a request.opened whose request is
    // not a valid EngineRequest never reaches listeners, so it can never be
    // forwarded to the relay.
    const received: unknown[] = [];
    const invalid: string[] = [];
    const listeners = new Map<string, Array<(e?: unknown) => void>>();
    const socket = {
      readyState: 0,
      send: () => {},
      close: () => {},
      addEventListener(type: string, fn: (e?: unknown) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
    } as unknown as import("../src/engine/client").EngineSocket;
    const connPromise = connectEngineWs("ws://fake", {
      socketFactory: () => {
        queueMicrotask(() =>
          (listeners.get("open") ?? []).forEach((fn) => void fn()),
        );
        socket.readyState = 1;
        return socket;
      },
      onInvalid: (info) => invalid.push(info.reason),
    });
    const conn = await connPromise;
    conn.onEvent((e) => received.push(e));
    const sudoFrame = JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: {
        seq: 1,
        sessionId: "s1",
        type: "request.opened",
        payload: {
          turnId: "t1",
          requestId: "r1",
          request: { kind: "sudo", command: "rm -rf /" },
        },
      },
    });
    (listeners.get("message") ?? []).forEach((fn) => {
      void fn({ data: sudoFrame });
    });
    expect(received).toHaveLength(0);
    expect(invalid.length).toBeGreaterThan(0);
    conn.close();
  });

  it("AC-5 rebinds the conversation when the engine rotates the session ref", async () => {
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Summarize the repo layout",
      });
      const engineRef = await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {});
        return (
          conversations.find((c) => c.id === conversation.id)?.engineRef ??
          undefined
        );
      }, "engineRef");
      await waitFor(async () => {
        const { messages } = await w.user.request<{ messages: AppMessage[] }>(
          "messages.list",
          { channelId: channel.id, limit: 50 },
        );
        return messages.find((m) => m.authorKind === "employee");
      }, "first answer");

      const newRef = w.engine.rotateSessionRef(engineRef as string);
      expect(newRef).not.toBeNull();
      expect(newRef).not.toBe(engineRef);

      await postMessage(w.user, channel.id, conversation.id, "one more thing");
      const answers = await waitFor(async () => {
        const { messages } = await w.user.request<{ messages: AppMessage[] }>(
          "messages.list",
          { channelId: channel.id, limit: 50 },
        );
        const list = messages.filter((m) => m.authorKind === "employee");
        return list.length >= 2 ? list : undefined;
      }, "second answer after ref rotation");
      expect(answers.length).toBeGreaterThanOrEqual(2);

      // The rotated ref is the engine's durable resume token; the transport
      // sessionId stays stable across rotations (contracts/engine/events.ts),
      // so the published engineRef — resolved through `events.since` — must
      // not move. The rebind lands on the internal binding instead.
      {
        const { conversations } = await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {});
        const c = conversations.find((x) => x.id === conversation.id);
        expect(c?.engineRef).toBe(engineRef);
      }
    } finally {
      await w.cleanup();
    }
  });

  it("AC-5b survives an engine-process restart: prompt still lands after rebind", {
    timeout: 15_000,
  }, async () => {
    // Full loop through the supervisor's relaunch: old session dies with the
    // process, harness rebinds a fresh engine session on next prompt.
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Summarize the repo layout",
      });
      await waitFor(async () => {
        const { messages } = await w.user.request<{ messages: AppMessage[] }>(
          "messages.list",
          { channelId: channel.id, limit: 50 },
        );
        return messages.find((m) => m.authorKind === "employee");
      }, "first answer");

      // Simulate the engine losing the session entirely (fresh process):
      // rebind via session.start and keep the conversation moving.
      const states: EngineHostState[] = [];
      const log = createMemoryLogger();
      const supervisor = new EngineSupervisor({
        launcher: fakeEngineLauncher({ repoRoot: process.cwd(), tick: 1, log }),
        connect: async (url) => connectEngineWs(url),
        onConnection: (conn) => w.harness.attachEngine(conn),
        onState: (s) => states.push(s),
        log,
        minBackoffMs: 10,
        maxConsecutiveCrashes: 3,
      });
      await supervisor.start();
      try {
        // The new engine doesn't know s-old → resync rebinds with an empty
        // queue: the conversation must settle idle, not park on "active".
        await waitFor(
          async () => {
            const { conversations } = await w.user.request<{
              conversations: { id: string; state: string }[];
            }>("conversations.list", {});
            const c = conversations.find((x) => x.id === conversation.id);
            return c?.state === "idle" ? c : undefined;
          },
          "rebind with empty queue settles idle",
          8_000,
        );
        await postMessage(w.user, channel.id, conversation.id, "follow up");
        await waitFor(
          async () => {
            const { messages } = await w.user.request<{
              messages: AppMessage[];
            }>("messages.list", { channelId: channel.id, limit: 50 });
            const list = messages.filter((m) => m.authorKind === "employee");
            return list.length >= 2 ? list : undefined;
          },
          "answer on the restarted engine",
          8_000,
        );
      } finally {
        await supervisor.stop();
      }
      expect(states).toContain("running");
    } finally {
      await w.cleanup();
    }
  });

  it("AC-2 session ids never collide across engine restarts (#61)", {
    timeout: 30_000,
  }, async () => {
    // Two conversations bound, engine-fake killed and relaunched twice through
    // the real supervisor + spawned serve.ts: every rebind must mint ids no
    // earlier process already used, and follow-ups must land in the right
    // conversation (no aliasing a stranger's session).
    const w = await setupWorld(1, false);
    const log = createMemoryLogger();
    const conns: EngineConnection[] = [];
    const supervisor = new EngineSupervisor({
      launcher: fakeEngineLauncher({ repoRoot: process.cwd(), tick: 1, log }),
      connect: (url) => connectEngineWs(url),
      onConnection: (conn) => {
        conns.push(conn);
        w.harness.attachEngine(conn);
      },
      log,
      minBackoffMs: 10,
      stableAfterMs: 60_000,
      maxConsecutiveCrashes: 5,
    });
    try {
      await supervisor.start();
      const { channel } = await openDmConversation(w.user);
      const openConv = async (text: string) =>
        (
          await w.user.request<{ conversation: { id: string } }>(
            "conversations.open",
            { channelId: channel.id, text },
          )
        ).conversation;
      const convA = await openConv("Summarize the repo layout");
      const convB = await openConv("Describe the engine seam");

      const refsFor = async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {});
        const byId = new Map(conversations.map((c) => [c.id, c.engineRef]));
        return { a: byId.get(convA.id), b: byId.get(convB.id) };
      };
      const waitForFreshRefs = (stale: (string | null | undefined)[]) =>
        waitFor(async () => {
          const refs = await refsFor();
          // Rebound when both convs hold a ref no earlier run already used.
          if (
            !refs.a ||
            !refs.b ||
            refs.a === refs.b ||
            stale.includes(refs.a) ||
            stale.includes(refs.b)
          ) {
            return undefined;
          }
          return refs as { a: string; b: string };
        }, "rebound engineRefs");

      const run1 = await waitForFreshRefs([]);

      // Both root turns settle before the kills — an in-flight turn would end
      // interrupted instead of producing the answers counted below.
      const answersIn = async (convId: string) => {
        const { messages } = await w.user.request<{ messages: AppMessage[] }>(
          "messages.list",
          { channelId: channel.id, limit: 100 },
        );
        return messages.filter(
          (m) => m.authorKind === "employee" && m.conversationId === convId,
        ).length;
      };
      await waitFor(
        async () =>
          (await answersIn(convA.id)) >= 1 && (await answersIn(convB.id)) >= 1
            ? true
            : undefined,
        "root answers in both conversations",
      );

      // Restart 1: kill the spawned engine; supervisor relaunches it.
      supervisor.process?.kill();
      const run2 = await waitForFreshRefs([run1.a, run1.b]);
      expect(conns.length).toBeGreaterThanOrEqual(2);

      // Restart 2: same again — three processes, three disjoint id sets.
      supervisor.process?.kill();
      await waitForFreshRefs([run1.a, run1.b, run2.a, run2.b]);
      expect(conns.length).toBeGreaterThanOrEqual(3);

      // No cross-talk: a follow-up to A must answer inside A's conversation,
      // not leak into B's (the aliased-session failure this fixes).
      const beforeB = await answersIn(convB.id);
      await postMessage(w.user, channel.id, convA.id, "ping after restarts");
      await waitFor(async () => {
        const n = await answersIn(convA.id);
        return n >= 2 ? n : undefined; // root turn's answer + follow-up
      }, "follow-up answer in conversation A");
      expect(await answersIn(convB.id)).toBe(beforeB);
    } finally {
      await supervisor.stop();
      await w.cleanup();
    }
  });

  it("#288 AC-1 a harness restart never re-prompts delivered messages or starts a fresh session", {
    timeout: 15_000,
  }, async () => {
    /* The restart loop from the issue: the channel replay re-delivers every user message
       while the new engine is still down, then the flush prompted the whole
       batch on a NEW session (the seq-1 re-answer + setTitle collision). The
       deliveredSeq watermark must apply before any binding work so nothing
       owed binds at all. */
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "hi, what is your model",
      });
      await waitFor(async () => {
        const { messages } = await listConvMessages(w.user, channel.id);
        return messages.find((m) => m.authorKind === "employee");
      }, "root answer");
      // deliveredSeq covered the root turn before the restart.
      {
        const { conversations } = await w.user.request<{
          conversations: { id: string; deliveredSeq: number }[];
        }>("conversations.list", {});
        expect(
          conversations.find((c) => c.id === conversation.id)?.deliveredSeq,
        ).toBe(1);
      }

      await w.harness.stop();

      /* A fresh engine process + a fresh harness on the same relay — the
         adapter lost every session across the restart (AC-5b), so any
         session.start below is a brand-new engine session. */
      const engine2 = new FakeEngine({ tick: 1 });
      const conn2 = connectFake(engine2) as unknown as EngineConnection;
      const engine2Calls: { method: string; params: unknown }[] = [];
      const orig2 = conn2.request.bind(conn2);
      conn2.request = <T = unknown>(
        method: string,
        params?: unknown,
      ): Promise<T> => {
        engine2Calls.push({ method, params });
        return orig2<T>(method, params).then(
          (v) => v,
          (e) => {
            /* In-proc transports surface engine RpcErrors as plain Errors;
               the ws transport rebuilds them as EngineRpcError — translate
               so SESSION_NOT_FOUND binds the way it does on the wire. */
            const code = (e as { code?: unknown })?.code;
            if (e instanceof Error && typeof code === "number") {
              throw new EngineRpcError(code, e.message);
            }
            throw e;
          },
        );
      };
      const log2 = createMemoryLogger();
      const harness2 = new Harness({
        relay: new RelayClient({
          url: "mem://harness2",
          token: TOKEN,
          socketFactory: socketFor(w.relay),
          reconnectMinDelayMs: 20,
        }),
        sleep: createFakeSleepGuard(),
        workdir: "/tmp/lilos-test",
        log: log2,
      });
      await harness2.start();
      try {
        // Production's ordering: the channel replay reaches deliver() while
        // the engine is still unattached — the messages sit in the early
        // queue and flush on attach.
        await waitFor(
          async () =>
            log2.lines.some(
              (l) => l.includes("user message") && l.includes(conversation.id),
            )
              ? true
              : undefined,
          "replayed root message delivered",
          8_000,
        );
        harness2.attachEngine(conn2);
        await new Promise((r) => setTimeout(r, 150));
        expect(engine2Calls.filter((c) => c.method === "prompt")).toHaveLength(
          0,
        );
        expect(
          engine2Calls.filter((c) => c.method === "session.start"),
        ).toHaveLength(0);
      } finally {
        await harness2.stop();
      }
    } finally {
      await w.cleanup();
    }
  });

  it("AC-4 ends a turn lost across sleep as interrupted with a Retry note, never a spinner", async () => {
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Add a footer to the page", // parks mid-turn on an approval ask
      });
      await waitFor(() => w.sleep.held || undefined, "turn running");

      // Sleep dropped the turn but kept the session: the fake's replay shows
      // no snapshot.turn and no turn.completed. Reattach forces a resync.
      const sessions = (
        w.engine as unknown as {
          sessions: Map<
            string,
            { turn?: unknown; openRequests: Map<string, unknown> }
          >;
        }
      ).sessions;
      const engineRef = await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {});
        return (
          conversations.find((c) => c.id === conversation.id)?.engineRef ??
          undefined
        );
      }, "engineRef");
      const sess = sessions.get(engineRef as string);
      if (!sess) throw new Error("fake engine lost the session");
      sess.turn = undefined;
      sess.openRequests.clear();

      w.harness.attachEngine(
        connectFake(w.engine) as unknown as EngineConnection,
      );

      const note = await waitFor(async () => {
        const { messages } = await w.user.request<{ messages: AppMessage[] }>(
          "messages.list",
          { channelId: channel.id, limit: 50 },
        );
        return messages.find((m) => m.text.includes("interrupted"));
      }, "interrupted note");
      expect(note.text).toContain("Retry");
      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; state: string }[];
        }>("conversations.list", {});
        const c = conversations.find((x) => x.id === conversation.id);
        return c?.state === "idle" ? c : undefined;
      }, "conversation back to idle");
      expect(w.sleep.held).toBe(false);
    } finally {
      await w.cleanup();
    }
  });

  it("AC-4b does not double-report a turn that already ended cleanly", async () => {
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      await w.user.request<{ conversation: { id: string } }>(
        "conversations.open",
        {
          channelId: channel.id,
          text: "Summarize the repo layout",
        },
      );
      await waitFor(async () => {
        const { messages } = await w.user.request<{ messages: AppMessage[] }>(
          "messages.list",
          { channelId: channel.id, limit: 50 },
        );
        return messages.find((m) => m.authorKind === "employee");
      }, "answer");

      // Reattach: replay carries the finished turn's turn.completed, so no
      // interrupted note may appear.
      w.harness.attachEngine(
        connectFake(w.engine) as unknown as EngineConnection,
      );
      const { messages } = await w.user.request<{ messages: AppMessage[] }>(
        "messages.list",
        { channelId: channel.id, limit: 50 },
      );
      expect(messages.filter((m) => m.text.includes("interrupted"))).toEqual(
        [],
      );
    } finally {
      await w.cleanup();
    }
  });

  it("AC-6 holds the idle-sleep assertion only while a turn runs", async () => {
    const w = await setupWorld();
    try {
      expect(w.sleep.held).toBe(false);
      const { channel } = await openDmConversation(w.user);
      await w.user.request("conversations.open", {
        channelId: channel.id,
        text: "Add a footer to the page", // edit → approval gate mid-turn
      });
      await waitFor(() => w.sleep.held || undefined, "sleep assert held");
      // Held while the turn sits waiting on its approval ask.
      const asks = () =>
        w.user.request<{ asks: Ask[] }>("asks.list", {
          state: "open",
        });
      await waitFor(async () => (await asks()).asks[0], "approval ask");
      expect(w.sleep.held).toBe(true);
      // Answer every ask the script raises; the assertion must drop only once
      // the whole turn is done.
      await waitFor(async () => {
        for (const ask of (await asks()).asks) {
          await w.user.request("asks.respond", {
            askId: ask.id,
            outcome: "once",
          });
        }
        return w.sleep.held ? undefined : true;
      }, "sleep assert released");
      expect(w.sleep.count()).toBe(0);
    } finally {
      await w.cleanup();
    }
  });

  it("AC-2 a posted image reaches the engine as a prompt content block and the answer references it", async () => {
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "describe the repo",
      });
      // The user sends a screenshot: base64 bytes on messages.post.
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const { message } = await w.user.request<{ message: AppMessage }>(
        "messages.post",
        {
          channelId: channel.id,
          conversationId: conversation.id,
          text: "what does this screenshot show",
          authorKind: "user",
          attachments: [
            { name: "shot.png", mimeType: "image/png", dataBase64: png },
          ],
        },
      );
      // The app-facing message carries a display ref only — no bytes.
      expect(message.attachments?.[0]?.mimeType).toBe("image/png");
      expect(message.attachments?.[0]?.sizeBytes).toBe(70);
      expect(JSON.stringify(message)).not.toContain(png);

      // The engine's answer references what came through in the image block:
      // engine-fake echoes the decoded mimeType + byte size it was handed.
      const answer = await waitFor(async () => {
        const { messages } = await w.user.request<{
          messages: AppMessage[];
        }>("messages.list", { channelId: channel.id, limit: 50 });
        return messages.find(
          (m) =>
            m.authorKind === "employee" &&
            m.conversationId === conversation.id &&
            m.text.includes("image/png"),
        );
      }, "answer referencing the image");
      expect(answer.text).toContain("image/png (70 bytes)");
      expect(answer.text).toContain("prompt content block");
    } finally {
      await w.cleanup();
    }
  });
});

describe("engine supervisor (AC-2)", () => {
  it("starts the engine process, restarts on crash with bounded backoff, reports state", {
    timeout: 15_000,
  }, async () => {
    const log = createMemoryLogger();
    const states: EngineHostState[] = [];
    const conns: EngineConnection[] = [];
    const supervisor = new EngineSupervisor({
      launcher: fakeEngineLauncher({ repoRoot: process.cwd(), tick: 1, log }),
      connect: (url) => connectEngineWs(url),
      onConnection: (conn) => conns.push(conn),
      onState: (s) => states.push(s),
      log,
      minBackoffMs: 10,
      stableAfterMs: 10_000,
      maxConsecutiveCrashes: 3,
    });
    await supervisor.start();
    try {
      expect(supervisor.state.current).toBe("running");
      expect(conns.length).toBe(1);
      const describe = await conns[0].request<{
        name: string;
        version: string;
      }>("describe", {});
      expect(describe.name).toBe("engine-fake");

      // Crash the process; the supervisor must relaunch + reconnect.
      supervisor.process?.kill();
      await waitFor(
        () => (conns.length >= 2 ? conns : undefined),
        "reconnect after crash",
      );
      expect(states).toContain("restarting");
      expect(states.filter((s) => s === "running").length).toBe(2);
      const d2 = await conns[1].request<{ name: string }>("describe", {});
      expect(d2.name).toBe("engine-fake");
    } finally {
      await supervisor.stop();
    }
    expect(supervisor.state.current).toBe("stopped");
  });

  it("gives up after the crash bound instead of restarting forever", async () => {
    const log = createMemoryLogger();
    const states: EngineHostState[] = [];
    const supervisor = new EngineSupervisor({
      launcher: {
        name: "dying",
        start: async () => {
          throw new Error("spawn exploded");
        },
      },
      connect: (url) => connectEngineWs(url),
      onConnection: () => {},
      onState: (s) => states.push(s),
      log,
      minBackoffMs: 5,
      maxBackoffMs: 20,
      maxConsecutiveCrashes: 3,
    });
    await supervisor.start();
    expect(supervisor.state.current).toBe("failed");
    expect(states.filter((s) => s === "restarting").length).toBe(2);
    expect(states[states.length - 1]).toBe("failed");
  });
});

describe("employee lifecycle over the harness (#29)", () => {
  it("AC-1/2 user agents.* + models.* calls reach the engine through the harness", async () => {
    const w = await setupWorld();
    try {
      const { agents } = await w.user.request<{
        agents: { id: string; soul?: string }[];
      }>("agents.list", {});
      expect(agents.map((a) => a.id).sort()).toEqual([
        "builder",
        "default",
        "marketer",
        "reviewer",
      ]);
      expect(agents[0]?.soul).toBeUndefined();

      const { models } = await w.user.request<{ models: { id: string }[] }>(
        "models.list",
        {},
      );
      expect(models.map((m) => m.id)).toContain("fake-small");

      const { agent } = await w.user.request<{ agent: { id: string } }>(
        "agents.create",
        { name: "tester", soul: "You are Tester.", model: "fake-small" },
      );
      expect(agent.id).toBe("tester");
      const again = await w.user.request<{ agents: { id: string }[] }>(
        "agents.list",
        {},
      );
      expect(again.agents.map((a) => a.id)).toContain("tester");
      const described = await w.user.request<{ agent: { soul?: string } }>(
        "agents.describe",
        { id: "tester" },
      );
      expect(described.agent.soul).toBe("You are Tester.");
    } finally {
      await w.cleanup();
    }
  });

  it("agents.* with no attached engine -> engine_unavailable", async () => {
    const w = await setupWorld(1, false);
    try {
      await expect(w.user.request("agents.list", {})).rejects.toMatchObject({
        code: "engine_unavailable",
      });
    } finally {
      await w.cleanup();
    }
  });

  it("AC-4 employees.remove stops the bound session and drops the binding", async () => {
    const w = await setupWorld();
    try {
      const { employee, channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Summarize the repo layout",
      });
      await postMessage(w.user, channel.id, conversation.id, "hi");

      // The turn binds the conversation to an engine session.
      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {});
        return (
          conversations.find((c) => c.id === conversation.id)?.engineRef ??
          undefined
        );
      }, "conversation engineRef");

      const engineEvents: { type: string; payload?: unknown }[] = [];
      w.engine.onEvent((e) => engineEvents.push(e));

      await w.user.request("employees.remove", { id: employee.id });

      // channel.removed reached the harness: the engine session is stopped.
      await waitFor(
        () =>
          engineEvents.find(
            (e) =>
              e.type === "session.state" &&
              (e.payload as { state?: string })?.state === "closed",
          ),
        "session closed after employees.remove",
      );
    } finally {
      await w.cleanup();
    }
  });
});

describe("sessions replay + meta (#28)", () => {
  it("AC-3 rename/archive on the conversation mirror to the engine via session_meta", async () => {
    const w = await setupWorld();
    try {
      const describe = await w.engineConn.request<{
        capabilities: { id: string }[];
      }>("describe", {});
      expect(describe.capabilities.map((c) => c.id)).toContain("session_meta");

      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Summarize the repo layout",
      });
      const engineRef = await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {});
        return (
          conversations.find((c) => c.id === conversation.id)?.engineRef ??
          undefined
        );
      }, "engineRef");

      await w.user.request("conversations.update", {
        conversationId: conversation.id,
        title: "Quarterly plan",
      });
      const setTitle = await waitFor(
        () => w.engineCalls.find((c) => c.method === "session.setTitle"),
        "session.setTitle call",
      );
      expect(setTitle.params).toMatchObject({
        sessionId: engineRef,
        title: "Quarterly plan",
      });

      await w.user.request("conversations.update", {
        conversationId: conversation.id,
        archived: true,
      });
      const setHidden = await waitFor(
        () => w.engineCalls.find((c) => c.method === "session.setHidden"),
        "session.setHidden call",
      );
      expect(setHidden.params).toMatchObject({
        sessionId: engineRef,
        hidden: true,
      });
    } finally {
      await w.cleanup();
    }
  });

  it("AC-5 drop the harness's relay socket mid-turn: the answer lands once after reconnect", {
    timeout: 15_000,
  }, async () => {
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Add a footer to the page", // approval-gated turn: pauses on ask
      });
      const ask = await waitFor(async () => {
        const { asks } = await w.user.request<{ asks: Ask[] }>("asks.list", {
          conversationId: conversation.id,
          state: "open",
        });
        return asks[0];
      }, "approval ask");

      // Kill the harness's relay connection mid-turn (socket[0] is its first),
      // then answer while it may still be down: if the resolution's
      // notification was lost, the re-register reconcile picks it up.
      w.relaySockets[0].close();
      await w.user.request("asks.respond", {
        askId: ask.id,
        outcome: "once",
      });

      await waitFor(
        () => (w.harnessRelay.state.get() === "ready" ? true : undefined),
        "harness re-registered",
      );
      await waitFor(async () => {
        const { asks } = await w.user.request<{ asks: Ask[] }>("asks.list", {
          conversationId: conversation.id,
          state: "open",
        });
        for (const a of asks)
          await w.user.request("asks.respond", {
            askId: a.id,
            outcome: "once",
          });
        const { messages } = await listConvMessages(w.user, channel.id);
        return messages.find(
          (m) =>
            m.authorKind === "employee" && m.conversationId === conversation.id,
        );
      }, "employee answer after reconnect");

      const { messages } = await listConvMessages(w.user, channel.id);
      const answers = messages.filter(
        (m) =>
          m.authorKind === "employee" && m.conversationId === conversation.id,
      );
      expect(answers).toHaveLength(1);
      expect(answers[0].text.length).toBeGreaterThan(0);

      // The engine saw the prompt exactly once — no re-prompt on re-register.
      const prompts = w.engineCalls.filter(
        (c) =>
          c.method === "prompt" &&
          JSON.stringify(c.params).includes("Add a footer"),
      );
      expect(prompts).toHaveLength(1);
    } finally {
      await w.cleanup();
    }
  });

  it("AC-5b user message posted while the harness is offline delivers exactly once", {
    timeout: 15_000,
  }, async () => {
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Summarize the repo layout",
      });
      await waitFor(async () => {
        const { messages } = await listConvMessages(w.user, channel.id);
        return messages.find((m) => m.authorKind === "employee");
      }, "first answer");

      w.relaySockets.at(-1)?.close();
      // The message lands in the relay while the harness can't hear it.
      await postMessage(w.user, channel.id, conversation.id, "one more thing");

      await waitFor(async () => {
        const { messages } = await listConvMessages(w.user, channel.id);
        const list = messages.filter((m) => m.authorKind === "employee");
        return list.length >= 2 ? list : undefined;
      }, "second answer after reconnect");
      const { messages } = await listConvMessages(w.user, channel.id);
      expect(messages.filter((m) => m.authorKind === "employee")).toHaveLength(
        2,
      );
      expect(
        w.engineCalls.filter(
          (c) =>
            c.method === "prompt" &&
            JSON.stringify(c.params).includes("one more thing"),
        ),
      ).toHaveLength(1);
    } finally {
      await w.cleanup();
    }
  });
});

describe("auto titles (#137)", () => {
  const convById = async (user: RelayClient, id: string) => {
    const { conversations } = await user.request<{
      conversations: {
        id: string;
        title: string;
        titleSource: "auto" | "user";
      }[];
    }>("conversations.list", {});
    return conversations.find((c) => c.id === id);
  };

  it("AC-2/AC-4 the engine's derived→llm titles land on the conversation, marked auto", {
    timeout: 30000,
  }, async () => {
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string; title: string; titleSource: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Summarize the repo layout",
      });
      // AC-3: the placeholder is already on the row before any engine title.
      expect(conversation.title).toBe("Summarize the repo layout");
      expect(conversation.titleSource).toBe("auto");

      // engine-fake emits session.titled derived (turn start) then llm
      // (turn end) — the final title on the conversation is the llm one
      // (Title Case rewrite of the first clause).
      const conv = await waitFor(async () => {
        const c = await convById(w.user, conversation.id);
        return c?.title === "Summarize The Repo Layout" ? c : undefined;
      }, "llm title on conversation");
      expect(conv.titleSource).toBe("auto");

      // Engine-written titles must never echo back as session.setTitle —
      // that would mark the engine's own auto title as user-provenance and
      // block the upgrade (mirrorMeta is user-rename only).
      expect(
        w.engineCalls.filter((c) => c.method === "session.setTitle"),
      ).toHaveLength(0);
    } finally {
      await w.cleanup();
    }
  });

  it("AC-2 a user rename during the first turn beats the late llm title", {
    timeout: 30000,
  }, async () => {
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Add a footer to the page", // approval-gated: pauses mid-turn
      });
      // Wait for the ask so the turn is running (derived title already out).
      await waitFor(async () => {
        const { asks } = await w.user.request<{ asks: Ask[] }>("asks.list", {
          conversationId: conversation.id,
          state: "open",
        });
        return asks[0];
      }, "approval ask");

      // A manual rename mid-turn → provenance flips to user.
      await w.user.request("conversations.update", {
        conversationId: conversation.id,
        title: "My footer session",
      });

      // The rename mirrors to the engine before the llm upgrade can land.
      const setTitle = await waitFor(
        () => w.engineCalls.find((c) => c.method === "session.setTitle"),
        "session.setTitle call",
      );
      expect(setTitle.params).toMatchObject({ title: "My footer session" });

      // Answer approvals; the canned turn asks more than once — keep
      // answering until it completes, and any late llm title must be dropped
      // at the relay (provenance) — never overwrites the rename.
      await waitFor(async () => {
        const { asks } = await w.user.request<{ asks: Ask[] }>("asks.list", {
          conversationId: conversation.id,
          state: "open",
        });
        for (const a of asks)
          await w.user.request("asks.respond", {
            askId: a.id,
            outcome: "once",
          });
        const { messages } = await listConvMessages(w.user, channel.id);
        return messages.find((m) => m.authorKind === "employee");
      }, "turn completes");

      const conv = await convById(w.user, conversation.id);
      expect(conv).toMatchObject({
        title: "My footer session",
        titleSource: "user",
      });
      // Only the user's own rename ever reached the engine as a title.
      const titles = w.engineCalls
        .filter((c) => c.method === "session.setTitle")
        .map((c) => (c.params as { title?: string }).title);
      expect(titles).toEqual(["My footer session"]);
    } finally {
      await w.cleanup();
    }
  });

  it("AC-3 an engine without autoTitle leaves the placeholder as the title", {
    timeout: 30000,
  }, async () => {
    // session_meta off → no autoTitle detail and no session.titled events.
    const w = await setupWorld(1, true, {
      capabilities: { session_meta: false },
    });
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string; title: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Tell me about the layout of this repo please",
      });
      expect(conversation.title).toBe("Tell me about the layout of…");

      // The turn completes; no engine title may ever write.
      await waitFor(async () => {
        const { messages } = await listConvMessages(w.user, channel.id);
        return messages.find((m) => m.authorKind === "employee");
      }, "turn completes");
      const conv = await convById(w.user, conversation.id);
      expect(conv).toMatchObject({
        title: "Tell me about the layout of…",
        titleSource: "auto",
      });
    } finally {
      await w.cleanup();
    }
  });
});

/* #274: an interrupt fired while `sendPrompt` is still in its pre-prompt
   awaits (here: the folder checkpoint) overtakes the prompt on the engine
   conn — the engine acks interrupted:false on a session that has no turn
   YET and the Stop is lost; the prompt then runs unimpeded (ac-104 AC-4,
   ac-27 AC-5). */
describe("interrupt ordering (#274)", () => {
  it("#274 AC-1 a Stop fired inside the checkpoint window lands behind its prompt", async () => {
    // Hold the checkpoint snapshot: sendPrompt parks inside stampCheckpoint
    // exactly where a real snapshot costs tens-hundreds of ms.
    let releaseSnapshot!: () => void;
    let snapshotEntered = false;
    const held = new Promise<void>((r) => (releaseSnapshot = r));
    const checkpoints: CheckpointStore = {
      snapshot: async () => {
        snapshotEntered = true;
        await held;
        return "ck-1";
      },
      restore: async () => ({ removed: [], restoredTo: "" }),
      list: async () => [],
      prune: async () => {},
    };
    const w = await setupWorld(1, true, undefined, checkpoints);
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Add a footer to the page",
      });
      await waitFor(
        () => (snapshotEntered ? true : undefined),
        "checkpoint window",
      );
      await w.user.request("turns.interrupt", {
        conversationId: conversation.id,
      });
      // The harness took the request; only then let the prompt go out. The
      // Stop is either logged (bound path) or parked for the first turn.
      await waitFor(
        () =>
          w.log.lines.find(
            (l) =>
              l.includes("interrupt requested") ||
              l.includes("interrupt parked"),
          ),
        "interrupt taken",
      );
      releaseSnapshot();
      const methods = await waitFor(() => {
        const m = w.engineCalls.map((c) => c.method);
        return m.includes("prompt") && m.includes("interrupt") ? m : undefined;
      }, "prompt and interrupt on the engine conn");
      expect(methods.indexOf("prompt")).toBeLessThan(
        methods.indexOf("interrupt"),
      );
      // The turn ends interrupted — not parked on its scripted approval.
      const stopped = await waitFor(async () => {
        const { messages } = await listConvMessages(w.user, channel.id);
        return messages.find((m) => m.text === "Stopped.");
      }, "Stopped. note");
      expect(stopped).toBeTruthy();
    } finally {
      await w.cleanup();
    }
  });

  it("#274 AC-2 a Stop against a live turn still interrupts it and cancels its open asks", async () => {
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Add a footer to the page",
      });
      // A live turn parked on its scripted approval is the steady-state case
      // the fix must not change: the interrupt still lands, the ask cancels.
      const ask = await waitFor(async () => {
        const { asks } = await w.user.request<{ asks: Ask[] }>("asks.list", {
          conversationId: conversation.id,
          state: "open",
        });
        return asks.find((a) => a.request.kind === "approval");
      }, "open approval ask");
      await w.user.request("turns.interrupt", {
        conversationId: conversation.id,
      });
      const stopped = await waitFor(async () => {
        const { messages } = await listConvMessages(w.user, channel.id);
        return messages.find((m) => m.text === "Stopped.");
      }, "Stopped. note");
      expect(stopped).toBeTruthy();
      const { asks } = await w.user.request<{ asks: Ask[] }>("asks.list", {
        conversationId: conversation.id,
        state: "open",
      });
      expect(asks.find((a) => a.id === ask.id)).toBeUndefined();
    } finally {
      await w.cleanup();
    }
  });

  it("#274 AC-3 a Stop on an idle session still reaches the engine and acks through", async () => {
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Summarize the repo layout",
      });
      // Let the turn finish so the session is idle when the Stop lands.
      await waitFor(async () => {
        const { messages } = await listConvMessages(w.user, channel.id);
        return messages.find(
          (m) =>
            m.authorKind === "employee" && m.conversationId === conversation.id,
        );
      }, "turn completes");
      const callsBefore = w.engineCalls.length;
      await w.user.request("turns.interrupt", {
        conversationId: conversation.id,
      });
      // Nothing to interrupt: the engine still sees the request (ack
      // interrupted:false) and no stopped note appears.
      await waitFor(
        () =>
          w.engineCalls
            .slice(callsBefore)
            .find((c) => c.method === "interrupt"),
        "interrupt reaches the engine",
      );
      await new Promise((r) => setTimeout(r, 250));
      const { messages } = await listConvMessages(w.user, channel.id);
      expect(messages.find((m) => m.text === "Stopped.")).toBeUndefined();
    } finally {
      await w.cleanup();
    }
  });

  it("#400 AC-1 a Stop fired while the first bind is mid-flight lands on the turn", async () => {
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      /* Hold the engine's session.start: the first bind parks inside its
         RPC window — where a real engine's start costs tens-hundreds of ms
         — so the Stop arrives while `bindingFor` is still awaiting and
         `bindings` has nothing yet (ac-104 AC-4, ac-27 AC-5b on a slow
         runner: the request used to hit `!binding` and vanish). */
      let releaseStart!: () => void;
      let startEntered = false;
      const held = new Promise<void>((r) => (releaseStart = r));
      const orig = w.engineConn.request.bind(w.engineConn);
      w.engineConn.request = <T = unknown>(
        method: string,
        params?: unknown,
      ): Promise<T> => {
        if (method === "session.start" && !startEntered) {
          startEntered = true;
          return held.then(() => orig<T>(method, params));
        }
        return orig<T>(method, params);
      };
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Add a footer to the page",
      });
      await waitFor(
        () => (startEntered ? true : undefined),
        "bind inside session.start",
      );
      await w.user.request("turns.interrupt", {
        conversationId: conversation.id,
      });
      releaseStart();
      /* The parked Stop fires at the turn's start — the engine sees
         prompt → interrupt, never the request silently dropped. */
      const methods = await waitFor(() => {
        const m = w.engineCalls.map((c) => c.method);
        return m.includes("prompt") && m.includes("interrupt") ? m : undefined;
      }, "prompt and interrupt on the engine conn");
      expect(methods.indexOf("prompt")).toBeLessThan(
        methods.indexOf("interrupt"),
      );
      const stopped = await waitFor(async () => {
        const { messages } = await listConvMessages(w.user, channel.id);
        return messages.find((m) => m.text === "Stopped.");
      }, "Stopped. note");
      expect(stopped).toBeTruthy();
    } finally {
      await w.cleanup();
    }
  });
});

/* #402 — the windows around a send's first turn: a send reaches the harness
   via the `channelMessages` store subscription while `turn.interruptRequested`
   arrives on the `onRelayEvent` bus, and the relay orders the two paths
   arbitrarily. When the bus wins, the Stop used to hit `!binding &&
   !binds` and vanish; and with the binding set but its bind still inside
   `bindConversation`'s last awaits (no prompt dispatched, promptGates
   empty), a dispatched interrupt acks `interrupted:false` — a turn that
   doesn't exist yet can't be cancelled (ac-104 AC-4: ~25% red under load).
   Gate each delivery path so the interrupt provably lands in the window. */
describe("pre-store-row interrupt park (#402)", () => {
  /** Hold every channelMessages subscriber's notify until released. */
  const gateChannelMessages = (w: World, held: Promise<void>) => {
    const orig = w.harnessRelay.channelMessages.bind(w.harnessRelay);
    w.harnessRelay.channelMessages = (channelId: string) => {
      const store = orig(channelId);
      const gated = Object.create(store);
      gated.subscribe = (cb: (state: ChannelMessagesState) => void) =>
        store.subscribe((state) => {
          void held.then(() => cb(state));
        });
      return gated as typeof store;
    };
  };

  it("AC-1 a Stop fired before the send's store row still lands on its first turn", async () => {
    const w = await setupWorld();
    try {
      let releaseStore!: () => void;
      const held = new Promise<void>((r) => (releaseStore = r));
      gateChannelMessages(w, held);
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Add a footer to the page",
      });
      await w.user.request("turns.interrupt", {
        conversationId: conversation.id,
      });
      /* Give the bus event a beat to land before the store path is
         released — on the old code the Stop is dropped here (no binding,
         no bind in flight); on the fix it parks and logs. The wait doubles
         as the red/green boundary. */
      await waitFor(
        () => w.log.lines.find((l) => l.includes("interrupt parked")),
        "interrupt parked",
        2_000,
      ).catch(() => {});
      releaseStore();
      /* The parked Stop fires at the send's first turn.started — the
         engine sees prompt → interrupt, never a silently dropped
         request. */
      const methods = await waitFor(() => {
        const m = w.engineCalls.map((c) => c.method);
        return m.includes("prompt") && m.includes("interrupt") ? m : undefined;
      }, "prompt and interrupt on the engine conn");
      expect(methods.indexOf("prompt")).toBeLessThan(
        methods.indexOf("interrupt"),
      );
      const stopped = await waitFor(async () => {
        const { messages } = await listConvMessages(w.user, channel.id);
        return messages.find((m) => m.text === "Stopped.");
      }, "Stopped. note");
      expect(stopped).toBeTruthy();
    } finally {
      await w.cleanup();
    }
  });

  it("AC-2 a Stop fired while the bind finishes still lands on the first turn", async () => {
    const w = await setupWorld();
    try {
      /* `bindings.set` lands inside bindConversation BEFORE its last await
         (the `conversations.update` that stamps engineRef/state). Hold that
         one RPC: the Esc then arrives with a binding present, no bind flag
         cleared yet, and no prompt anywhere — the stretch where the
         interrupt used to dispatch straight into `interrupted:false`. */
      let releaseUpdate!: () => void;
      const held = new Promise<void>((r) => (releaseUpdate = r));
      let updateHeld = false;
      const orig = w.harnessRelay.request.bind(w.harnessRelay);
      w.harnessRelay.request = ((
        method: string,
        params?: Record<string, unknown>,
      ) => {
        if (
          method === "conversations.update" &&
          (params as { engineRef?: string }).engineRef
        ) {
          updateHeld = true;
          return held.then(() => orig(method, params));
        }
        return orig(method, params);
      }) as typeof w.harnessRelay.request;
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Add a footer to the page",
      });
      await waitFor(
        () => updateHeld || undefined,
        "bind held at conversations.update",
      );
      await w.user.request("turns.interrupt", {
        conversationId: conversation.id,
      });
      /* Let the interrupt land while the bind is still suspended — the fix
         parks it (binding exists, a send is mid-flight) and fires it at
         the send's first turn.started. */
      await waitFor(
        () => w.log.lines.find((l) => l.includes("interrupt parked")),
        "interrupt parked",
        2_000,
      ).catch(() => {});
      releaseUpdate();
      const methods = await waitFor(() => {
        const m = w.engineCalls.map((c) => c.method);
        return m.includes("prompt") && m.includes("interrupt") ? m : undefined;
      }, "prompt and interrupt on the engine conn");
      /* prompt strictly before interrupt — never the `interrupted:false`
         ordering the lost Stop produced. */
      expect(methods.indexOf("prompt")).toBeLessThan(
        methods.indexOf("interrupt"),
      );
      const stopped = await waitFor(async () => {
        const { messages } = await listConvMessages(w.user, channel.id);
        return messages.find((m) => m.text === "Stopped.");
      }, "Stopped. note");
      expect(stopped).toBeTruthy();
    } finally {
      await w.cleanup();
    }
  });

  it("AC-3 a parked Stop dies with its send — a removed send can't leak it onto a later turn", async () => {
    const w = await setupWorld();
    try {
      let releaseStore!: () => void;
      const held = new Promise<void>((r) => (releaseStore = r));
      gateChannelMessages(w, held);
      const { channel } = await openDmConversation(w.user);
      const { conversation, rootMessage } = await w.user.request<{
        conversation: { id: string };
        rootMessage: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Add a footer to the page",
      });
      await w.user.request("turns.interrupt", {
        conversationId: conversation.id,
      });
      await waitFor(
        () => w.log.lines.find((l) => l.includes("interrupt parked")),
        "interrupt parked",
        2_000,
      ).catch(() => {});
      // The send the Stop waited on is removed before its row delivers.
      await w.user.request("messages.remove", { messageId: rootMessage.id });
      releaseStore();
      // A later send runs its turn unimpeded — no stray interrupt.
      await postMessage(
        w.user,
        channel.id,
        conversation.id,
        "Summarize the repo layout",
      );
      const answer = await waitFor(async () => {
        const { messages } = await listConvMessages(w.user, channel.id);
        return messages.find(
          (m) =>
            m.authorKind === "employee" && m.conversationId === conversation.id,
        );
      }, "employee answer");
      expect(answer).toBeTruthy();
      expect(
        w.engineCalls.filter((c) => c.method === "interrupt"),
      ).toHaveLength(0);
    } finally {
      await w.cleanup();
    }
  });
});

/* #315 — the waiting tray's engine-side contract. Remove on a queued
   message must mean the engine never sees it (AC-4); ■ Stop parks every
   wait into the not-sent tray with nothing auto-running after (AC-5); and
   Send re-delivers a parked message as a real turn. */
describe("waiting tray (#315)", () => {
  const listDropped = (user: RelayClient, channelId: string) =>
    user.request<{ messages: AppMessage[] }>("messages.list", {
      channelId,
      limit: 200,
      includeDropped: true,
    });

  it("AC-4 removing a queued message drops it from binding.queue — the engine never gets it", {
    timeout: 20_000,
  }, async () => {
    /* No `steer` capability → a mid-turn send queues behind the running
         turn instead of steering it. */
    const w = await setupWorld(1, true, { capabilities: { steer: false } });
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Add a footer to the page", // parks mid-turn on an approval
      });
      await waitFor(() => w.sleep.held || undefined, "turn running");
      const { message: mid } = await postMessage(
        w.user,
        channel.id,
        conversation.id,
        "never mind that",
      );
      await waitFor(
        () => w.log.lines.find((l) => l.includes("queued behind running turn")),
        "message queued behind the turn",
      );

      await w.user.request("messages.remove", { messageId: mid.id });

      /* Let the parked turn finish — the queue must drain nothing. On a
         miss, the harness log says whether message.changed even landed. */
      const approveAll = async () => {
        const { asks } = await w.user.request<{ asks: Ask[] }>("asks.list", {
          conversationId: conversation.id,
          state: "open",
        });
        for (const a of asks)
          await w.user.request("asks.respond", {
            askId: a.id,
            outcome: "once",
          });
      };
      await waitFor(async () => {
        await approveAll();
        const { messages } = await listConvMessages(w.user, channel.id);
        return messages.find(
          (m) =>
            m.authorKind === "employee" && m.conversationId === conversation.id,
        );
      }, "turn answer").catch((e) => {
        throw new Error(`${e.message}\n${w.log.lines.join("\n")}`);
      });
      // The engine saw the parked prompt only — the removed text never
      // went out as a prompt (and never would, on any later drain).
      const prompts = w.engineCalls.filter((c) => c.method === "prompt");
      expect(
        prompts.filter((p) =>
          JSON.stringify(p.params).includes("never mind that"),
        ),
      ).toEqual([]);
      // And the row is gone from every list — the tray's truth is the
      // relay, so reload agrees.
      const { messages } = await listConvMessages(w.user, channel.id);
      expect(messages.find((m) => m.id === mid.id)).toBeUndefined();
    } finally {
      await w.cleanup();
    }
  });

  it("AC-4 Remove on an already-consumed send is refused — the action isn't offered", {
    timeout: 20_000,
  }, async () => {
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Add a footer to the page",
      });
      // The turn must be running first — a post that outraces turn.started
      // becomes a second prompt, not a steer.
      await waitFor(() => w.sleep.held || undefined, "turn running");
      // A steered message is consumed the moment session.steer acks.
      const { message: mid } = await postMessage(
        w.user,
        channel.id,
        conversation.id,
        "steer it left",
      );
      // `session.steer` acks first; the deliveredSeq write lands right
      // after — Remove is refused only once the watermark proves the
      // engine consumed it.
      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; deliveredSeq: number }[];
        }>("conversations.list", {});
        const c = conversations.find((x) => x.id === conversation.id);
        return c && c.deliveredSeq >= mid.seq ? c : undefined;
      }, "deliveredSeq past the steer");
      await expect(
        w.user.request("messages.remove", { messageId: mid.id }),
      ).rejects.toThrow(/already delivered/);
    } finally {
      await w.cleanup();
    }
  });

  it("AC-5 Stop parks every wait into the not-sent tray; Send runs it later — nothing auto-runs", {
    timeout: 20_000,
  }, async () => {
    const w = await setupWorld();
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "Add a footer to the page", // parks on its approval ask
      });
      /* Wait for the approval to OPEN — the turn is parked past its last
         tool boundary, so mid-turn sends steer in but never land before
         the Stop (drainSteers only runs at a boundary). */
      await waitFor(async () => {
        const { asks } = await w.user.request<{ asks: Ask[] }>("asks.list", {
          conversationId: conversation.id,
          state: "open",
        });
        return asks.find((a) => a.request.kind === "approval");
      }, "open approval ask");
      // Two mid-turn sends become accepted-but-unlanded steers.
      const { message: a } = await postMessage(
        w.user,
        channel.id,
        conversation.id,
        "first nudge",
      );
      const { message: b } = await postMessage(
        w.user,
        channel.id,
        conversation.id,
        "second nudge",
      );
      await waitFor(
        () =>
          w.engineCalls.filter((c) => c.method === "session.steer").length >=
            2 || undefined,
        "both steers accepted",
      );

      await w.user.request("turns.interrupt", {
        conversationId: conversation.id,
      });

      // Both waits park as dropped rows — invisible to normal reads.
      const parked = await waitFor(async () => {
        const { messages } = await listDropped(w.user, channel.id);
        const drops = messages.filter((m) => m.dropped);
        return drops.length === 2 ? drops : undefined;
      }, "both waits parked").catch((e) => {
        const calls = w.engineCalls.map((c) => c.method).join(",");
        throw new Error(
          `${e.message}\nengineCalls: ${calls}\n${w.log.lines.join("\n")}`,
        );
      });
      expect(parked.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
      const { messages: visible } = await listConvMessages(w.user, channel.id);
      expect(
        visible.find((m) => m.id === a.id || m.id === b.id),
      ).toBeUndefined();

      // Nothing auto-runs after the stop: the parked texts never prompt.
      await new Promise((r) => setTimeout(r, 300));
      const prompts = () =>
        w.engineCalls
          .filter((c) => c.method === "prompt")
          .map((c) => JSON.stringify(c.params));
      expect(prompts()).toHaveLength(1);
      expect(prompts()[0]).toContain("Add a footer to the page");

      // Send re-delivers it as a normal next prompt.
      await w.user.request("messages.send", { messageId: b.id });
      await waitFor(
        () => prompts().find((p) => p.includes("second nudge")),
        "parked message prompts on Send",
      );
      // The other parked row stays parked.
      const { messages: after } = await listDropped(w.user, channel.id);
      const still = after.find((m) => m.id === a.id);
      expect(still?.dropped).toBe(true);
    } finally {
      await w.cleanup();
    }
  });
});
