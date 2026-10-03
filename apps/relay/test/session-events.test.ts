import { describe, expect, it } from "vitest";
import {
  errorData,
  helloedDevice,
  helloedToken,
  lastId,
  newWorld,
  events as notifications,
  registeredHost,
  req,
  requestsTo,
  resultOf,
} from "./helpers";

/* `session.events` + `engine.event` (#157): the phone's live engine feed.
   A device-scope client never talks to an engine — the host pushes engine
   frames (`engine.event`, host-only) and the relay re-emits them on the
   conversation's channel; replay goes through `session.events`, gated on
   the conversation's `engineRef` and forwarded to the host as
   `events.since`. Same scoping shape as `folders.detail` (#156): the device
   gets the read it needs, and nothing that widens its gate. */

/* A DM channel + open conversation, bound to an engine session id. */
async function setupConversation(
  host: Awaited<ReturnType<typeof helloedToken>>,
  engineRef = "fake:sess-1",
) {
  await host.connection.receive(
    req("employees.create", { name: "Ada", role: "eng" }),
  );
  const employee = (
    resultOf(host.frames, lastId()).result as { employee: { id: string } }
  ).employee;
  await host.connection.receive(
    req("channels.openDm", { employeeId: employee.id }),
  );
  const channel = (
    resultOf(host.frames, lastId()).result as { channel: { id: string } }
  ).channel;
  await host.connection.receive(
    req("conversations.open", { channelId: channel.id, text: "hi" }),
  );
  const conversation = (
    resultOf(host.frames, lastId()).result as {
      conversation: { id: string };
    }
  ).conversation;
  if (engineRef) {
    await host.connection.receive(
      req("conversations.update", {
        conversationId: conversation.id,
        engineRef,
      }),
    );
  }
  return { employee, channel, conversation };
}

