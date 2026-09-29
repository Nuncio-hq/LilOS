import { APP_PROTOCOL_VERSION, type AppErrorCode } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { createPairingService } from "../src/pairing";
import { createRelay, type RelayWsPeer } from "../src/session";
import { createMemoryStore } from "../src/store";

/* `session.events` + `engine.event` (#157): the phone's live engine feed.
   A device-scope client never talks to an engine — the host pushes engine
   frames (`engine.event`, host-only) and the relay re-emits them on the
   conversation's channel; replay goes through `session.events`, gated on
   the conversation's `engineRef` and forwarded to the host as
   `events.since`. Same scoping shape as `folders.detail` (#156): the device
   gets the read it needs, and nothing that widens its gate. */

const TOKEN = "test-token";

function connectPeer(relay: ReturnType<typeof createRelay>) {
  const frames: unknown[] = [];
  const peer: RelayWsPeer = {
    send: (frame) => frames.push(JSON.parse(frame)),
    close: () => {},
  };
  return { frames, connection: relay.connect(peer), peer };
}

let nextId = 0;
const req = (method: string, params: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: `t${nextId++}`, method, params });
const lastId = () => `t${nextId - 1}`;
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
const errorData = (frames: unknown[], id: string) =>
  resultOf(frames, id).error?.data?.code as AppErrorCode;
const requestsTo = (frames: unknown[]) =>
  (frames as { method?: string; id?: string; params?: unknown }[]).filter(
    (f) => f.id?.startsWith("hr-") === true,
  );
const notifications = (frames: unknown[]) =>
  (frames as { method?: string; params?: unknown }[]).filter(
    (f) => f.method !== undefined,
  );

const newWorld = () => {
  const store = createMemoryStore();
  const pairing = createPairingService({ store });
  const relay = createRelay({ store, token: TOKEN, pairing });
  return { store, pairing, relay };
};

async function helloedToken(relay: ReturnType<typeof createRelay>) {
  const p = connectPeer(relay);
  await p.connection.receive(
    req("session.hello", {
      protocolVersion: APP_PROTOCOL_VERSION,
      token: TOKEN,
    }),
  );
  p.frames.length = 0;
  return p;
}

async function helloedDevice(
  pairing: ReturnType<typeof createPairingService>,
  relay: ReturnType<typeof createRelay>,
) {
  const grant = await pairing.mintGrant();
  const ex = await pairing.exchangeGrant({ code: grant.code });
  if (!("device" in ex)) throw new Error("exchange failed");
  const p = connectPeer(relay);
  await p.connection.receive(
    req("session.hello", {
      protocolVersion: APP_PROTOCOL_VERSION,
      deviceId: ex.device.id,
      credential: ex.credential,
    }),
  );
  p.frames.length = 0;
  return p;
}

async function registeredHost(relay: ReturnType<typeof createRelay>) {
  const p = await helloedToken(relay);
  await p.connection.receive(
    req("harness.register", { protocolVersion: 1, version: "0.0.0-test" }),
  );
  p.frames.length = 0;
  return p;
}

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
});
