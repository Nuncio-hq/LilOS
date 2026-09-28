import { describe, expect, it } from "vitest";
import { createRelay, type RelayWsPeer } from "../src/session";
import { createMemoryStore } from "../src/store";

/**
 * Issue #134 — relay side of "Rewind to here".
 *
 * The relay owns visible messages (D-#25): `conversations.rewind` asks the
 * engine host to restore the folder checkpoint and rewind the agent's memory,
 * then marks the rewound tail (hidden, kept for audit), emits
 * `conversation.rewound`, and appends the plain system note itself so it
 * survives the mark.
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
const errorOf = (frames: unknown[], id: string) => {
  const { error } = resultOf(frames, id);
  if (!error) throw new Error(`expected an error frame for ${id}`);
  return error;
};

let nextId = 0;
const req = (method: string, params: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: `t${nextId++}`, method, params });
const lastId = () => `t${nextId - 1}`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

/**
 * A registered engine host that records relay-initiated requests; tests reply
 * to the recorded `hr-N` ids with whatever result or error the scenario needs.
 */
async function fakeHost(relay: ReturnType<typeof createRelay>) {
  const frames: unknown[] = [];
  const peer: RelayWsPeer = {
    send: (frame) => frames.push(JSON.parse(frame)),
    close: () => {},
  };
  const connection = relay.connect(peer);
  await connection.receive(
    req("session.hello", { protocolVersion: 1, token: TOKEN }),
  );
  await connection.receive(
    req("harness.register", { protocolVersion: 1, version: "0.0.0-test" }),
  );
  frames.length = 0;
  const answered = new Set<string>();
  const answer = async (
    method: string,
    response: { result?: unknown; error?: unknown },
  ) => {
    const request = (frames as { id?: string; method?: string }[])
      .filter(
        (f) => f.method === method && f.id !== undefined && !answered.has(f.id),
      )
      .at(-1);
    if (!request?.id) throw new Error(`host never saw ${method}`);
    answered.add(request.id);
    await connection.receive(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, ...response }),
    );
    return request;
  };
  return { frames, connection, answer };
}

async function setupConversation(
  user: Awaited<ReturnType<typeof helloed>>,
  texts: string[],
) {
  const { frames, connection } = user;
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
    req("conversations.open", { channelId: channel.id, text: texts[0] ?? "" }),
  );
  const { conversation, rootMessage } = resultOf(frames, lastId()).result as {
    conversation: { id: string };
    rootMessage: { id: string; seq: number };
  };
  const messages = [rootMessage];
  for (const text of texts.slice(1)) {
    await connection.receive(
      req("messages.post", {
        channelId: channel.id,
        conversationId: conversation.id,
        text,
      }),
    );
    messages.push(
      (
        resultOf(frames, lastId()).result as {
          message: { id: string; seq: number };
        }
      ).message,
    );
  }
  await connection.receive(req("channel.subscribe", { channelId: channel.id }));
  frames.length = 0;
  const at = (i: number) => {
    const m = messages[i];
    if (!m) throw new Error(`no message ${i}`);
    return m;
  };
  return { at, channel, conversation, messages };
}

const rewind = async (
  user: Awaited<ReturnType<typeof helloed>>,
  host: Awaited<ReturnType<typeof fakeHost>>,
  params: { conversationId: string; messageId: string },
  hostResponse: { result?: unknown; error?: unknown },
) => {
  const pending = user.connection.receive(req("conversations.rewind", params));
  await tick();
  const request = await host.answer("conversations.rewind", hostResponse);
  await pending;
  return { response: resultOf(user.frames, lastId()), request };
};