describe("session.events / engine.event — device-scope live feed (#157)", () => {
  it("AC-1 session.events replays through the host for a device peer", async () => {
    const { relay, pairing } = newWorld();
    const host = await registeredHost(relay);
    const { conversation } = await setupConversation(host);
    const phone = await helloedDevice(pairing, relay);

    await phone.connection.receive(
      req("session.events", { conversationId: conversation.id, after: 0 }),
    );
    const forwarded = requestsTo(host.frames);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      method: "events.since",
      params: { sessionId: "fake:sess-1", after: 0 },
    });
    const events = [
      {
        seq: 1,
        sessionId: "fake:sess-1",
        type: "session.started",
        payload: { agent: "ada", cwd: "/repo" },
      },
    ];
    await host.connection.receive(
      JSON.stringify({
        jsonrpc: "2.0",
        id: forwarded[0].id,
        result: {
          events,
          latestSeq: 1,
          truncated: false,
          openRequests: [],
          snapshot: {
            sessionId: "fake:sess-1",
            state: "idle",
            openRequests: [],
          },
        },
      }),
    );
    expect(
      (resultOf(phone.frames, lastId()).result as { events: unknown[] }).events,
    ).toEqual(events);
  });

  it("an unbound conversation is not_found (nothing to replay)", async () => {
    const { relay, pairing } = newWorld();
    const host = await registeredHost(relay);
    const { conversation } = await setupConversation(host, "");
    const phone = await helloedDevice(pairing, relay);
    const mac = await helloedToken(relay);

    for (const p of [phone, mac]) {
      await p.connection.receive(
        req("session.events", { conversationId: conversation.id, after: 0 }),
      );
      expect(errorData(p.frames, lastId())).toBe("not_found");
    }
    expect(requestsTo(host.frames)).toHaveLength(0);
  });

  it("engine.event is host-only: device and plain-token peers are refused", async () => {
    const { relay, pairing } = newWorld();
    const host = await registeredHost(relay);
    const { conversation } = await setupConversation(host);
    const phone = await helloedDevice(pairing, relay);
    const mac = await helloedToken(relay);
    const frame = {
      conversationId: conversation.id,
      sessionId: "fake:sess-1",
      event: {
        seq: 1,
        sessionId: "fake:sess-1",
        type: "session.started",
        payload: { agent: "ada", cwd: "/repo" },
      },
    };
    for (const p of [phone, mac]) {
      await p.connection.receive(req("engine.event", frame));
      expect(errorData(p.frames, lastId())).toBe("forbidden");
    }
    // And the host's copy went nowhere.
    expect(
      notifications(host.frames).filter((f) => f.method === "engine.event"),
    ).toHaveLength(0);
  });

  it("host engine.event re-emits on the channel to subscribers, not the host", async () => {
    const { relay, pairing } = newWorld();
    const host = await registeredHost(relay);
    const { channel, conversation } = await setupConversation(host);
    const phone = await helloedDevice(pairing, relay);

    await phone.connection.receive(
      req("channel.subscribe", { channelId: channel.id }),
    );
    phone.frames.length = 0;
    const event = {
      seq: 7,
      sessionId: "fake:sess-1",
      type: "turn.delta",
      payload: { turnId: "t1", stream: "text", delta: "on it" },
    };
    await host.connection.receive(
      req("engine.event", {
        conversationId: conversation.id,
        sessionId: "fake:sess-1",
        event,
      }),
    );
    expect(resultOf(host.frames, lastId()).result).toEqual({ ok: true });
    const pushed = notifications(phone.frames).filter(
      (f) => f.method === "engine.event",
    );
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      params: {
        channelId: channel.id,
        conversationId: conversation.id,
        sessionId: "fake:sess-1",
        event,
      },
    });
    // The host's own push does not echo back to it.
    expect(
      notifications(host.frames).filter((f) => f.method === "engine.event"),
    ).toHaveLength(0);
  });

  it("engine.event for an unknown conversation acks but emits nothing", async () => {
    const { relay, pairing } = newWorld();
    const host = await registeredHost(relay);
    const phone = await helloedDevice(pairing, relay);
    phone.frames.length = 0;
    await host.connection.receive(
      req("engine.event", {
        conversationId: "conv-missing",
        sessionId: "fake:sess-1",
        event: {
          seq: 1,
          sessionId: "fake:sess-1",
          type: "session.started",
          payload: { agent: "ada", cwd: "/repo" },
        },
      }),
    );
    expect(resultOf(host.frames, lastId()).result).toEqual({ ok: true });
    expect(notifications(phone.frames)).toHaveLength(0);
  });

  it("a device can't widen its scope: pairing.offer stays forbidden", async () => {
    const { relay, pairing } = newWorld();
    const phone = await helloedDevice(pairing, relay);
    await phone.connection.receive(req("pairing.offer", {}));
    expect(errorData(phone.frames, lastId())).toBe("forbidden");
  });

  /* #300: the context meter's usage must survive replay failure entirely —
     the relay persists each turn.completed's usage on the conversation row. */
  it("turn.completed's usage persists on the conversation row (#300)", async () => {
    const { relay, store } = newWorld();
    const host = await registeredHost(relay);
    const { conversation } = await setupConversation(host);
    const usage = {
      input: 12000,
      output: 3400,
      reasoning: 200,
      cache: 5000,
      contextWindow: 200000,
    };
    await host.connection.receive(
      req("engine.event", {
        conversationId: conversation.id,
        sessionId: "fake:sess-1",
        event: {
          seq: 12,
          sessionId: "fake:sess-1",
          type: "turn.completed",
          payload: { turnId: "t1", stopReason: "end_turn", usage },
        },
      }),
    );
    expect(resultOf(host.frames, lastId()).result).toEqual({ ok: true });
    const conv = await store.getConversation(conversation.id);
    expect(conv?.usage).toEqual(usage);
  });

  it("a stale turn.completed can't regress the persisted usage (#300)", async () => {
    const { relay, store } = newWorld();
    const host = await registeredHost(relay);
    const { conversation } = await setupConversation(host);
    const push = (seq: number, sessionId: string, usage?: unknown) =>
      host.connection.receive(
        req("engine.event", {
          conversationId: conversation.id,
          sessionId,
          event: {
            seq,
            sessionId,
            type: "turn.completed",
            payload: { turnId: `t${seq}`, stopReason: "end_turn", usage },
          },
        }),
      );
    await push(12, "fake:sess-1", {
      input: 9000,
      output: 1000,
      reasoning: 0,
      cache: 0,
    });
    /* A replayed older turn from the same session (a resync streaming both
       live and replayed events) must not rewind the meter. */
    await push(9, "fake:sess-1", {
      input: 100,
      output: 10,
      reasoning: 0,
      cache: 0,
    });
    expect((await store.getConversation(conversation.id))?.usage?.input).toBe(
      9000,
    );
    /* A rebound session starts a fresh fence: its first turn replaces the
       dead session's numbers (seq is per-session — it restarts at 1). */
    await push(4, "fake:sess-2", {
      input: 2000,
      output: 300,
      reasoning: 0,
      cache: 0,
    });
    expect((await store.getConversation(conversation.id))?.usage?.input).toBe(
      2000,
    );
    /* A turn.completed without usage (a cancelled turn) never clobbers. */
    await host.connection.receive(
      req("engine.event", {
        conversationId: conversation.id,
        sessionId: "fake:sess-2",
        event: {
          seq: 7,
          sessionId: "fake:sess-2",
          type: "turn.completed",
          payload: { turnId: "t7", stopReason: "cancelled" },
        },
      }),
    );
    expect((await store.getConversation(conversation.id))?.usage?.input).toBe(
      2000,
    );
  });
});
