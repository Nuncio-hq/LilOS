import type { RelaySocket, SocketFactory } from "@lilos/client-runtime";
import { RelayClient } from "@lilos/client-runtime";
import type { AppMessage, Ask, WelcomeResult } from "@lilos/contracts/app";
import { connectFake, FakeEngine } from "@lilos/engine-fake";
import { describe, expect, it } from "vitest";
import { createRelay } from "../../relay/src/session";
import { createMemoryStore } from "../../relay/src/store";
import { connectEngineWs, type EngineConnection } from "../src/engine/client";
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
  harness: Harness;
  sleep: ReturnType<typeof createFakeSleepGuard>;
  user: RelayClient;
  log: ReturnType<typeof createMemoryLogger>;
  cleanup: () => Promise<void>;
}

async function setupWorld(tick = 1, attachEngine = true): Promise<World> {
  const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
  const engine = new FakeEngine({ tick });
  const engineConn = connectFake(engine) as unknown as EngineConnection;
  const sleep = createFakeSleepGuard();
  const log = createMemoryLogger();
  const harnessRelay = new RelayClient({
    url: "mem://harness",
    token: TOKEN,
    socketFactory: socketFor(relay),
  });
  const harness = new Harness({
    relay: harnessRelay,
    sleep,
    workdir: "/tmp/lilos-test",
    log,
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

      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {});
        const c = conversations.find((x) => x.id === conversation.id);
        return c?.engineRef === newRef ? newRef : undefined;
      }, "engineRef rebind");

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
          sessions: Map<string, { turn?: unknown; openRequests: Map<string, unknown> }>;
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
      expect(sess).toBeDefined();
      sess!.turn = undefined;
      sess!.openRequests.clear();

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
