import { type AppErrorCode, MAX_ATTACHMENT_BYTES } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { createMemoryAttachmentStore } from "../src/attachments";
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

    // Non-user messages and engineRef/state writes need the engine host role.
    await connection.receive(
      req("harness.register", { protocolVersion: 1, version: "0.0.0-test" }),
    );

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

  it("AC-3 attachments park bytes, messages carry refs, attachments.get returns the bytes; oversize is a typed error", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const { channel } = await setupChannel(frames, connection);

    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    await connection.receive(
      req("messages.post", {
        channelId: channel.id,
        text: "what does this show",
        attachments: [
          { name: "shot.png", mimeType: "image/png", dataBase64: png },
        ],
      }),
    );
    const posted = (
      resultOf(frames, `t${nextId - 1}`).result as {
        message: {
          text: string;
          attachments?: {
            id: string;
            name: string;
            mimeType: string;
            sizeBytes: number;
          }[];
        };
      }
    ).message;
    // The message record holds a display reference — never the bytes.
    expect(posted.attachments).toHaveLength(1);
    const ref = posted.attachments?.[0];
    expect(ref).toMatchObject({
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 70,
    });
    expect(JSON.stringify(posted)).not.toContain(png);

    // The broadcast copy carries the same ref, no bytes.
    frames.length = 0;
    await connection.receive(
      req("channel.subscribe", { channelId: channel.id }),
    );
    await connection.receive(
      req("messages.post", {
        channelId: channel.id,
        text: "and this one",
        attachments: [
          { name: "shot2.png", mimeType: "image/png", dataBase64: png },
        ],
      }),
    );
    const broadcast = eventsNamed(frames, "message.created").map(
      (e) =>
        (
          e.params as {
            message: {
              attachments?: { id: string; name: string }[];
              text: string;
            };
          }
        ).message,
    );
    const liveMsg = broadcast.find((m) => m.text === "and this one");
    expect(liveMsg?.attachments?.[0]?.name).toBe("shot2.png");

    // attachments.get round-trips the stored bytes.
    await connection.receive(req("attachments.get", { id: ref?.id }));
    const got = resultOf(frames, `t${nextId - 1}`).result as {
      attachment: { id: string; mimeType: string };
      dataBase64: string;
    };
    expect(got.attachment.id).toBe(ref?.id);
    expect(got.dataBase64).toBe(png);

    // conversations.open accepts attachments the same way (first message of a DM).
    await connection.receive(
      req("conversations.open", {
        channelId: channel.id,
        text: "here's the screenshot",
        attachments: [
          { name: "shot.png", mimeType: "image/png", dataBase64: png },
        ],
      }),
    );
    const { rootMessage } = resultOf(frames, `t${nextId - 1}`).result as {
      rootMessage: { attachments?: { name: string }[] };
    };
    expect(rootMessage.attachments?.[0]?.name).toBe("shot.png");
  });

  it("AC-3 oversize attachments fail with attachment_too_large before anything is stored", async () => {
    const store = createMemoryAttachmentStore();
    const relay = createRelay({
      store: createMemoryStore(),
      token: TOKEN,
      attachments: store,
    });
    const { frames, connection } = await helloed(relay);
    const { channel } = await setupChannel(frames, connection);

    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61).toString("base64");
    await connection.receive(
      req("messages.post", {
        channelId: channel.id,
        text: "big",
        attachments: [
          { name: "big.png", mimeType: "image/png", dataBase64: big },
        ],
      }),
    );
    const err = errorOf(frames, `t${nextId - 1}`);
    expect(err.data?.code).toBe("attachment_too_large" satisfies AppErrorCode);
    expect(err.data?.sizeBytes).toBe(MAX_ATTACHMENT_BYTES + 1);
    expect(err.data?.limit).toBe(MAX_ATTACHMENT_BYTES);
    // Nothing was parked: the store stays empty.
    await expect(store.get("att_anything")).resolves.toBeNull();

    // A non-image mime is rejected by the schema (invalid_params).
    await connection.receive(
      req("messages.post", {
        channelId: channel.id,
        text: "doc",
        attachments: [
          { name: "a.pdf", mimeType: "application/pdf", dataBase64: "Zm9v" },
        ],
      }),
    );
    expect(errorOf(frames, `t${nextId - 1}`).data?.code).toBe("invalid_params");

    // Corrupt base64 is invalid_params too.
    await connection.receive(
      req("messages.post", {
        channelId: channel.id,
        text: "broken",
        attachments: [
          {
            name: "x.png",
            mimeType: "image/png",
            dataBase64: "!!!not-base64!!!",
          },
        ],
      }),
    );
    expect(errorOf(frames, `t${nextId - 1}`).data?.code).toBe("invalid_params");

    // attachments.get on an unknown id is not_found.
    await connection.receive(req("attachments.get", { id: "att_nope" }));
    expect(errorOf(frames, `t${nextId - 1}`).data?.code).toBe(
      "not_found" satisfies AppErrorCode,
    );
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

describe("sessions history (#28)", () => {
  /** A host peer registered on the relay (for engine-owned writes). */
  async function hostOf(relay: ReturnType<typeof createRelay>) {
    const host = connectPeer(relay);
    await host.connection.receive(
      req("session.hello", { protocolVersion: 1, token: TOKEN }),
    );
    await host.connection.receive(
      req("harness.register", { protocolVersion: 1, version: "t" }),
    );
    return host;
  }

  const postAs = (
    connection: { receive(d: string): Promise<void> },
    channelId: string,
    conversationId: string,
    text: string,
    authorKind: string,
    dedupeKey?: string,
  ) =>
    connection.receive(
      req("messages.post", {
        channelId,
        conversationId,
        text,
        authorKind,
        ...(dedupeKey ? { dedupeKey } : {}),
      }),
    );

  const summariesOf = async (
    connection: { receive(d: string): Promise<void> },
    frames: unknown[],
    params: Record<string, unknown> = {},
  ) => {
    await connection.receive(req("conversations.summaries", params));
    return (
      resultOf(frames, `t${nextId - 1}`).result as {
        summaries: {
          conversation: {
            id: string;
            title: string | null;
            archived: boolean;
            state: string;
          };
          root: { id: string; text: string };
          firstAnswer?: { text: string };
          last: { text: string };
          messageCount: number;
        }[];
      }
    ).summaries;
  };

  it("AC-1 conversations.summaries returns title, root, answer preview, state, count", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const { employee, channel } = await setupChannel(frames, connection);
    const host = await hostOf(relay);

    await connection.receive(
      req("conversations.open", {
        channelId: channel.id,
        text: "deploy the thing",
        title: "deploy",
      }),
    );
    const { conversation } = resultOf(frames, `t${nextId - 1}`).result as {
      conversation: { id: string; rootMessageId: string };
    };
    await postAs(
      host.connection,
      channel.id,
      conversation.id,
      "on it",
      "employee",
    );
    await postAs(
      host.connection,
      channel.id,
      conversation.id,
      "looks done",
      "employee",
    );

    const summaries = await summariesOf(connection, frames);
    expect(summaries).toHaveLength(1);
    const [s] = summaries;
    expect(s.conversation.id).toBe(conversation.id);
    expect(s.conversation.title).toBe("deploy");
    expect(s.conversation.state).toBe("idle");
    expect(s.root.id).toBe(conversation.rootMessageId);
    expect(s.root.text).toBe("deploy the thing");
    expect(s.firstAnswer?.text).toBe("on it");
    expect(s.last.text).toBe("looks done");
    expect(s.messageCount).toBe(3);
    expect(employee.name).toBe("Ada");
  });

  it("AC-1b summaries hide archived by default, includeArchived shows them", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const { channel } = await setupChannel(frames, connection);
    await connection.receive(
      req("conversations.open", { channelId: channel.id, text: "old work" }),
    );
    const { conversation } = resultOf(frames, `t${nextId - 1}`).result as {
      conversation: { id: string };
    };
    await connection.receive(
      req("conversations.update", {
        conversationId: conversation.id,
        archived: true,
      }),
    );

    expect(await summariesOf(connection, frames)).toHaveLength(0);
    const all = await summariesOf(connection, frames, {
      includeArchived: true,
    });
    expect(all).toHaveLength(1);
    expect(all[0].conversation.archived).toBe(true);
  });

  it("AC-2 messages.list with conversationId returns that thread's full history", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const { channel } = await setupChannel(frames, connection);
    await connection.receive(
      req("conversations.open", { channelId: channel.id, text: "first" }),
    );
    const convA = (
      resultOf(frames, `t${nextId - 1}`).result as {
        conversation: { id: string };
      }
    ).conversation;
    await connection.receive(
      req("conversations.open", { channelId: channel.id, text: "second" }),
    );
    const convB = (
      resultOf(frames, `t${nextId - 1}`).result as {
        conversation: { id: string };
      }
    ).conversation;
    await connection.receive(
      req("messages.post", {
        channelId: channel.id,
        conversationId: convA.id,
        text: "a-reply",
      }),
    );
    await connection.receive(
      req("messages.post", {
        channelId: channel.id,
        conversationId: convB.id,
        text: "b-reply",
      }),
    );

    await connection.receive(
      req("messages.list", {
        channelId: channel.id,
        conversationId: convA.id,
      }),
    );
    const page = resultOf(frames, `t${nextId - 1}`).result as {
      messages: { text: string; conversationId: string }[];
    };
    expect(page.messages.map((m) => m.text)).toEqual(["first", "a-reply"]);
    expect(page.messages.every((m) => m.conversationId === convA.id)).toBe(
      true,
    );
  });

  it("AC-3 deliveredSeq is a host-only write, like engineRef/state", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const { channel } = await setupChannel(frames, connection);
    await connection.receive(
      req("conversations.open", { channelId: channel.id, text: "x" }),
    );
    const { conversation } = resultOf(frames, `t${nextId - 1}`).result as {
      conversation: { id: string; deliveredSeq: number };
    };
    expect(conversation.deliveredSeq).toBe(0);
    await connection.receive(
      req("conversations.update", {
        conversationId: conversation.id,
        deliveredSeq: 1,
      }),
    );
    expect(errorOf(frames, `t${nextId - 1}`).data?.code).toBe(
      "forbidden" satisfies AppErrorCode,
    );
  });

  it("AC-5 messages.post dedupeKey returns the original and never re-emits", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const { channel } = await setupChannel(frames, connection);
    await connection.receive(
      req("conversations.open", { channelId: channel.id, text: "hi" }),
    );
    const { conversation } = resultOf(frames, `t${nextId - 1}`).result as {
      conversation: { id: string };
    };
    frames.length = 0;

    await postAs(
      connection,
      channel.id,
      conversation.id,
      "answer one",
      "user",
      "k1",
    );
    const first = (
      resultOf(frames, `t${nextId - 1}`).result as {
        message: { id: string; seq: number; text: string };
      }
    ).message;
    const emitted = eventsNamed(frames, "message.created").length;

    // Retry with the same key but a different body → original wins, once.
    await postAs(
      connection,
      channel.id,
      conversation.id,
      "answer one (retry)",
      "user",
      "k1",
    );
    const second = (
      resultOf(frames, `t${nextId - 1}`).result as {
        message: { id: string; seq: number; text: string };
      }
    ).message;
    expect(second.id).toBe(first.id);
    expect(second.seq).toBe(first.seq);
    expect(second.text).toBe("answer one");
    // No second message.created to subscribers / live peers.
    expect(eventsNamed(frames, "message.created").length).toBe(emitted);
  });

  it("AC-5b pending = user messages past deliveredSeq; the watermark clears them", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const { channel } = await setupChannel(frames, connection);
    const host = await hostOf(relay);
    await connection.receive(
      req("conversations.open", { channelId: channel.id, text: "run it" }),
    );
    const { conversation } = resultOf(frames, `t${nextId - 1}`).result as {
      conversation: { id: string; deliveredSeq: number };
    };
    // A queued mid-turn message + an answer: pending must still owe both
    // user messages, even though the newest is the answer.
    await postAs(connection, channel.id, conversation.id, "and this", "user");
    await postAs(
      host.connection,
      channel.id,
      conversation.id,
      "partial answer",
      "employee",
    );
    await postAs(connection, channel.id, conversation.id, "one more", "user");

    /** Register a fresh host (harness restart); returns pending + releases the slot. */
    const pendingOf = async () => {
      const fresh = connectPeer(relay);
      await fresh.connection.receive(
        req("session.hello", { protocolVersion: 1, token: TOKEN }),
      );
      await fresh.connection.receive(
        req("harness.register", { protocolVersion: 1, version: "t2" }),
      );
      const pending = (
        resultOf(fresh.frames, `t${nextId - 1}`).result as {
          pending: {
            conversation: { id: string };
            message: { text: string };
            messages: { text: string }[];
          }[];
        }
      ).pending;
      return { pending, connection: fresh.connection };
    };

    // Harness restart: the old host peer closed (socket drop), a new one
    // re-registers and gets the owed tail.
    host.connection.closed();
    const first = await pendingOf();
    expect(first.pending).toHaveLength(1);
    expect(first.pending[0].conversation.id).toBe(conversation.id);
    expect(first.pending[0].messages.map((m) => m.text)).toEqual([
      "run it",
      "and this",
      "one more",
    ]);
    expect(first.pending[0].message.text).toBe("one more");

    // The host marked the root delivered; only the tail stays owed.
    await first.connection.receive(
      req("conversations.update", {
        conversationId: conversation.id,
        deliveredSeq: 1,
      }),
    );
    first.connection.closed();

    const second = await pendingOf();
    second.connection.closed();
    expect(second.pending).toHaveLength(1);
    expect(second.pending[0].messages.map((m) => m.text)).toEqual([
      "and this",
      "one more",
    ]);
  });
});

