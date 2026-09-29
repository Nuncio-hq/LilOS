import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelaySocket, SocketFactory } from "@lilos/client-runtime";
import { RelayClient } from "@lilos/client-runtime";
import type { AppMessage } from "@lilos/contracts/app";
import { connectFake, FakeEngine } from "@lilos/engine-fake";
import type { CheckpointStore } from "@lilos/host";
import { describe, expect, it } from "vitest";
import { createRelay } from "../../relay/src/session";
import { createMemoryStore } from "../../relay/src/store";
import type { EngineConnection } from "../src/engine/client";
import { Harness } from "../src/harness";
import { createMemoryLogger } from "../src/log";
import { createFakeSleepGuard } from "../src/sleep";

/**
 * Issue #134 harness leg: the checkpoint stamp on each user message, the
 * `conversations.rewind` host call (files + engine), the running-turn
 * refusal, and the queued-message prune. Same in-process world as
 * folder-cwd.test.ts, kept in its own file to dodge sibling-PR conflicts.
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
  timeoutMs = 15_000,
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

/** Checkpoint-store stub: ids count snapshots, restore calls are recorded. */
function stubCheckpoints() {
  let n = 0;
  const calls: { snapshots: string[]; restores: [string, string][] } = {
    snapshots: [],
    restores: [],
  };
  const store: CheckpointStore = {
    snapshot: async (cwd: string) => {
      calls.snapshots.push(cwd);
      return `ck-${++n}`;
    },
    restore: async (cwd: string, checkpoint: string) => {
      calls.restores.push([cwd, checkpoint]);
      return { removed: [], restoredTo: checkpoint };
    },
    list: async () => [],
    prune: async () => {},
  };
  return { store, calls };
}

