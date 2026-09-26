import type { AppErrorCode } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { createRelay, type RelayWsPeer } from "../src/session";
import { createMemoryStore } from "../src/store";

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

const calls = (frames: unknown[]) =>
  (frames as { id?: string }[]).filter((f) => f.id !== undefined);
const events = (frames: unknown[]) =>
  (frames as { method?: string; params?: unknown }[]).filter(
    (f) => f.method !== undefined,
  );
const eventsNamed = (frames: unknown[], method: string) =>
  events(frames).filter((f) => f.method === method);
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
const errorOf = (frames: unknown[], id: string) => {
  const { error } = resultOf(frames, id);
  if (!error) throw new Error(`expected an error frame for ${id}`);
  return error;
};

let nextId = 0;
const req = (method: string, params: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: `t${nextId++}`, method, params });

async function helloed(relay: ReturnType<typeof createRelay>) {
  const { frames, connection } = connectPeer(relay);
  await connection.receive(
    req("session.hello", { protocolVersion: 1, token: TOKEN }),
  );
  frames.length = 0;
  return { frames, connection };
}

const newRelay = (opts: { protocolVersion?: number } = {}) =>
  createRelay({ store: createMemoryStore(), token: TOKEN, ...opts });

async function setupChannel(
  frames: unknown[],
  connection: { receive(d: string): Promise<void> },
) {
  await connection.receive(
    req("employees.create", { name: "Ada", role: "eng" }),
  );
  const employee = (
    resultOf(frames, `t${nextId - 1}`).result as {
      employee: { id: string; name: string };
    }
  ).employee;
  await connection.receive(req("channels.openDm", { employeeId: employee.id }));
  const channel = (
    resultOf(frames, `t${nextId - 1}`).result as {
      channel: { id: string; kind: string; employeeId: string };
    }
  ).channel;
  return { employee, channel };
}

