import type { AppErrorCode } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { createRelay, type RelayWsPeer } from "../src/session";
import { createMemoryStore } from "../src/store";

/**
 * #106 approval modes — the access level is LilOS data on the conversation:
 * the relay stamps it at open (Settings' `defaultAccess` wins unless the
 * caller passes one), and `conversations.setAccess` is the pill's write
 * path (`conversation.updated` carries it to the host mid-turn).
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
      error?: { code: number; message: string };
    }[]
  ).find((f) => f.id === id);
  if (!frame) throw new Error(`no response frame for ${id}`);
  return frame;
};
const errorOf = (frames: unknown[], id: string) => {
  const { error } = resultOf(frames, id) as {
    error?: { code: number; message: string; data?: { code?: string } };
  };
  if (!error) throw new Error(`expected an error frame for ${id}`);
  return error;
};

let nextId = 0;
const req = (method: string, params: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: `t${nextId++}`, method, params });

const newRelay = () =>
  createRelay({ store: createMemoryStore(), token: TOKEN });

async function helloed(relay: ReturnType<typeof createRelay>) {
  const { frames, connection } = connectPeer(relay);
  await connection.receive(
    req("session.hello", { protocolVersion: 1, token: TOKEN }),
  );
  frames.length = 0;
  return { frames, connection };
}

async function setupChannel(
  frames: unknown[],
  connection: { receive(d: string): Promise<void> },
) {
  await connection.receive(
    req("employees.create", { name: "Ada", role: "eng" }),
  );
  const employee = (
    resultOf(frames, `t${nextId - 1}`).result as {
      employee: { id: string };
    }
  ).employee;
  await connection.receive(req("channels.openDm", { employeeId: employee.id }));
  const channel = (
    resultOf(frames, `t${nextId - 1}`).result as {
      channel: { id: string };
    }
  ).channel;
  return { employee, channel };
}

const openConv = async (
  frames: unknown[],
  connection: { receive(d: string): Promise<void> },
  params: Record<string, unknown>,
) => {
  await connection.receive(req("conversations.open", params));
  return (
    resultOf(frames, `t${nextId - 1}`).result as {
      conversation: { id: string; access: "ask" | "full" };
    }
  ).conversation;
};

describe("conversation access level (#106)", () => {
  it("AC-3 open defaults to Ask; Settings' defaultAccess applies only to new conversations", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const { channel } = await setupChannel(frames, connection);

    // No setting yet → Ask.
    const c1 = await openConv(frames, connection, {
      channelId: channel.id,
      text: "first",
    });
    expect(c1.access).toBe("ask");

    // Settings flips the default → only NEW conversations pick it up.
    await connection.receive(
      req("settings.set", { key: "defaultAccess", value: "full" }),
    );
    const c2 = await openConv(frames, connection, {
      channelId: channel.id,
      text: "second",
    });
    expect(c2.access).toBe("full");

    // An explicit param beats the setting; c1 keeps its own level.
    const c3 = await openConv(frames, connection, {
      channelId: channel.id,
      text: "third",
      access: "ask",
    });
    expect(c3.access).toBe("ask");
    await connection.receive(
      req("conversations.list", { channelId: channel.id }),
    );
    const { conversations } = resultOf(frames, `t${nextId - 1}`).result as {
      conversations: { id: string; access: string }[];
    };
    expect(conversations.find((c) => c.id === c1.id)?.access).toBe("ask");
  });

  it("AC-1 conversations.setAccess writes the row and emits conversation.updated", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const { channel } = await setupChannel(frames, connection);
    await connection.receive(
      req("channel.subscribe", { channelId: channel.id }),
    );
    const conv = await openConv(frames, connection, {
      channelId: channel.id,
      text: "work",
    });
    frames.length = 0;

    await connection.receive(
      req("conversations.setAccess", {
        conversationId: conv.id,
        access: "full",
      }),
    );
    const { conversation } = resultOf(frames, `t${nextId - 1}`).result as {
      conversation: { id: string; access: string };
    };
    expect(conversation.access).toBe("full");
    const updated = eventsNamed(frames, "conversation.updated").at(-1) as {
      params: { conversation: { access: string } };
    };
    expect(updated.params.conversation.access).toBe("full");

    // …and the level is on the row for every later read.
    await connection.receive(
      req("conversations.list", { channelId: channel.id }),
    );
    const { conversations } = resultOf(frames, `t${nextId - 1}`).result as {
      conversations: { id: string; access: string }[];
    };
    expect(conversations.find((c) => c.id === conv.id)?.access).toBe("full");

    // Back to Ask.
    await connection.receive(
      req("conversations.setAccess", {
        conversationId: conv.id,
        access: "ask",
      }),
    );
    expect(
      (
        resultOf(frames, `t${nextId - 1}`).result as {
          conversation: { access: string };
        }
      ).conversation.access,
    ).toBe("ask");
  });

  it("setAccess rejects unknown conversations and bad values", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    await connection.receive(
      req("conversations.setAccess", {
        conversationId: "conv_nope",
        access: "full",
      }),
    );
    expect(errorOf(frames, `t${nextId - 1}`).data?.code).toBe(
      "not_found" satisfies AppErrorCode,
    );
    await connection.receive(
      req("conversations.setAccess", {
        conversationId: "conv_any",
        access: "yolo",
      }),
    );
    expect(errorOf(frames, `t${nextId - 1}`).data?.code).toBe(
      "invalid_params" satisfies AppErrorCode,
    );
  });
});