async function setupWorld(opts?: {
  engine?: FakeEngine;
  attachEngine?: boolean;
}) {
  const workdir = mkdtempSync(join(tmpdir(), "lilos-rewind-"));
  const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
  const engine = opts?.engine ?? new FakeEngine({ tick: 1 });
  const engineConn = connectFake(engine) as unknown as EngineConnection;
  const checkpoints = stubCheckpoints();
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
    workdir,
    log,
    checkpoints: checkpoints.store,
  });
  if (opts?.attachEngine !== false) harness.attachEngine(engineConn);
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
    checkpoints,
    harness,
    user,
    workdir,
    cleanup: async () => {
      user.close();
      await harness.stop();
      rmSync(workdir, { recursive: true, force: true });
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

async function sendAndAnswer(
  user: RelayClient,
  channelId: string,
  conversationId: string | undefined,
  text: string,
) {
  if (conversationId) {
    await user.request("messages.post", {
      channelId,
      conversationId,
      text,
    });
  } else {
    const opened = await user.request<{ conversation: { id: string } }>(
      "conversations.open",
      { channelId, text },
    );
    conversationId = opened.conversation.id;
  }
  const messages = await waitFor(
    async () => {
      const { messages } = await user.request<{ messages: AppMessage[] }>(
        "messages.list",
        { channelId, conversationId, limit: 100 },
      );
      const last = messages.at(-1);
      return last?.authorKind === "employee" ? messages : undefined;
    },
    `employee answer to "${text.slice(0, 30)}"`,
  );
  return { conversationId, messages };
}

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

describe("conversations.rewind — harness leg (#134)", () => {
  it("stamps the pre-turn folder checkpoint on the user message", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversationId } = await sendAndAnswer(
        w.user,
        channel.id,
        undefined,
        "look around",
      );
      const { messages } = await waitFor(async () => {
        const { messages } = await conversationMessages(
          w.user,
          channel.id,
          conversationId,
        );
        return messages.find((m) => m.authorKind === "user")?.checkpoint
          ? { messages }
          : undefined;
      }, "checkpoint stamped on the user message");
      const userMsg = messages.find((m) => m.authorKind === "user");
      expect(userMsg?.checkpoint).toBe("ck-1");
      expect(w.checkpoints.calls.snapshots).toEqual([w.workdir]);
    } finally {
      await w.cleanup();
    }
  });

  it("rewind restores the checkpoint and drops the engine's turns", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversationId, messages: first } = await sendAndAnswer(
        w.user,
        channel.id,
        undefined,
        "remember alpha",
      );
      void first;
      /* sendAndAnswer returns after the turn — and the stamp lands before
         the prompt — so both messages already carry checkpoints. */
      const { messages: second } = await sendAndAnswer(
        w.user,
        channel.id,
        conversationId,
        "remember beta",
      );
      const msg2 = second
        .filter((m) => m.authorKind === "user")
        .find((m) => m.text === "remember beta");
      if (!msg2) throw new Error("user message 'remember beta' not posted");
      // Rewind "to before" msg2: msg1's turn stays, msg2's drops.
      const res = await w.user.request<{
        engineRewound: boolean;
        filesRestored: boolean;
        removedCount: number;
        removedIds: string[];
      }>("conversations.rewind", {
        conversationId,
        messageId: msg2.id,
      });
      expect(res.engineRewound).toBe(true);
      expect(res.filesRestored).toBe(true);
      expect(res.removedCount).toBeGreaterThanOrEqual(2);
      // The folder restored to the checkpoint stamped on the target message.
      expect(w.checkpoints.calls.restores).toEqual([[w.workdir, "ck-2"]]);

      // The tail is gone from the thread…
      const { messages } = await conversationMessages(
        w.user,
        channel.id,
        conversationId,
      );
      const visible = messages.filter((m) => !m.rewound);
      expect(visible.some((m) => m.text === "remember beta")).toBe(false);

      // …and from the agent's memory: a recall probe names only turn 1.
      const { messages: probed } = await sendAndAnswer(
        w.user,
        channel.id,
        conversationId,
        "recall: what do you remember?",
      );
      const answer = probed.at(-1)?.text ?? "";
      expect(answer).toContain("remember alpha");
      expect(answer).not.toContain("remember beta");
    } finally {
      await w.cleanup();
    }
  });

  it("AC-5: refuses -32009 while a turn is running", async () => {
    // Slow fake: the answer takes long enough that the rewind lands mid-turn.
    const w = await setupWorld({ engine: new FakeEngine({ tick: 150 }) });
    try {
      const channel = await openDm(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", { channelId: channel.id, text: "work work" });
      const msg1 = await waitFor(async () => {
        const { messages } = await conversationMessages(
          w.user,
          channel.id,
          conversation.id,
        );
        return messages.find((m) => m.authorKind === "user");
      }, "root user message");
      const conflict = await waitFor(async () => {
        try {
          await w.user.request("conversations.rewind", {
            conversationId: conversation.id,
            messageId: msg1.id,
          });
          return undefined;
        } catch (e) {
          const code = (e as { data?: { code?: string } }).data?.code;
          return code === "conflict" ? code : undefined;
        }
      }, "running-turn conflict");
      expect(conflict).toBe("conflict");
      /* NB: polling only proves the refusal — once the turn finishes a
         retried rewind legitimately succeeds (the "drops turns" test above
         covers the happy path). */
    } finally {
      await w.cleanup();
    }
  }, 15_000);

  it("capability absent: files restore, engine keeps its turns (AC-3)", async () => {
    const w = await setupWorld({
      engine: new FakeEngine({ tick: 1, capabilities: { rewind: false } }),
    });
    try {
      const channel = await openDm(w.user);
      const { conversationId, messages: first } = await sendAndAnswer(
        w.user,
        channel.id,
        undefined,
        "remember alpha",
      );
      void first;
      const { messages: second } = await sendAndAnswer(
        w.user,
        channel.id,
        conversationId,
        "remember beta",
      );
      const msg2 = second
        .filter((m) => m.authorKind === "user")
        .find((m) => m.text === "remember beta");
      if (!msg2) throw new Error("user message 'remember beta' not posted");
      const res = await w.user.request<{
        engineRewound: boolean;
        filesRestored: boolean;
      }>("conversations.rewind", {
        conversationId,
        messageId: msg2.id,
      });
      expect(res.engineRewound).toBe(false);
      expect(res.filesRestored).toBe(true);
      expect(w.checkpoints.calls.restores).toEqual([[w.workdir, "ck-2"]]);

      // The engine still remembers: a recall probe names both turns.
      const { messages: probed } = await sendAndAnswer(
        w.user,
        channel.id,
        conversationId,
        "recall: what do you remember?",
      );
      const answer = probed.at(-1)?.text ?? "";
      expect(answer).toContain("remember alpha");
      expect(answer).toContain("remember beta");
    } finally {
      await w.cleanup();
    }
  });

  it("queued-behind-start messages at/after the rewind point never send", async () => {
    /* No engine yet: messages post before a binding exists land in the
       harness's `early` hold — a rewind must prune the tail or the dropped
       message would still prompt once the engine connects. */
    const w = await setupWorld({ attachEngine: false });
    try {
      const channel = await openDm(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", { channelId: channel.id, text: "first" });
      const { message: second } = await w.user.request<{
        message: AppMessage;
      }>("messages.post", {
        channelId: channel.id,
        conversationId: conversation.id,
        text: "second — should be rewound",
      });
      // Rewind "to before" msg2: the queued second send must never prompt.
      await w.user.request("conversations.rewind", {
        conversationId: conversation.id,
        messageId: second.id,
      });
      // Now the engine connects; only the surviving message may prompt.
      const prompts: unknown[] = [];
      const orig = w.engineConn.request.bind(w.engineConn);
      w.engineConn.request = <T = unknown>(
        method: string,
        params?: unknown,
      ): Promise<T> => {
        if (method === "prompt") prompts.push(params);
        return orig<T>(method, params);
      };
      w.harness.attachEngine(w.engineConn);
      await waitFor(async () => {
        const { messages } = await conversationMessages(
          w.user,
          channel.id,
          conversation.id,
        );
        return messages.find((m) => m.authorKind === "employee")
          ? true
          : undefined;
      }, "engine answer after attach");
      const texts = prompts.map((p) => JSON.stringify(p));
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain("first");
      expect(texts[0]).not.toContain("second");
    } finally {
      await w.cleanup();
    }
  });
});
