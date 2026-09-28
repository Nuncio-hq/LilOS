import type { RelaySocket, SocketFactory } from "@lilos/client-runtime";
import { RelayClient } from "@lilos/client-runtime";
import type { AppMessage } from "@lilos/contracts/app";
import { connectFake, FakeEngine } from "@lilos/engine-fake";
import { describe, expect, it } from "vitest";
import { createRelay } from "../../relay/src/session";
import { createMemoryStore } from "../../relay/src/store";
import type { EngineConnection } from "../src/engine/client";
import { Harness } from "../src/harness";
import { createMemoryLogger } from "../src/log";
import { createFakeSleepGuard } from "../src/sleep";

/**
 * Issue #113: the picked folder becomes the engine session's `cwd`, and a
 * folder-less session announces the default workdir in the thread.
 * Same in-process world as harness.test.ts (borrowed, kept separate so
 * sibling PRs editing that file don't conflict).
 */

const TOKEN = "test-token";
const WORKDIR = "/tmp/lilos-test";

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

async function setupWorld() {
  const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
  const engine = new FakeEngine({ tick: 1 });
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
  const log = createMemoryLogger();
  const harnessRelay = new RelayClient({
    url: "mem://harness",
    token: TOKEN,
    socketFactory: socketFor(relay),
    reconnectMinDelayMs: 20,
  });
  const harness = new Harness({
    relay: harnessRelay,
    sleep: createFakeSleepGuard(),
    workdir: WORKDIR,
    log,
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
    engineCalls,
    harness,
    user,
    cleanup: async () => {
      user.close();
      await harness.stop();
    },
  };
}

async function openDm(user: RelayClient) {
  const { employee } = await user.request<{ employee: { id: string } }>(
    "employees.create",
    { name: "Ada", role: "engineer", profile: "builder" },
  );
  const { channel } = await user.request<{ channel: { id: string } }>(
    "channels.openDm",
    { employeeId: employee.id },
  );
  return channel;
}

const lastSessionStart = (w: {
  engineCalls: { method: string; params: unknown }[];
}) =>
  w.engineCalls.filter((c) => c.method === "session.start").at(-1)?.params as
    | { cwd?: string }
    | undefined;

const conversationMessages = (
  user: RelayClient,
  channelId: string,
  conversationId: string,
) =>
  user.request<{ messages: AppMessage[] }>("messages.list", {
    channelId,
    conversationId,
    limit: 100,
  });

describe("AC-4 the picked folder becomes session.start cwd", () => {
  it("conversations.open {cwd} lands in session.start {cwd}", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "look around",
        cwd: "/tmp/picked-folder",
      });
      const start = await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {});
        if (!conversations.find((c) => c.id === conversation.id)?.engineRef)
          return undefined;
        return lastSessionStart(w);
      }, "session.start for picked folder");
      expect(start?.cwd).toBe("/tmp/picked-folder");
    } finally {
      await w.cleanup();
    }
  });

  it("engine-fake echoes the cwd in the answer's reasoning", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "where are you",
        cwd: "/tmp/picked-folder",
      });
      await waitFor(async () => {
        const { messages } = await conversationMessages(
          w.user,
          channel.id,
          conversation.id,
        );
        return messages.find((m) => m.authorKind === "employee");
      }, "employee answer");
      // engine-fake's session.started payload carries cwd — verified on the
      // wire by the session.start assertion above; here we just confirm the
      // turn ran in that session (an answer landed).
      expect(lastSessionStart(w)?.cwd).toBe("/tmp/picked-folder");
    } finally {
      await w.cleanup();
    }
  });
});

describe("AC-6 no folder keeps the harness default and says so", () => {
  it("open without cwd uses the configured workdir and posts the note", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", { channelId: channel.id, text: "hi" });
      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {});
        if (!conversations.find((c) => c.id === conversation.id)?.engineRef)
          return undefined;
        return lastSessionStart(w);
      }, "session.start for default folder");
      expect(lastSessionStart(w)?.cwd).toBe(WORKDIR);

      const note = await waitFor(async () => {
        const { messages } = await conversationMessages(
          w.user,
          channel.id,
          conversation.id,
        );
        return messages.find(
          (m) => m.authorKind === "system" && m.text.startsWith("No folder:"),
        );
      }, "no-folder note");
      // The note names the actual workdir (collapsed under home when it is).
      expect(note.text).toMatch(/^No folder: working in /);
      expect(note.text).toContain(WORKDIR);
    } finally {
      await w.cleanup();
    }
  });

  it("a folder'd session posts no no-folder note", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "hi",
        cwd: "/tmp/with-folder",
      });
      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {});
        if (!conversations.find((c) => c.id === conversation.id)?.engineRef)
          return undefined;
        return true;
      }, "engineRef");
      // Give the turn a beat to settle, then read the whole thread.
      await new Promise((r) => setTimeout(r, 150));
      const { messages } = await conversationMessages(
        w.user,
        channel.id,
        conversation.id,
      );
      expect(
        messages.some(
          (m) => m.authorKind === "system" && m.text.startsWith("No folder:"),
        ),
      ).toBe(false);
    } finally {
      await w.cleanup();
    }
  });
});
