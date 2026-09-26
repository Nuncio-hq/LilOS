import { describe, expect, it } from "vitest";
import { createRelay, type RelayWsPeer } from "../src/session";
import { createMemoryStore } from "../src/store";

/**
 * Relay coverage for the #30 surface: `conversations.setModel` notifies the
 * host via `conversation.modelRequested`, `model` is a host-owned
 * conversation field, and the engine's catalog rides `welcome.engineHost`
 * + `system.status` from the heartbeat report.
 */

const TOKEN = "test-token";

function connectPeer(relay: ReturnType<typeof createRelay>) {
  const frames: unknown[] = [];
  const peer: RelayWsPeer = {
    send: (frame) => frames.push(JSON.parse(frame)),
    close: () => {},
  };
  const connection = relay.connect(peer);
  return { frames, connection };
}

const eventsNamed = (frames: unknown[], method: string) =>
  (frames as { method?: string; params?: unknown }[]).filter(
    (f) => f.method === method,
  );
const resultOf = (frames: unknown[], id: string) => {
  const frame = (
    frames as {
      id?: string;
      result?: unknown;
      error?: { code: number; message: string; data?: Record<string, unknown> };
    }[]
  ).find((f) => f.id === id);
  if (!frame) throw new Error(`no response frame for ${id}`);
  return frame;
};
const errorData = (frames: unknown[], id: string) => {
  const { error } = resultOf(frames, id);
  if (!error) throw new Error(`expected an error frame for ${id}`);
  return error.data?.code as string;
};

let nextId = 0;
const req = (method: string, params: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: `t${nextId++}`, method, params });
const lastId = () => `t${nextId - 1}`;

const newRelay = () =>
  createRelay({ store: createMemoryStore(), token: TOKEN });

async function helloed(relay: ReturnType<typeof createRelay>) {
  const { frames, connection } = connectPeer(relay);
  await connection.receive(
    req("session.hello", { protocolVersion: 1, token: TOKEN }),
  );
  const welcome = resultOf(frames, lastId()).result as {
    engineHost: {
      connected: boolean;
      capabilities?: { id: string }[];
      models?: { id: string }[];
      defaultModel?: string;
    };
  };
  frames.length = 0;
  return { frames, connection, welcome };
}

async function dmWithConversation(
  connection: { receive(d: string): Promise<void> },
  frames: unknown[],
) {
  await connection.receive(
    req("employees.create", { name: "Ada", role: "eng" }),
  );
  const { employee } = resultOf(frames, lastId()).result as {
    employee: { id: string };
  };
  await connection.receive(req("channels.openDm", { employeeId: employee.id }));
  const { channel } = resultOf(frames, lastId()).result as {
    channel: { id: string };
  };
  await connection.receive(
    req("conversations.open", {
      channelId: channel.id,
      text: "Summarize the repo",
    }),
  );
  const { conversation } = resultOf(frames, lastId()).result as {
    conversation: { id: string; channelId: string; model?: string };
  };
  return { employee, channel, conversation };
}

describe("model pick relay surface (#30)", () => {
  it("AC-1/AC-2 conversations.setModel emits conversation.modelRequested on the channel", async () => {
    const relay = newRelay();
    const user = await helloed(relay);
    const { channel, conversation } = await dmWithConversation(
      user.connection,
      user.frames,
    );
    // The harness subscribes to the channel to hear model picks.
    const host = await helloed(relay);
    await host.connection.receive(
      req("channel.subscribe", { channelId: channel.id }),
    );

    user.frames.length = 0;
    host.frames.length = 0;
    await user.connection.receive(
      req("conversations.setModel", {
        conversationId: conversation.id,
        model: "fake-small",
      }),
    );
    const res = resultOf(user.frames, lastId()).result as { ok: boolean };
    expect(res.ok).toBe(true);

    const events = eventsNamed(host.frames, "conversation.modelRequested");
    expect(events).toHaveLength(1);
    expect(events[0].params).toEqual({
      channelId: channel.id,
      conversationId: conversation.id,
      model: "fake-small",
    });
  });

  it("conversations.setModel on an unknown conversation returns not_found", async () => {
    const relay = newRelay();
    const user = await helloed(relay);
    await user.connection.receive(
      req("conversations.setModel", {
        conversationId: "conv_missing",
        model: "fake-small",
      }),
    );
    expect(errorData(user.frames, lastId())).toBe("not_found");
  });

  it("conversation.model is a host-owned field: users may not write it", async () => {
    const relay = newRelay();
    const user = await helloed(relay);
    const { conversation } = await dmWithConversation(
      user.connection,
      user.frames,
    );
    user.frames.length = 0;
    await user.connection.receive(
      req("conversations.update", {
        conversationId: conversation.id,
        model: "fake-small",
      }),
    );
    expect(errorData(user.frames, lastId())).toBe("forbidden");

    // The registered host can write it (it acked session.setModel).
    const host = await helloed(relay);
    await host.connection.receive(
      req("harness.register", { protocolVersion: 1, version: "0.0.0-test" }),
    );
    host.frames.length = 0;
    await host.connection.receive(
      req("conversations.update", {
        conversationId: conversation.id,
        model: "fake-small",
      }),
    );
    const { conversation: updated } = resultOf(host.frames, lastId())
      .result as { conversation: { model?: string } };
    expect(updated.model).toBe("fake-small");
  });

  it("welcome.engineHost and system.status carry the heartbeat's catalog", async () => {
    const relay = newRelay();
    const host = await helloed(relay);
    await host.connection.receive(
      req("harness.register", { protocolVersion: 1, version: "0.0.0-test" }),
    );
    await host.connection.receive(
      req("harness.report", {
        engine: { state: "running" },
        status: {
          harnessVersion: "0.0.0-test",
          probedAt: Date.now(),
          capabilities: [
            {
              id: "models",
              name: "Model picker",
              methods: ["models.list", "session.setModel"],
            },
          ],
          models: [
            { id: "fake-small", name: "Fake Small", provider: "fake" },
            { id: "fake-large", name: "Fake Large", provider: "fake" },
          ],
          defaultModel: "fake-large",
        },
      }),
    );
    expect(resultOf(host.frames, lastId()).error).toBeUndefined();

    // A late joiner reads the catalog off the welcome.
    const app = await helloed(relay);
    expect(app.welcome.engineHost.connected).toBe(true);
    expect(app.welcome.engineHost.models?.map((m) => m.id)).toEqual([
      "fake-small",
      "fake-large",
    ]);
    expect(app.welcome.engineHost.defaultModel).toBe("fake-large");

    await app.connection.receive(req("system.status", {}));
    const status = resultOf(app.frames, lastId()).result as {
      engine?: {
        models?: { id: string }[];
        defaultModel?: string;
        capabilities?: { id: string }[];
      };
    };
    expect(status.engine?.models?.map((m) => m.id)).toEqual([
      "fake-small",
      "fake-large",
    ]);
    expect(status.engine?.capabilities?.some((c) => c.id === "models")).toBe(
      true,
    );
  });
});