describe("auto titles + provenance (#137)", () => {
  /** A host peer registered on the relay (for engine-owned writes). */
  async function hostOf(relay: ReturnType<typeof createRelay>) {
    const host = connectPeer(relay);
    await host.connection.receive(
      req("session.hello", { protocolVersion: 1, token: TOKEN }),
    );
    await host.connection.receive(
      req("harness.register", { protocolVersion: 1, version: "t" }),
    );
    return host;
  }

  const openConv = async (
    frames: unknown[],
    connection: { receive(d: string): Promise<void> },
    params: Record<string, unknown>,
  ) => {
    await connection.receive(req("conversations.open", params));
    return (
      resultOf(frames, `t${nextId - 1}`).result as {
        conversation: {
          id: string;
          title: string;
          titleSource: "auto" | "user";
        };
      }
    ).conversation;
  };

  it("AC-3 an untitled conversation opens with a placeholder from the first message", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const { channel } = await setupChannel(frames, connection);

    // First ~6 words, ellipsis when the message runs on.
    const c1 = await openConv(frames, connection, {
      channelId: channel.id,
      text: "Fix the composer draft on reload please now",
    });
    expect(c1.title).toBe("Fix the composer draft on reload…");
    expect(c1.titleSource).toBe("auto");

    // A short message is its own title — no ellipsis.
    const c2 = await openConv(frames, connection, {
      channelId: channel.id,
      text: "short one",
    });
    expect(c2.title).toBe("short one");

    // Whitespace collapses before the placeholder is cut.
    const c3 = await openConv(frames, connection, {
      channelId: channel.id,
      text: "  hello\n\n  world   again ",
    });
    expect(c3.title).toBe("hello world again");

    // Long words still cap at ~60 chars, cut at a word boundary.
    const c4 = await openConv(frames, connection, {
      channelId: channel.id,
      text: "averyveryveryverylongwordthatwillnotfitinanytitlebar averyveryveryverylongwordthatwillnotfitinanytitlebar",
    });
    expect(c4.title.length).toBeLessThanOrEqual(60);
    expect(c4.title.endsWith("…")).toBe(true);
    expect(c4.title).toBe(
      "averyveryveryverylongwordthatwillnotfitinanytitlebar…",
    );

    // An image-only send titles "Image" (AC-3).
    const c5 = await openConv(frames, connection, {
      channelId: channel.id,
      text: "",
      attachments: [
        { name: "shot.png", mimeType: "image/png", dataBase64: "aGk=" },
      ],
    });
    expect(c5.title).toBe("Image");
    expect(c5.titleSource).toBe("auto");

    // An explicit client title wins over the placeholder — that's a
    // user-chosen name.
    const c6 = await openConv(frames, connection, {
      channelId: channel.id,
      text: "whatever",
      title: "Chosen name",
    });
    expect(c6.title).toBe("Chosen name");
    expect(c6.titleSource).toBe("user");
  });

  it("AC-2 a host title write applies while the title is auto; a user rename sticks forever", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const host = await hostOf(relay);
    const { channel } = await setupChannel(frames, connection);
    // conversation.updated fans out only to channel subscribers.
    await connection.receive(
      req("channel.subscribe", { channelId: channel.id }),
    );

    // Placeholder at open (auto) — engine titles may upgrade it.
    const conv = await openConv(frames, connection, {
      channelId: channel.id,
      text: "Summarize the repo layout",
    });
    expect(conv.titleSource).toBe("auto");

    // Engine-derived title lands.
    await host.connection.receive(
      req("conversations.update", {
        conversationId: conv.id,
        title: "Repo layout summary",
      }),
    );
    const afterDerived = (
      resultOf(host.frames, `t${nextId - 1}`).result as {
        conversation: { title: string; titleSource: string };
      }
    ).conversation;
    expect(afterDerived).toMatchObject({
      title: "Repo layout summary",
      titleSource: "auto",
    });
    // Subscribers see the auto title live.
    const updated = eventsNamed(frames, "conversation.updated").at(-1) as {
      params: { conversation: { title: string } };
    };
    expect(updated.params.conversation.title).toBe("Repo layout summary");

    // The llm upgrade lands over the derived one.
    await host.connection.receive(
      req("conversations.update", {
        conversationId: conv.id,
        title: "Summarize the Repo Layout",
      }),
    );
    const afterLlm = (
      resultOf(host.frames, `t${nextId - 1}`).result as {
        conversation: { title: string; titleSource: string };
      }
    ).conversation;
    expect(afterLlm.title).toBe("Summarize the Repo Layout");

    // A manual rename (#28) — provenance flips to user.
    await connection.receive(
      req("conversations.update", {
        conversationId: conv.id,
        title: "My named session",
      }),
    );
    const renamed = (
      resultOf(frames, `t${nextId - 1}`).result as {
        conversation: { title: string; titleSource: string };
      }
    ).conversation;
    expect(renamed).toMatchObject({
      title: "My named session",
      titleSource: "user",
    });

    // A late engine title must NOT overwrite the user rename — the relay
    // answers with the current row so the caller sees what stuck.
    await host.connection.receive(
      req("conversations.update", {
        conversationId: conv.id,
        title: "Late llm title",
      }),
    );
    const afterLate = (
      resultOf(host.frames, `t${nextId - 1}`).result as {
        conversation: { title: string; titleSource: string };
      }
    ).conversation;
    expect(afterLate).toMatchObject({
      title: "My named session",
      titleSource: "user",
    });
  });

  it("AC-2 a user rename before the first engine title still wins", async () => {
    const relay = newRelay();
    const { frames, connection } = await helloed(relay);
    const host = await hostOf(relay);
    const { channel } = await setupChannel(frames, connection);
    const conv = await openConv(frames, connection, {
      channelId: channel.id,
      text: "whatever",
    });
    await connection.receive(
      req("conversations.update", {
        conversationId: conv.id,
        title: "Typed first",
      }),
    );
    await host.connection.receive(
      req("conversations.update", {
        conversationId: conv.id,
        title: "Engine title",
      }),
    );
    const after = (
      resultOf(host.frames, `t${nextId - 1}`).result as {
        conversation: { title: string; titleSource: string };
      }
    ).conversation;
    expect(after).toMatchObject({ title: "Typed first", titleSource: "user" });
  });
});