describe("conversations.rewind (#134)", () => {
  it("AC-2/AC-3 marks the tail rewound, emits the event, posts the note", async () => {
    const relay = newRelay();
    const user = await helloed(relay);
    const host = await fakeHost(relay);
    const { at, channel, conversation } = await setupConversation(user, [
      "turn one",
      "turn two",
      "turn three",
    ]);

    const { response, request } = await rewind(
      user,
      host,
      { conversationId: conversation.id, messageId: at(1).id },
      { result: { engineRewound: true, filesRestored: true } },
    );
    // The host got the folder + engine coordinates it needs.
    expect((request as { params?: unknown }).params).toMatchObject({
      conversationId: conversation.id,
      messageId: at(1).id,
      fromSeq: at(1).seq,
      toTurn: 1, // one visible user message before the rewind point
    });
    const result = response.result as {
      message: { id: string };
      engineRewound: boolean;
      filesRestored: boolean;
      removedCount: number;
    };
    expect(result.engineRewound).toBe(true);
    expect(result.filesRestored).toBe(true);
    // The targeted message AND everything after it (2 of 3).
    expect(result.removedCount).toBe(2);

    // Subscribers saw conversation.rewound, then the relay-owned note.
    const rewound = eventsNamed(user.frames, "conversation.rewound");
    expect(rewound).toHaveLength(1);
    expect(
      (rewound[0] as { params: Record<string, unknown> }).params,
    ).toMatchObject({
      channelId: channel.id,
      conversationId: conversation.id,
      fromSeq: at(1).seq,
      messageId: at(1).id,
      engineRewound: true,
    });
    const notes = eventsNamed(user.frames, "message.created").filter((f) =>
      JSON.stringify(f).includes("Rewound to before your message"),
    );
    expect(notes).toHaveLength(1);

    // messages.list hides the tail by default; includeRewound keeps it.
    await user.connection.receive(
      req("messages.list", { channelId: channel.id }),
    );
    const visible = resultOf(user.frames, lastId()).result as {
      messages: { id: string; seq: number; rewound?: boolean }[];
    };
    expect(visible.messages.map((m) => m.seq)).toEqual([1, 4]); // + note
    expect(visible.messages.map((m) => m.rewound)).toEqual([false, false]);
    await user.connection.receive(
      req("messages.list", { channelId: channel.id, includeRewound: true }),
    );
    const all = resultOf(user.frames, lastId()).result as {
      messages: { seq: number; rewound?: boolean }[];
    };
    expect(all.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(all.messages.map((m) => m.rewound)).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  it("AC-2 rewound messages don't leak back through search", async () => {
    const relay = newRelay();
    const user = await helloed(relay);
    const host = await fakeHost(relay);
    const { at, channel, conversation } = await setupConversation(user, [
      "rate limit question",
      "retry with backoff plan",
      "rate limit follow-up",
    ]);

    const hitsBefore = async () => {
      await user.connection.receive(
        req("messages.search", { query: "rate limit" }),
      );
      return (
        resultOf(user.frames, lastId()).result as { hits: unknown[] }
      ).hits;
    };
    expect(await hitsBefore()).toHaveLength(2);

    await rewind(
      user,
      host,
      { conversationId: conversation.id, messageId: at(1).id },
      { result: { engineRewound: true, filesRestored: true } },
    );
    // Rewound rows stay in the DB for audit but stop surfacing as hits.
    const hits = (await hitsBefore()) as { messageId: string }[];
    expect(hits).toHaveLength(1);
    expect(hits[0]?.messageId).toBe(at(0).id);
    void channel;
  });

  it("AC-3 files-only fallback: engineRewound=false posts the plain note", async () => {
    const relay = newRelay();
    const user = await helloed(relay);
    const host = await fakeHost(relay);
    const { at, conversation } = await setupConversation(user, [
      "turn one",
      "turn two",
    ]);

    const { response } = await rewind(
      user,
      host,
      { conversationId: conversation.id, messageId: at(0).id },
      { result: { engineRewound: false, filesRestored: true } },
    );
    const result = response.result as { engineRewound: boolean };
    expect(result.engineRewound).toBe(false);
    const notes = eventsNamed(user.frames, "message.created").filter((f) =>
      JSON.stringify(f).includes("still remembers the later messages"),
    );
    expect(notes).toHaveLength(1);
  });

  it("AC-5 rewinding a non-user message or twice is a conflict", async () => {
    const relay = newRelay();
    const user = await helloed(relay);
    const host = await fakeHost(relay);
    const { at, channel, conversation } = await setupConversation(user, [
      "turn one",
      "turn two",
    ]);

    // An employee-authored line cannot be a rewind point.
    await host.connection.receive(
      req("messages.post", {
        channelId: channel.id,
        conversationId: conversation.id,
        authorId: "ada",
        authorKind: "employee",
        text: "on it",
      }),
    );
    const employeeMessage = (
      resultOf(host.frames, lastId()).result as { message: { id: string } }
    ).message;
    await user.connection.receive(
      req("conversations.rewind", {
        conversationId: conversation.id,
        messageId: employeeMessage.id,
      }),
    );
    expect(errorOf(user.frames, lastId()).data?.code).toBe("conflict");

    // A second rewind over the same point is a conflict too.
    await rewind(
      user,
      host,
      { conversationId: conversation.id, messageId: at(1).id },
      { result: { engineRewound: true, filesRestored: true } },
    );
    // Rewinding to messages[0] (which survives) is legal — the mark lands on
    // its tail, not on it.
    const { response: again } = await rewind(
      user,
      host,
      { conversationId: conversation.id, messageId: at(0).id },
      { result: { engineRewound: true, filesRestored: true } },
    );
    expect(again.result).toBeDefined();
    // ...but rewinding at an already-rewound message is a conflict.
    await user.connection.receive(
      req("conversations.rewind", {
        conversationId: conversation.id,
        messageId: at(1).id,
      }),
    );
    expect(errorOf(user.frames, lastId()).data?.code).toBe("conflict");
  });

  it("AC-5 a host-side conflict (turn running) reaches the caller", async () => {
    const relay = newRelay();
    const user = await helloed(relay);
    const host = await fakeHost(relay);
    const { at, channel, conversation } = await setupConversation(user, [
      "turn one",
      "turn two",
    ]);

    const { response } = await rewind(
      user,
      host,
      { conversationId: conversation.id, messageId: at(0).id },
      { error: { code: -32009, message: "a turn is still running" } },
    );
    expect(response.error?.data?.code).toBe("conflict");
    // Nothing was marked: the message is still visible.
    await user.connection.receive(
      req("messages.list", {
        channelId: channel.id,
        conversationId: conversation.id,
      }),
    );
    const visible = resultOf(user.frames, lastId()).result as {
      messages: { seq: number }[];
    };
    expect(visible.messages.map((m) => m.seq)).toEqual([1, 2]);
  });

  it("stores the folder checkpoint id on the user message (host only)", async () => {
    const relay = newRelay();
    const user = await helloed(relay);
    const host = await fakeHost(relay);
    const { at, channel, conversation } = await setupConversation(user, [
      "turn one",
    ]);

    // A non-host peer cannot stamp checkpoints.
    await user.connection.receive(
      req("messages.setCheckpoint", {
        channelId: channel.id,
        messageId: at(0).id,
        checkpoint: "ck-1",
      }),
    );
    expect(errorOf(user.frames, lastId()).data?.code).toBe("forbidden");

    await host.connection.receive(
      req("messages.setCheckpoint", {
        channelId: channel.id,
        messageId: at(0).id,
        checkpoint: "ck-1",
      }),
    );
    const { message } = resultOf(host.frames, lastId()).result as {
      message: { checkpoint?: string };
    };
    expect(message.checkpoint).toBe("ck-1");

    // The rewind request then carries that checkpoint to the host.
    const { request } = await rewind(
      user,
      host,
      { conversationId: conversation.id, messageId: at(0).id },
      { result: { engineRewound: true, filesRestored: true } },
    );
    expect((request as { params?: unknown }).params).toMatchObject({
      checkpoint: "ck-1",
    });
  });
});
