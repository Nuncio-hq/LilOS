import { describe, expect, it } from "vitest";
import { createRelay, type RelayWsPeer } from "../src/session";
import { createMemoryStore } from "../src/store";

/**
 * Relay-side coverage for the #26 surface: harness.register host gate,
 * asks.* round-trip + validation, turns.interrupt broadcast,
 * channel.created broadcast, and pending-turn replay on register.
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
    engineHost: { connected: boolean };
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
    conversation: { id: string; channelId: string };
  };
  return { employee, channel, conversation };
}

describe("relay harness surface (#26)", () => {
  it("harness.register grants the single host role; a second one conflicts", async () => {
    const relay = newRelay();
    const host = await helloed(relay);
    expect(host.welcome.engineHost.connected).toBe(false);

    await host.connection.receive(
      req("harness.register", { protocolVersion: 1, version: "0.0.0-test" }),
    );
    const registered = resultOf(host.frames, lastId()).result as {
      hostId: string;
      pending: unknown[];
    };
    expect(registered.hostId).toMatch(/^host_/);
    expect(registered.pending).toHaveLength(0);

    const late = await helloed(relay);
    expect(late.welcome.engineHost.connected).toBe(true);
    await late.connection.receive(
      req("harness.register", { protocolVersion: 1, version: "0.0.0-test" }),
    );
    expect(errorData(late.frames, lastId())).toBe("conflict");
  });

  it("replays pending turns (latest user message unanswered) on register", async () => {
    const relay = newRelay();
    const host = await helloed(relay);
    const { conversation } = await dmWithConversation(
      host.connection,
      host.frames,
    );
    host.frames.length = 0;
    await host.connection.receive(
      req("harness.register", { protocolVersion: 1, version: "0.0.0-test" }),
    );
    const { pending } = resultOf(host.frames, lastId()).result as {
      pending: { conversation: { id: string }; message: { text: string } }[];
    };
    expect(pending.map((p) => p.conversation.id)).toContain(conversation.id);
  });

  it("gates engine-host writes: report/asks.open/employee posts/engineRef", async () => {
    const relay = newRelay();
    const user = await helloed(relay);
    const { channel, conversation } = await dmWithConversation(
      user.connection,
      user.frames,
    );

    for (const [method, params] of [
      ["harness.report", { engine: { state: "running" } }],
      [
        "asks.open",
        {
          channelId: channel.id,
          conversationId: conversation.id,
          turnId: "t1",
          requestId: "r1",
          request: {
            kind: "approval",
            command: "rm -rf /",
            options: ["once", "deny"],
          },
        },
      ],
      [
        "messages.post",
        {
          channelId: channel.id,
          conversationId: conversation.id,
          authorKind: "employee",
          authorId: "emp_x",
          text: "spoofed",
        },
      ],
      [
        "conversations.update",
        { conversationId: conversation.id, engineRef: "s1" },
      ],
      [
        "conversations.update",
        { conversationId: conversation.id, state: "active" },
      ],
    ] as const) {
      user.frames.length = 0;
      await user.connection.receive(req(method, params));
      expect(errorData(user.frames, lastId()), method).toBe("forbidden");
    }

    // Non-host writes that don't touch engine fields stay allowed.
    user.frames.length = 0;
    await user.connection.receive(
      req("conversations.update", {
        conversationId: conversation.id,
        title: "renamed",
      }),
    );
    expect(resultOf(user.frames, lastId()).result).toBeDefined();
  });

  it("round-trips asks with events and enforces outcome/kind pairing", async () => {
    const relay = newRelay();
    const host = await helloed(relay);
    const watcher = await helloed(relay);
    const { channel, conversation } = await dmWithConversation(
      host.connection,
      host.frames,
    );
    await host.connection.receive(
      req("harness.register", { protocolVersion: 1, version: "0.0.0-test" }),
    );
    await watcher.connection.receive(
      req("channel.subscribe", { channelId: channel.id }),
    );
    watcher.frames.length = 0;

    const approval = {
      kind: "approval",
      command: "patch README.md",
      description: "patch wants to run",
      options: ["once", "always", "deny"],
    };
    await host.connection.receive(
      req("asks.open", {
        channelId: channel.id,
        conversationId: conversation.id,
        turnId: "t1",
        requestId: "r1",
        request: approval,
      }),
    );
    const { ask } = resultOf(host.frames, lastId()).result as {
      ask: { id: string; state: string };
    };
    expect(ask.state).toBe("open");
    expect(eventsNamed(watcher.frames, "ask.opened")).toHaveLength(1);

    // Invalid pairings are refused before any state change.
    await watcher.connection.receive(
      req("asks.respond", { askId: ask.id, outcome: "answer" }),
    );
    expect(errorData(watcher.frames, lastId())).toBe("invalid_params");
    await watcher.connection.receive(
      req("asks.respond", { askId: ask.id, outcome: "answer", answer: "ok" }),
    );
    expect(errorData(watcher.frames, lastId())).toBe("invalid_params");

    watcher.frames.length = 0;
    await watcher.connection.receive(
      req("asks.respond", { askId: ask.id, outcome: "once" }),
    );
    const { ask: resolved } = resultOf(watcher.frames, lastId()).result as {
      ask: { state: string; outcome: string };
    };
    expect(resolved.state).toBe("resolved");
    expect(resolved.outcome).toBe("once");
    expect(eventsNamed(watcher.frames, "ask.resolved")).toHaveLength(1);

    // Double-resolve conflicts; a clarify ask accepts an answer.
    await watcher.connection.receive(
      req("asks.respond", { askId: ask.id, outcome: "deny" }),
    );
    expect(errorData(watcher.frames, lastId())).toBe("conflict");

    await host.connection.receive(
      req("asks.open", {
        channelId: channel.id,
        conversationId: conversation.id,
        turnId: "t1",
        requestId: "r2",
        request: {
          kind: "question",
          question: "Which file?",
          freeText: true,
        },
      }),
    );
    const { ask: clarify } = resultOf(host.frames, lastId()).result as {
      ask: { id: string };
    };
    await watcher.connection.receive(
      req("asks.respond", { askId: clarify.id, outcome: "once" }),
    );
    expect(errorData(watcher.frames, lastId())).toBe("invalid_params");
    await watcher.connection.receive(
      req("asks.respond", {
        askId: clarify.id,
        outcome: "answer",
        answer: "README.md",
      }),
    );
    const { ask: answered } = resultOf(watcher.frames, lastId()).result as {
      ask: { state: string; answer?: string };
    };
    expect(answered.state).toBe("resolved");
    expect(answered.answer).toBe("README.md");
  });

  it("broadcasts turn.interruptRequested and channel.created", async () => {
    const relay = newRelay();
    const host = await helloed(relay);
    const watcher = await helloed(relay);
    watcher.frames.length = 0;
    const { channel, conversation } = await dmWithConversation(
      host.connection,
      host.frames,
    );
    expect(eventsNamed(watcher.frames, "channel.created")).toHaveLength(1);
    expect(eventsNamed(watcher.frames, "employee.upserted")).toHaveLength(1);
    // employees.update broadcasts the same event so online clients that
    // weren't the caller stay in sync.
    const created = (
      host.frames as {
        result?: { employee?: { id: string } };
      }[]
    ).find((f) => f.result?.employee)?.result?.employee;
    if (!created) throw new Error("employees.create response missing");
    await host.connection.receive(
      req("employees.update", { id: created.id, name: "Renamed" }),
    );
    expect(eventsNamed(watcher.frames, "employee.upserted")).toHaveLength(2);

    await watcher.connection.receive(
      req("channel.subscribe", { channelId: channel.id }),
    );
    watcher.frames.length = 0;
    await watcher.connection.receive(
      req("turns.interrupt", { conversationId: conversation.id }),
    );
    const interrupts = eventsNamed(watcher.frames, "turn.interruptRequested");
    expect(interrupts).toHaveLength(1);
    expect(
      (interrupts[0].params as { conversationId: string }).conversationId,
    ).toBe(conversation.id);

    await watcher.connection.receive(
      req("turns.interrupt", { conversationId: "conv_nope" }),
    );
    expect(errorData(watcher.frames, lastId())).toBe("not_found");
  });
});
