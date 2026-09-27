import type { RelaySocket, SocketFactory } from "@lilos/client-runtime";
import { RelayClient } from "@lilos/client-runtime";
import type { AppMessage } from "@lilos/contracts/app";
import { connectFake, FakeEngine } from "@lilos/engine-fake";
import { describe, expect, it } from "vitest";
import { MODEL_CATALOG } from "../../../packages/engine-fake/src/catalog";
import { createRelay } from "../../relay/src/session";
import { createMemoryStore } from "../../relay/src/store";
import type { EngineConnection } from "../src/engine/client";
import { Harness } from "../src/harness";
import { createMemoryLogger } from "../src/log";
import { createFakeSleepGuard } from "../src/sleep";

/**
 * Model picker wire path (issue #30): `conversations.setModel` →
 * `conversation.modelRequested` → harness `session.setModel` → the next
 * turn's `turn.started.model` lands on the answer message. Same in-memory
 * world as harness.test.ts: real relay protocol machine, real engine-fake.
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
  engine?: FakeEngine;
  engineConn?: EngineConnection;
  harness: Harness;
  user: RelayClient;
  cleanup: () => Promise<void>;
}

async function setupWorld(
  opts: { engine?: FakeEngine | null } = {},
): Promise<World> {
  const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
  const engine =
    opts.engine === null
      ? undefined
      : (opts.engine ?? new FakeEngine({ tick: 1 }));
  const harnessRelay = new RelayClient({
    url: "mem://harness",
    token: TOKEN,
    socketFactory: socketFor(relay),
  });
  const harness = new Harness({
    relay: harnessRelay,
    sleep: createFakeSleepGuard(),
    workdir: "/tmp/lilos-test",
    log: createMemoryLogger(),
  });
  let engineConn: EngineConnection | undefined;
  if (engine) {
    engineConn = connectFake(engine) as unknown as EngineConnection;
    harness.attachEngine(engineConn);
  }
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
    harness,
    user,
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
  const { conversation } = await user.request<{
    conversation: { id: string; model?: string };
  }>("conversations.open", { channelId: channel.id, text: "hello" });
  return { employee, channel, conversation };
}

const getConversation = (user: RelayClient, id: string) =>
  user
    .request<{ conversations: { id: string; model?: string }[] }>(
      "conversations.list",
      {},
    )
    .then((r) => r.conversations.find((c) => c.id === id));

const listMessages = (user: RelayClient, channelId: string) =>
  user.request<{ messages: AppMessage[] }>("messages.list", {
    channelId,
    limit: 50,
  });

describe("model pick wire path (issue #30)", () => {
  it("AC-2 the pick pins the session; the next turn's answer carries turn.started.model", async () => {
    const w = await setupWorld();
    try {
      const { channel, conversation } = await openDmConversation(w.user);
      // Wait for the engine session to bind before picking.
      await waitFor(async () => {
        const c = await getConversation(w.user, conversation.id);
        return c && (c as { engineRef?: string | null }).engineRef
          ? c
          : undefined;
      }, "engine session binding");

      const res = await w.user.request<{ ok: boolean }>(
        "conversations.setModel",
        { conversationId: conversation.id, model: "fake-small" },
      );
      expect(res.ok).toBe(true);

      // The engine acked; the canonical id lands on the conversation.
      await waitFor(async () => {
        const c = await getConversation(w.user, conversation.id);
        return c?.model === "fake-small" ? c : undefined;
      }, "conversation.model");

      // Next turn: the answer's message.model is the engine's turn.started.model.
      await w.user.request("messages.post", {
        channelId: channel.id,
        conversationId: conversation.id,
        text: "and now?",
        authorKind: "user",
      });
      const answers = await waitFor(async () => {
        const { messages } = await listMessages(w.user, channel.id);
        const list = messages.filter(
          (m) =>
            m.authorKind === "employee" && m.conversationId === conversation.id,
        );
        return list.length >= 2 ? list : undefined;
      }, "second answer");
      const picked = answers[answers.length - 1];
      expect(picked.model).toBe("fake-small");
    } finally {
      await w.cleanup();
    }
  });

  it("AC-2b a pick made before binding rides session.start", async () => {
    // No engine attached yet: the pick pins conversation.model and the harness
    // applies it in session.start params once the session exists.
    const w = await setupWorld({ engine: null });
    try {
      const { channel, conversation } = await openDmConversation(w.user);
      await w.user.request("conversations.setModel", {
        conversationId: conversation.id,
        model: "fake-reasoning",
      });
      await waitFor(async () => {
        const c = await getConversation(w.user, conversation.id);
        return c?.model === "fake-reasoning" ? c : undefined;
      }, "conversation.model pin");

      const engine = new FakeEngine({ tick: 1 });
      w.harness.attachEngine(
        connectFake(engine) as unknown as EngineConnection,
      );
      const answer = await waitFor(async () => {
        const { messages } = await listMessages(w.user, channel.id);
        return messages.find(
          (m) =>
            m.authorKind === "employee" && m.conversationId === conversation.id,
        );
      }, "first answer after attach");
      expect(answer.model).toBe("fake-reasoning");
    } finally {
      await w.cleanup();
    }
  });

  it("AC-4 effort + fast ride the pick; the next turn's answer carries them", async () => {
    const w = await setupWorld();
    try {
      const { channel, conversation } = await openDmConversation(w.user);
      await waitFor(async () => {
        const c = await getConversation(w.user, conversation.id);
        return c && (c as { engineRef?: string | null }).engineRef
          ? c
          : undefined;
      }, "engine session binding");

      await w.user.request("conversations.setModel", {
        conversationId: conversation.id,
        model: "fake-reasoning",
        provider: "fake",
        effort: "xhigh",
        fast: true,
      });
      await waitFor(async () => {
        const c = (await getConversation(w.user, conversation.id)) as
          | {
              model?: string;
              provider?: string;
              effort?: string;
              fast?: boolean;
            }
          | undefined;
        return c?.model === "fake-reasoning" &&
          c.effort === "xhigh" &&
          c.fast === true
          ? c
          : undefined;
      }, "conversation pick fields");

      await w.user.request("messages.post", {
        channelId: channel.id,
        conversationId: conversation.id,
        text: "and now?",
        authorKind: "user",
      });
      const answers = await waitFor(async () => {
        const { messages } = await listMessages(w.user, channel.id);
        const list = messages.filter(
          (m) =>
            m.authorKind === "employee" && m.conversationId === conversation.id,
        );
        return list.length >= 2 ? list : undefined;
      }, "second answer");
      const picked = answers[answers.length - 1];
      // turn.started.model/provider/effort/fast stamp the answer's footer.
      expect(picked.model).toBe("fake-reasoning");
      expect(picked.provider).toBe("fake");
      expect(picked.effort).toBe("xhigh");
      expect(picked.fast).toBe(true);
    } finally {
      await w.cleanup();
    }
  });

  it("AC-4 a mid-turn pick is held, applied at turn end, and lands on the next turn", async () => {
    // Slow turn so the pick lands mid-run. The harness holds it — the engine
    // sees no setModel while a turn runs (a live fast flip would be checked
    // against the OLD model and provider overrides could ride onto the new
    // one) — then applies it on the idle session before the next prompt.
    const w = await setupWorld({ engine: new FakeEngine({ tick: 20 }) });
    try {
      const { channel, conversation } = await openDmConversation(w.user);
      // `state: active` means turn.started landed — runningTurnId is set.
      await waitFor(async () => {
        const c = (await getConversation(w.user, conversation.id)) as
          | { state?: string }
          | undefined;
        return c?.state === "active" ? c : undefined;
      }, "turn running");

      // Watch the engine wire: no setModel may go out while the turn runs.
      if (!w.engineConn) throw new Error("engine not attached");
      const calls: string[] = [];
      const orig = w.engineConn.request.bind(w.engineConn);
      w.engineConn.request = <T>(
        method: string,
        params?: unknown,
        timeoutMs?: number,
      ) => {
        calls.push(method);
        return orig<T>(method, params, timeoutMs);
      };

      const res = await w.user.request<{ ok: boolean }>(
        "conversations.setModel",
        {
          conversationId: conversation.id,
          model: "fake-reasoning",
          provider: "fake",
          effort: "high",
          fast: true,
        },
      );
      expect(res.ok).toBe(true);

      // The running turn's answer keeps the pick it started on — and no
      // setModel reached the engine while it ran.
      const first = await waitFor(async () => {
        const { messages } = await listMessages(w.user, channel.id);
        return messages.find(
          (m) =>
            m.authorKind === "employee" && m.conversationId === conversation.id,
        );
      }, "first answer");
      expect(first.model).not.toBe("fake-reasoning");
      expect(calls).not.toContain("session.setModel");

      // The conversation row already carries the new pick (picker intent).
      await waitFor(async () => {
        const c = (await getConversation(w.user, conversation.id)) as
          | {
              model?: string;
              provider?: string;
              effort?: string;
              fast?: boolean;
            }
          | undefined;
        return c?.model === "fake-reasoning" && c.fast === true ? c : undefined;
      }, "held pick on the conversation");

      await w.user.request("messages.post", {
        channelId: channel.id,
        conversationId: conversation.id,
        text: "and now?",
        authorKind: "user",
      });
      const answers = await waitFor(async () => {
        const { messages } = await listMessages(w.user, channel.id);
        const list = messages.filter(
          (m) =>
            m.authorKind === "employee" && m.conversationId === conversation.id,
        );
        return list.length >= 2 ? list : undefined;
      }, "second answer");
      const picked = answers[answers.length - 1];
      expect(picked.model).toBe("fake-reasoning");
      expect(picked.effort).toBe("high");
      expect(picked.fast).toBe(true);
      // The held pick applied on the idle session, before the second prompt.
      const setModelIdx = calls.indexOf("session.setModel");
      const lastPromptIdx = calls.lastIndexOf("prompt");
      expect(setModelIdx).toBeGreaterThanOrEqual(0);
      expect(setModelIdx).toBeLessThan(lastPromptIdx);
    } finally {
      await w.cleanup();
    }
  }, 20_000);

  it("AC-5 conversations.open's pick reaches the very first turn", async () => {
    const w = await setupWorld();
    try {
      const { employee } = await w.user.request<{ employee: { id: string } }>(
        "employees.create",
        { name: "Ada", role: "engineer", profile: "builder" },
      );
      const { channel } = await w.user.request<{ channel: { id: string } }>(
        "channels.openDm",
        { employeeId: employee.id },
      );
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "hello",
        model: "fake-reasoning",
        provider: "fake",
        effort: "high",
        fast: true,
      });
      // The session didn't exist yet — session.start must have seen the pick.
      const answer = await waitFor(async () => {
        const { messages } = await listMessages(w.user, channel.id);
        return messages.find(
          (m) =>
            m.authorKind === "employee" && m.conversationId === conversation.id,
        );
      }, "first answer");
      expect(answer.model).toBe("fake-reasoning");
      expect(answer.effort).toBe("high");
      expect(answer.fast).toBe(true);
    } finally {
      await w.cleanup();
    }
  });

  it("AC-6 models.list {refresh:true} passes through to the engine", async () => {
    const w = await setupWorld();
    try {
      const before = await w.user.request<{
        models: { id: string }[];
        providers?: { id: string }[];
      }>("models.list", {});
      expect(before.models.some((m) => m.id === "fake-fresh")).toBe(false);
      expect(before.providers?.some((p) => p.id === "fake")).toBe(true);
      const after = await w.user.request<{ models: { id: string }[] }>(
        "models.list",
        { refresh: true },
      );
      expect(after.models.some((m) => m.id === "fake-fresh")).toBe(true);
    } finally {
      await w.cleanup();
    }
  });

  it("AC-3 an engine without the models capability refuses cleanly (no pin, system note)", async () => {
    const w = await setupWorld({
      engine: new FakeEngine({ tick: 1, capabilities: { models: false } }),
    });
    try {
      const { channel, conversation } = await openDmConversation(w.user);
      await waitFor(async () => {
        const c = await getConversation(w.user, conversation.id);
        return c && (c as { engineRef?: string | null }).engineRef
          ? c
          : undefined;
      }, "engine session binding");
      /* Pick once the opening turn is done — mid-turn picks are held and
         only surface their refusal when the pick applies at the next
         prompt (#92). */
      await waitFor(async () => {
        const { messages } = await listMessages(w.user, channel.id);
        return messages.find(
          (m) =>
            m.authorKind === "employee" && m.conversationId === conversation.id,
        );
      }, "first answer");

      // describe() no longer advertises the capability.
      if (!w.engineConn) throw new Error("engine not attached");
      const describe = await w.engineConn.request<{
        capabilities: { id: string }[];
      }>("describe", {});
      expect(describe.capabilities.some((c) => c.id === "models")).toBe(false);

      // A client picking anyway gets a refusal, not a silent pin: the engine
      // rejects session.setModel and the harness surfaces it as a system note.
      await w.user.request("conversations.setModel", {
        conversationId: conversation.id,
        model: "fake-small",
      });
      const note = await waitFor(async () => {
        const { messages } = await listMessages(w.user, channel.id);
        return messages.find(
          (m) =>
            m.authorKind === "system" && m.text.includes("Couldn't switch"),
        );
      }, "model-refusal system note");
      expect(note.text).toContain("fake-small");
      const conv = await getConversation(w.user, conversation.id);
      expect(conv?.model).toBeUndefined();
    } finally {
      await w.cleanup();
    }
  });

  it("AC-4 a held pick that fails on apply restores the row and the turn still answers", async () => {
    const w = await setupWorld({ engine: new FakeEngine({ tick: 20 }) });
    try {
      const { channel, conversation } = await openDmConversation(w.user);
      // `state: active` means turn.started landed — the pick below is held.
      await waitFor(async () => {
        const c = (await getConversation(w.user, conversation.id)) as
          | { state?: string }
          | undefined;
        return c?.state === "active" ? c : undefined;
      }, "turn running");

      await w.user.request("conversations.setModel", {
        conversationId: conversation.id,
        model: "fake/opus-2",
        provider: "fake",
        effort: "high",
      });
      // The pick's intent lands on the row while the turn still runs.
      await waitFor(async () => {
        const c = (await getConversation(w.user, conversation.id)) as
          | { model?: string }
          | undefined;
        return c?.model === "fake/opus-2" ? c : undefined;
      }, "held pick intent on the conversation");
      await waitFor(async () => {
        const { messages } = await listMessages(w.user, channel.id);
        return messages.find(
          (m) =>
            m.authorKind === "employee" && m.conversationId === conversation.id,
        );
      }, "first answer");

      /* The picked model is gone before the held apply runs (a refresh
         dropped it). The failed apply must restore the row to what the
         session actually runs — a dead pick can't linger and retry forever
         — post a pick-specific note, and the next turn answers on the
         model the session kept (#92 review). */
      const idx = MODEL_CATALOG.findIndex((m) => m.id === "fake/opus-2");
      const removed = MODEL_CATALOG.splice(idx, 1)[0];
      try {
        await w.user.request("messages.post", {
          channelId: channel.id,
          conversationId: conversation.id,
          text: "still there?",
          authorKind: "user",
        });
        const note = await waitFor(async () => {
          const { messages } = await listMessages(w.user, channel.id);
          return messages.find(
            (m) =>
              m.authorKind === "system" &&
              m.conversationId === conversation.id &&
              m.text.includes("Couldn't switch"),
          );
        }, "failed held-pick system note");
        expect(note.text).toContain("fake/opus-2");
        // The row is restored — no dead model pinned for the next restart.
        await waitFor(async () => {
          const c = (await getConversation(w.user, conversation.id)) as
            | { model?: string; effort?: string; provider?: string }
            | undefined;
          return c && c.model === undefined && c.effort === undefined
            ? c
            : undefined;
        }, "row restored after failed apply");
        // And the turn still completed on the model it already had.
        const answers = await waitFor(async () => {
          const { messages } = await listMessages(w.user, channel.id);
          const list = messages.filter(
            (m) =>
              m.authorKind === "employee" &&
              m.conversationId === conversation.id,
          );
          return list.length >= 2 ? list : undefined;
        }, "second answer after failed held pick");
        expect(answers.at(-1)?.model).toBe("fake-large");
      } finally {
        MODEL_CATALOG.push(removed);
      }
    } finally {
      await w.cleanup();
    }
  }, 20_000);
});