describe("relay session", () => {
  it("rejects calls before session.hello and wrong tokens", async () => {
    const relay = newRelay();
    const { frames, connection } = connectPeer(relay);
    await connection.receive(req("employees.list"));
    expect(errorOf(frames, `t${nextId - 1}`).data?.code).toBe(
      "unauthenticated" satisfies AppErrorCode,
    );
    await connection.receive(
      req("session.hello", { protocolVersion: 1, token: "wrong" }),
    );
    expect(errorOf(frames, `t${nextId - 1}`).data?.code).toBe(
      "unauthenticated" satisfies AppErrorCode,
    );
  });

  it("AC-4 version mismatch returns typed error naming the side to update", async () => {
    const relay = newRelay({ protocolVersion: 5 });
    const { frames, connection } = connectPeer(relay);

    // Older client → told to update the client.
    await connection.receive(
      req("session.hello", { protocolVersion: 3, token: TOKEN }),
    );
    expect(errorOf(frames, `t${nextId - 1}`).data).toEqual({
      code: "protocol_version_mismatch",
      update: "client",
      clientVersion: 3,
      serverVersion: 5,
    });

    // Newer client → told to update the server.
    await connection.receive(
      req("session.hello", { protocolVersion: 9, token: TOKEN }),
    );
    expect(errorOf(frames, `t${nextId - 1}`).data).toEqual({
      code: "protocol_version_mismatch",
      update: "server",
      clientVersion: 9,
      serverVersion: 5,
    });

    // Matching version → welcome carries the agreed version + instanceId.
    await connection.receive(
      req("session.hello", { protocolVersion: 5, token: TOKEN }),
    );
    const welcome = resultOf(frames, `t${nextId - 1}`).result as {
      protocolVersion: number;
      relayVersion: string;
      instanceId: string;
    };
    expect(welcome.protocolVersion).toBe(5);
    expect(welcome.instanceId).toBe(relay.instanceId);
  });

  it("AC-2 stores employees, dm channels, conversations and seq'd messages", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const { employee, channel } = await setupChannel(frames, connection);
    expect(employee.name).toBe("Ada");
    expect(channel.kind).toBe("dm");
    expect(channel.employeeId).toBe(employee.id);

    // openDm is get-or-create.
    await connection.receive(
      req("channels.openDm", { employeeId: employee.id }),
    );
    const again = (
      resultOf(frames, `t${nextId - 1}`).result as { channel: { id: string } }
    ).channel;
    expect(again.id).toBe(channel.id);

    // Open a conversation: root message gets seq 1.
    await connection.receive(
      req("conversations.open", {
        channelId: channel.id,
        text: "deploy the thing",
        title: "deploy",
      }),
    );
    const { conversation, rootMessage } = resultOf(frames, `t${nextId - 1}`)
      .result as {
      conversation: {
        id: string;
        state: string;
        archived: boolean;
        engineRef: null;
        rootMessageId: string;
      };
      rootMessage: { id: string; seq: number; conversationId: string };
    };
    expect(conversation.rootMessageId).toBe(rootMessage.id);
    expect(conversation.state).toBe("idle");
    expect(rootMessage.seq).toBe(1);
    expect(rootMessage.conversationId).toBe(conversation.id);

    // Posted messages bump the per-channel seq monotonically.
    await connection.receive(
      req("messages.post", {
        channelId: channel.id,
        conversationId: conversation.id,
        authorId: employee.id,
        authorKind: "employee",
        text: "on it",
      }),
    );
    const posted = (
      resultOf(frames, `t${nextId - 1}`).result as {
        message: { seq: number; authorKind: string };
      }
    ).message;
    expect(posted.seq).toBe(2);
    expect(posted.authorKind).toBe("employee");

    await connection.receive(
      req("conversations.update", {
        conversationId: conversation.id,
        state: "active",
        engineRef: "hermes:session-9",
        title: "ship deploy",
      }),
    );
    const updated = (
      resultOf(frames, `t${nextId - 1}`).result as {
        conversation: { state: string; engineRef: string; title: string };
      }
    ).conversation;
    expect(updated).toMatchObject({
      state: "active",
      engineRef: "hermes:session-9",
      title: "ship deploy",
    });

    await connection.receive(req("messages.list", { channelId: channel.id }));
    const page = resultOf(frames, `t${nextId - 1}`).result as {
      messages: { seq: number; text: string }[];
      lastSeq: number;
    };
    expect(page.lastSeq).toBe(2);
    expect(page.messages.map((m) => m.seq)).toEqual([1, 2]);
  });

  it("AC-3 reconnect with afterSeq replays exactly the missed messages", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const { channel } = await setupChannel(frames, connection);
    frames.length = 0;

    // First subscribe: no cursor → snapshot + synced.
    await connection.receive(
      req("channel.subscribe", { channelId: channel.id }),
    );
    expect(eventsNamed(frames, "channel.snapshot")).toHaveLength(1);
    expect(eventsNamed(frames, "channel.synced")).toHaveLength(1);

    // Three messages, then the socket drops.
    for (const text of ["one", "two", "three"]) {
      await connection.receive(
        req("messages.post", { channelId: channel.id, text }),
      );
    }
    connection.closed();

    // "Reconnect": new peer, hello, resubscribe from watermark seq=0... first
    // establish the watermark by replaying then dropping again.
    const second = connectPeer(relay);
    await second.connection.receive(
      req("session.hello", { protocolVersion: 1, token: TOKEN }),
    );
    second.frames.length = 0;
    await second.connection.receive(
      req("channel.subscribe", { channelId: channel.id, afterSeq: 1 }),
    );
    const replayed = eventsNamed(second.frames, "message.created").map(
      (e) => (e.params as { message: { seq: number; text: string } }).message,
    );
    expect(replayed.map((m) => m.seq)).toEqual([2, 3]);
    expect(replayed.map((m) => m.text)).toEqual(["two", "three"]);
    // Exactly one synced, after the replay; no snapshot needed for a cursor.
    expect(eventsNamed(second.frames, "channel.snapshot")).toHaveLength(0);
    expect(eventsNamed(second.frames, "channel.synced")).toHaveLength(1);
    // And the subscribe RPC resolved with the channel.
    const subResult = resultOf(second.frames, `t${nextId - 1}`).result as {
      channel: { id: string };
    };
    expect(subResult.channel.id).toBe(channel.id);
  });

  it("delivers live message.created to subscribed peers and stops after unsubscribe", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const { channel } = await setupChannel(frames, connection);
    frames.length = 0;
    await connection.receive(
      req("channel.subscribe", { channelId: channel.id }),
    );
    frames.length = 0;

    await connection.receive(
      req("messages.post", { channelId: channel.id, text: "live" }),
    );
    const live = eventsNamed(frames, "message.created");
    expect(live).toHaveLength(1);
    expect((live[0].params as { message: { text: string } }).message.text).toBe(
      "live",
    );

    frames.length = 0;
    await connection.receive(
      req("channel.unsubscribe", { channelId: channel.id }),
    );
    await connection.receive(
      req("messages.post", { channelId: channel.id, text: "after-unsub" }),
    );
    expect(eventsNamed(frames, "message.created")).toHaveLength(0);
  });

  it("returns not_found for unknown ids", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    await connection.receive(
      req("channel.subscribe", { channelId: "ch_nope" }),
    );
    expect(errorOf(frames, `t${nextId - 1}`).data?.code).toBe(
      "not_found" satisfies AppErrorCode,
    );
    await connection.receive(
      req("conversations.update", { conversationId: "conv_nope" }),
    );
    expect(errorOf(frames, `t${nextId - 1}`).data?.code).toBe(
      "not_found" satisfies AppErrorCode,
    );
  });

  it("rejects malformed frames and unknown methods without dying", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    await connection.receive("not json at all");
    await connection.receive(JSON.stringify({ hello: "world" }));
    await connection.receive(req("bogus.method"));
    const errors = calls(frames).map(
      (f) => (f as { error?: { code: number } }).error?.code,
    );
    expect(errors.filter((c) => c !== undefined).length).toBeGreaterThanOrEqual(
      2,
    );
    // Session still usable afterwards.
    await connection.receive(req("employees.list"));
    expect(
      (resultOf(frames, `t${nextId - 1}`).result as { employees: unknown[] })
        .employees,
    ).toEqual([]);
  });
});
