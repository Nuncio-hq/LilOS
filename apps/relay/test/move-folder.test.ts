import { describe, expect, it } from "vitest";
import type { createRelay, RelayWsPeer } from "../src/session";
import {
  errorOf,
  eventsNamed,
  helloed,
  lastId,
  newRelay,
  req,
  resultOf,
  TOKEN,
  tick,
} from "./helpers";

/**
 * Issue #581 — relay side of "Add a folder" on a live thread.
 *
 * `conversations.moveFolder` forwards to the engine host (which owns the
 * path boundary + the `session.moveWorkspace` re-home), re-reads the row the
 * host's `conversations.update` write emitted, and posts a plain system note
 * saying whether the running session actually moved — never a silent
 * label-only stamp.
 */

/** Same fake host shape as rewind.test.ts: records `hr-N` frames, answers on demand. */
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

async function setupConversation(user: Awaited<ReturnType<typeof helloed>>) {
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
    req("conversations.open", {
      channelId: channel.id,
      text: "start folder-less",
    }),
  );
  const { conversation } = resultOf(frames, lastId()).result as {
    conversation: { id: string };
  };
  await connection.receive(req("channel.subscribe", { channelId: channel.id }));
  frames.length = 0;
  return { channel, conversation };
}

/** The host-side write the harness's move makes before answering. */
const hostUpdate = (
  host: Awaited<ReturnType<typeof fakeHost>>,
  params: Record<string, unknown>,
) =>
  host.connection.receive(
    JSON.stringify({
      jsonrpc: "2.0",
      id: `h-upd-${Math.random().toString(36).slice(2)}`,
      method: "conversations.update",
      params,
    }),
  );

const moveFolder = async (
  user: Awaited<ReturnType<typeof helloed>>,
  host: Awaited<ReturnType<typeof fakeHost>>,
  params: { conversationId: string; path: string },
  respond: (request: { id?: string }) => Promise<unknown>,
) => {
  const pending = user.connection.receive(
    req("conversations.moveFolder", params),
  );
  await tick();
  const request = await respond(
    (host.frames as { id?: string; method?: string }[])
      .filter((f) => f.method === "conversations.moveFolder")
      .at(-1) ?? {},
  );
  await pending;
  return { request };
};

describe("conversations.moveFolder (#581)", () => {
  it("AC-2 forwards {conversationId, engineRef, path}, re-reads the row, posts the honest note", async () => {
    const relay = newRelay();
    const user = await helloed(relay);
    const host = await fakeHost(relay);
    const { channel, conversation } = await setupConversation(user);
    /* The harness binds the session before Oscar could ask for a folder —
       stamp engineRef the way session.start's write does. */
    await hostUpdate(host, {
      conversationId: conversation.id,
      engineRef: "s_live1",
    });
    user.frames.length = 0;

    await moveFolder(
      user,
      host,
      { conversationId: conversation.id, path: "~/code/app" },
      async (request) => {
        expect(request.id).toBeTruthy();
        /* The host got the engine coordinate it needs for
           session.moveWorkspace. */
        expect((request as { params?: unknown }).params).toMatchObject({
          conversationId: conversation.id,
          engineRef: "s_live1",
          path: "~/code/app",
        });
        /* The real harness writes conversations.update {cwd} THEN answers —
           same order here so the relay's re-read sees the landed folder. */
        await hostUpdate(host, {
          conversationId: conversation.id,
          cwd: "~/code/app",
        });
        await host.answer("conversations.moveFolder", {
          result: { cwd: "/Users/ada/code/app", engineMoved: true },
        });
        return request;
      },
    );

    const response = resultOf(user.frames, lastId()).result as {
      conversation: { id: string; cwd?: string };
    };
    expect(response.conversation.cwd).toBe("~/code/app");

    const notes = eventsNamed(user.frames, "message.created").filter((f) =>
      JSON.stringify(f).includes("the running session moved too"),
    );
    expect(notes).toHaveLength(1);
    const note = (
      notes[0] as {
        params: { message: { text: string; conversationId: string } };
      }
    ).params.message;
    expect(note.conversationId).toBe(conversation.id);
    expect(note.text).toContain("~/code/app");
    expect(channel.id).toBeTruthy();
  });

  it("an engine that could not re-home reports the next-turn wording, not a fake move", async () => {
    const relay = newRelay();
    const user = await helloed(relay);
    const host = await fakeHost(relay);
    const { conversation } = await setupConversation(user);
    await hostUpdate(host, {
      conversationId: conversation.id,
      engineRef: "s_live1",
    });
    user.frames.length = 0;

    await moveFolder(
      user,
      host,
      { conversationId: conversation.id, path: "~/code/app" },
      async () => {
        await hostUpdate(host, {
          conversationId: conversation.id,
          cwd: "~/code/app",
        });
        await host.answer("conversations.moveFolder", {
          result: { cwd: "/Users/ada/code/app", engineMoved: false },
        });
      },
    );

    const notes = eventsNamed(user.frames, "message.created").filter((f) =>
      JSON.stringify(f).includes("Moved this thread"),
    );
    expect(notes).toHaveLength(1);
    const note = (notes[0] as { params: { message: { text: string } } }).params
      .message;
    expect(note.text).toContain("the next turn works there");
    expect(note.text).not.toContain("running session moved");
  });

  it("a host error rejects the call and posts no note", async () => {
    const relay = newRelay();
    const user = await helloed(relay);
    const host = await fakeHost(relay);
    const { conversation } = await setupConversation(user);
    user.frames.length = 0;

    await moveFolder(
      user,
      host,
      { conversationId: conversation.id, path: "~/nope" },
      async () => {
        await host.answer("conversations.moveFolder", {
          error: { code: -32009, message: "engine can't move a folder" },
        });
      },
    );
    const response = resultOf(user.frames, lastId());
    expect(response.error).toBeTruthy();
    expect(errorOf(user.frames, lastId()).code).toBe(-32009);
    const notes = eventsNamed(user.frames, "message.created").filter((f) =>
      JSON.stringify(f).includes("Moved this thread"),
    );
    expect(notes).toHaveLength(0);
  });
});
