import {
  APP_PROTOCOL_VERSION,
  type AppErrorCode,
  type PushPrefs,
} from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { createPairingService } from "../src/pairing";
import {
  createPushFanout,
  type ExpoPushMessage,
  type ExpoSendResult,
} from "../src/push";
import { createRelay, type RelayWsPeer } from "../src/session";
import { createMemoryStore } from "../src/store";

/* #161 — Expo push fan-out: asks.open-created + engine.event transitions →
   one push per registered phone, gated by per-kind prefs and the phone's
   own "thread open" report; freshness via the persisted engine-event seq
   watermark so restarts/replays never re-notify; Expo errors are logged and
   dead tokens dropped without ever blocking the relay. */

const TOKEN = "test-token";

const ALL_ON: PushPrefs = {
  needsApproval: true,
  waitingForInput: true,
  completed: true,
  failed: true,
};

function connectPeer(relay: ReturnType<typeof createRelay>) {
  const frames: unknown[] = [];
  const closedCodes: number[] = [];
  const peer: RelayWsPeer = {
    send: (frame) => frames.push(JSON.parse(frame)),
    close: (code) => closedCodes.push(code ?? 1000),
  };
  return { frames, closedCodes, connection: relay.connect(peer), peer };
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

const newWorld = (opts?: {
  send?: (messages: ExpoPushMessage[]) => Promise<ExpoSendResult[]>;
  now?: () => number;
}) => {
  const store = createMemoryStore();
  const pairing = createPairingService({ store });
  const sent: ExpoPushMessage[] = [];
  const logs: string[] = [];
  const send =
    opts?.send ??
    (async (messages: ExpoPushMessage[]) => {
      sent.push(...messages);
      return messages.map((_, index) => ({ index, status: "ok" as const }));
    });
  const push = createPushFanout({
    store,
    send,
    now: opts?.now,
    log: (message) => logs.push(message),
  });
  const relay = createRelay({ store, token: TOKEN, pairing, push });
  return { store, pairing, relay, push, sent, logs };
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
  return { ...p, device: ex.device };
}

async function registeredHost(relay: ReturnType<typeof createRelay>) {
  const p = await helloedToken(relay);
  await p.connection.receive(
    req("harness.register", { protocolVersion: 1, version: "0.0.0-test" }),
  );
  p.frames.length = 0;
  return p;
}

async function setupConversation(
  host: Awaited<ReturnType<typeof helloedToken>>,
  opts?: { name?: string; title?: string; engineRef?: string },
) {
  await host.connection.receive(
    req("employees.create", { name: opts?.name ?? "Ada", role: "eng" }),
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
    req("conversations.open", {
      channelId: channel.id,
      text: "hi",
      ...(opts?.title ? { title: opts.title } : {}),
    }),
  );
  const conversation = (
    resultOf(host.frames, lastId()).result as {
      conversation: { id: string };
    }
  ).conversation;
  await host.connection.receive(
    req("conversations.update", {
      conversationId: conversation.id,
      engineRef: opts?.engineRef ?? "fake:sess-1",
    }),
  );
  return { employee, channel, conversation };
}

const registerPush = async (
  phone: Awaited<ReturnType<typeof helloedDevice>>,
  token = `ExponentPushToken[${phone.device.id}]`,
  prefs: PushPrefs = ALL_ON,
) => {
  await phone.connection.receive(req("push.register", { token, prefs }));
  return token;
};

const openAsk = async (
  host: Awaited<ReturnType<typeof helloedToken>>,
  channel: { id: string },
  conversation: { id: string },
  request: Record<string, unknown>,
  requestId = "req-1",
) => {
  await host.connection.receive(
    req("asks.open", {
      channelId: channel.id,
      conversationId: conversation.id,
      turnId: "turn-1",
      requestId,
      request,
    }),
  );
  // The fan-out is fire-and-forget — give the async send a beat to land.
  await new Promise((r) => setTimeout(r, 0));
};

const engineEvent = async (
  host: Awaited<ReturnType<typeof helloedToken>>,
  conversation: { id: string },
  event: Record<string, unknown>,
  sessionId = "fake:sess-1",
) => {
  await host.connection.receive(
    req("engine.event", { conversationId: conversation.id, sessionId, event }),
  );
  await new Promise((r) => setTimeout(r, 0));
};

const turnCompleted = (seq: number, payload: Record<string, unknown>) => ({
  seq,
  sessionId: "fake:sess-1",
  type: "turn.completed",
  payload: { turnId: `turn-${seq}`, ...payload },
});

describe("push registration (#161)", () => {
  it("AC-1 a paired device registers its Expo token + prefs", async () => {
    const { relay, pairing, store } = newWorld();
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone, "ExponentPushToken[phone]", ALL_ON);
    expect(resultOf(phone.frames, lastId()).result).toEqual({ ok: true });
    const rows = await store.listDevicePush();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      deviceId: phone.device.id,
      token: "ExponentPushToken[phone]",
      prefs: ALL_ON,
    });
  });

  it("push.register is device scope — a token peer is refused", async () => {
    const { relay } = newWorld();
    const mac = await helloedToken(relay);
    await mac.connection.receive(
      req("push.register", { token: "ExponentPushToken[x]", prefs: ALL_ON }),
    );
    expect(errorData(mac.frames, lastId())).toBe("forbidden");
  });

  it("re-registering updates the stored token and prefs", async () => {
    const { relay, pairing, store } = newWorld();
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone, "ExponentPushToken[old]", ALL_ON);
    await registerPush(phone, "ExponentPushToken[new]", {
      ...ALL_ON,
      completed: false,
    });
    const rows = await store.listDevicePush();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token).toBe("ExponentPushToken[new]");
    expect(rows[0]?.prefs.completed).toBe(false);
  });

  it("push.unregister drops the registration", async () => {
    const { relay, pairing, store } = newWorld();
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone);
    await phone.connection.receive(req("push.unregister", {}));
    expect(resultOf(phone.frames, lastId()).result).toEqual({ ok: true });
    expect(await store.listDevicePush()).toHaveLength(0);
  });

  it("AC-1 devices.revoke drops the push registration", async () => {
    const { relay, pairing, store } = newWorld();
    const mac = await helloedToken(relay);
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone);
    await mac.connection.receive(
      req("devices.revoke", { deviceId: phone.device.id }),
    );
    expect(await store.listDevicePush()).toHaveLength(0);
    expect(phone.closedCodes).toContain(4403);
  });
});

describe("push fan-out — transition → push decision (#161)", () => {
  it("AC-2/3 an opened approval ask pushes title=name, body=need, data=conversationId", async () => {
    const { relay, pairing, sent } = newWorld();
    const host = await registeredHost(relay);
    const { channel, conversation } = await setupConversation(host, {
      name: "Ada",
      title: "Fix the readme",
    });
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone, "ExponentPushToken[phone]");
    await openAsk(host, channel, conversation, {
      kind: "approval",
      command: "rm -rf node_modules",
      options: ["once", "always", "deny"],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      to: "ExponentPushToken[phone]",
      title: "Ada",
      body: "rm -rf node_modules",
      data: { conversationId: conversation.id },
    });
  });

  it("a question ask pushes as waiting-for-input with the question as body", async () => {
    const { relay, pairing, sent } = newWorld();
    const host = await registeredHost(relay);
    const { channel, conversation } = await setupConversation(host);
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone);
    await openAsk(host, channel, conversation, {
      kind: "question",
      question: "Which branch should I target?",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toBe("Which branch should I target?");
  });

  it("a plan ask pushes as needs-approval", async () => {
    const { relay, pairing, sent } = newWorld();
    const host = await registeredHost(relay);
    const { channel, conversation } = await setupConversation(host);
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone);
    await openAsk(host, channel, conversation, {
      kind: "plan",
      planId: "plan-1",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toBe("Plan waiting for your review");
  });

  it("a replayed asks.open (same requestId) does not re-push", async () => {
    const { relay, pairing, sent } = newWorld();
    const host = await registeredHost(relay);
    const { channel, conversation } = await setupConversation(host);
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone);
    const request = {
      kind: "approval",
      command: "make deploy",
      options: ["once", "always", "deny"],
    };
    await openAsk(host, channel, conversation, request);
    await openAsk(host, channel, conversation, request);
    expect(sent).toHaveLength(1);
  });

  it("turn.completed pushes completed; error pushes failed; cancelled stays silent", async () => {
    const { relay, pairing, sent } = newWorld();
    const host = await registeredHost(relay);
    const { conversation } = await setupConversation(host, {
      title: "Fix the readme",
    });
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone);

    await engineEvent(
      host,
      conversation,
      turnCompleted(1, { stopReason: "end_turn" }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      title: "Ada",
      body: "Fix the readme",
      data: { conversationId: conversation.id },
    });

    await engineEvent(
      host,
      conversation,
      turnCompleted(2, { stopReason: "end_turn", error: "boom" }),
    );
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body).toBe("Fix the readme");

    await engineEvent(
      host,
      conversation,
      turnCompleted(3, { stopReason: "cancelled" }),
    );
    expect(sent).toHaveLength(2);
  });

  it("turn.completed refusal pushes failed; session.state error pushes failed too, collapsing the pair", async () => {
    const { relay, pairing, sent } = newWorld();
    const host = await registeredHost(relay);
    const { conversation } = await setupConversation(host, {
      title: "Fix the readme",
    });
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone);

    await engineEvent(
      host,
      conversation,
      turnCompleted(1, { stopReason: "refusal" }),
    );
    expect(sent).toHaveLength(1);
    // The engine's session.state error for the same failure lands inside the
    // collapse window — one push per failure, not two.
    await engineEvent(host, conversation, {
      seq: 2,
      sessionId: "fake:sess-1",
      type: "session.state",
      payload: { state: "error" },
    });
    expect(sent).toHaveLength(1);
  });

  it("a session.state error carries its reason as the push body", async () => {
    const { relay, pairing, sent } = newWorld();
    const host = await registeredHost(relay);
    const { conversation } = await setupConversation(host, {
      title: "Fix the readme",
    });
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone);

    await engineEvent(host, conversation, {
      seq: 1,
      sessionId: "fake:sess-1",
      type: "session.state",
      payload: { state: "error", reason: "engine crashed mid-turn" },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toBe("engine crashed mid-turn");
  });

  it("a replayed engine.event (seq at/under the watermark) never re-pushes", async () => {
    const { relay, pairing, sent } = newWorld();
    const host = await registeredHost(relay);
    const { conversation } = await setupConversation(host);
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone);

    const done = turnCompleted(9, { stopReason: "end_turn" });
    await engineEvent(host, conversation, done);
    expect(sent).toHaveLength(1);
    // The same event re-published (a host replay of an old turn) pushes nothing.
    await engineEvent(host, conversation, done);
    await engineEvent(host, conversation, {
      ...done,
      seq: 5, // older seq re-delivered out of order
      payload: { turnId: "turn-5", stopReason: "end_turn", error: "old" },
    });
    expect(sent).toHaveLength(1);
  });

  it("freshness survives a relay restart — the watermark is in the store", async () => {
    const world = newWorld();
    const { store, pairing, sent } = world;
    const relay1 = world.relay;
    const host1 = await registeredHost(relay1);
    const { conversation } = await setupConversation(host1);
    const phone = await helloedDevice(pairing, relay1);
    await registerPush(phone);

    await engineEvent(
      host1,
      conversation,
      turnCompleted(3, { stopReason: "end_turn" }),
    );
    expect(sent).toHaveLength(1);

    /* Relay restarts on the same store: a fresh fan-out, fresh sockets —
       the host replay sends the same seqs again. */
    const relay2 = createRelay({
      store,
      token: TOKEN,
      pairing,
      push: world.push,
    });
    const host2 = await registeredHost(relay2);
    await engineEvent(
      host2,
      conversation,
      turnCompleted(3, { stopReason: "end_turn" }),
    );
    await engineEvent(
      host2,
      conversation,
      turnCompleted(2, { stopReason: "end_turn", error: "old" }),
    );
    expect(sent).toHaveLength(1);
    // …while a genuinely new event still pushes.
    await engineEvent(
      host2,
      conversation,
      turnCompleted(4, { stopReason: "end_turn" }),
    );
    expect(sent).toHaveLength(2);
  });

  it("AC-5 a thread the phone reports open is suppressed — for that device only", async () => {
    const { relay, pairing, sent } = newWorld();
    const host = await registeredHost(relay);
    const { channel, conversation } = await setupConversation(host);
    const phone = await helloedDevice(pairing, relay);
    const otherPhone = await helloedDevice(pairing, relay);
    await registerPush(phone);
    const otherToken = await registerPush(otherPhone);

    // Phone reports the thread open → the push is suppressed for it, while
    // a second device still gets the push.
    await phone.connection.receive(
      req("push.visibility", { conversationId: conversation.id }),
    );
    expect(resultOf(phone.frames, lastId()).result).toEqual({ ok: true });
    await openAsk(host, channel, conversation, {
      kind: "question",
      question: "which one?",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(otherToken);
    sent.length = 0;

    // Navigating away (null report) lifts the suppression.
    await phone.connection.receive(
      req("push.visibility", { conversationId: null }),
    );
    await openAsk(
      host,
      channel,
      conversation,
      { kind: "question", question: "which one?" },
      "req-2",
    );
    expect(sent).toHaveLength(2);
  });

  it("AC-5 an old socket's late close doesn't wipe a fresh socket's report", async () => {
    const { relay, pairing, sent } = newWorld();
    const host = await registeredHost(relay);
    const { channel, conversation } = await setupConversation(host);
    // Same device on two sockets — the reconnect pattern: the new socket
    // helloes, reports the thread open, then the half-dead old socket's
    // close lands.
    const grant = await pairing.mintGrant();
    const ex = await pairing.exchangeGrant({ code: grant.code });
    if (!("device" in ex)) throw new Error("exchange failed");
    const hello = {
      protocolVersion: APP_PROTOCOL_VERSION,
      deviceId: ex.device.id,
      credential: ex.credential,
    };
    const oldSock = connectPeer(relay);
    await oldSock.connection.receive(req("session.hello", hello));
    const newSock = connectPeer(relay);
    await newSock.connection.receive(req("session.hello", hello));
    newSock.frames.length = 0;

    const phone = { ...newSock, device: ex.device };
    await registerPush(phone);
    await newSock.connection.receive(
      req("push.visibility", { conversationId: conversation.id }),
    );
    // The old socket dies late — the fresh report must survive.
    oldSock.connection.closed();
    await openAsk(host, channel, conversation, {
      kind: "question",
      question: "which one?",
    });
    expect(sent).toHaveLength(0);

    // And when the last socket for the device dies, suppression lifts.
    newSock.connection.closed();
    await openAsk(
      host,
      channel,
      conversation,
      { kind: "question", question: "which one?" },
      "req-2",
    );
    expect(sent).toHaveLength(1);
  });

  it("a dead device's visibility dies with its socket — pushes resume", async () => {
    const { relay, pairing, sent } = newWorld();
    const host = await registeredHost(relay);
    const { channel, conversation } = await setupConversation(host);
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone);
    await phone.connection.receive(
      req("push.visibility", { conversationId: conversation.id }),
    );
    phone.connection.closed();
    await openAsk(host, channel, conversation, {
      kind: "question",
      question: "which one?",
    });
    expect(sent).toHaveLength(1);
  });

  it("per-kind prefs gate the push — an off kind sends nothing", async () => {
    const { relay, pairing, sent } = newWorld();
    const host = await registeredHost(relay);
    const { channel, conversation } = await setupConversation(host);
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone, undefined, {
      ...ALL_ON,
      waitingForInput: false,
      completed: false,
    });
    await openAsk(host, channel, conversation, {
      kind: "question",
      question: "which one?",
    });
    await engineEvent(
      host,
      conversation,
      turnCompleted(1, { stopReason: "end_turn" }),
    );
    expect(sent).toHaveLength(0);
    // …while allowed kinds still send.
    await openAsk(
      host,
      channel,
      conversation,
      { kind: "approval", command: "make deploy", options: ["once", "deny"] },
      "req-2",
    );
    expect(sent).toHaveLength(1);
  });

  it("two registered phones both get the push", async () => {
    const { relay, pairing, sent } = newWorld();
    const host = await registeredHost(relay);
    const { channel, conversation } = await setupConversation(host);
    const phoneA = await helloedDevice(pairing, relay);
    const phoneB = await helloedDevice(pairing, relay);
    await registerPush(phoneA, "ExponentPushToken[a]");
    await registerPush(phoneB, "ExponentPushToken[b]");
    await openAsk(host, channel, conversation, {
      kind: "question",
      question: "which one?",
    });
    expect(sent.map((m) => m.to).sort()).toEqual([
      "ExponentPushToken[a]",
      "ExponentPushToken[b]",
    ]);
  });

  it("AC-3 a long body is truncated at a word boundary", async () => {
    const { relay, pairing, sent } = newWorld();
    const host = await registeredHost(relay);
    const { channel, conversation } = await setupConversation(host);
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone);
    await openAsk(host, channel, conversation, {
      kind: "approval",
      command: `run ${"x".repeat(200)}`,
      options: ["once", "deny"],
    });
    expect(sent[0]?.body.length).toBeLessThanOrEqual(120);
    expect(sent[0]?.body.endsWith("…")).toBe(true);
  });

  it("AC-7 a DeviceNotRegistered receipt drops the token; other errors only log", async () => {
    const receipts: ExpoSendResult[][] = [];
    const send = async (messages: ExpoPushMessage[]) => {
      const batch =
        receipts.shift() ??
        messages.map((_, index) => ({ index, status: "ok" as const }));
      return batch;
    };
    const { relay, pairing, store, sent: _s, logs } = newWorld({ send });
    const host = await registeredHost(relay);
    const { channel, conversation } = await setupConversation(host);
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone, "ExponentPushToken[dead]");

    receipts.push([
      {
        index: 0,
        status: "error",
        errorCode: "DeviceNotRegistered",
        message: "gone",
      },
    ]);
    await openAsk(host, channel, conversation, {
      kind: "question",
      question: "which one?",
    });
    expect(await store.listDevicePush()).toHaveLength(0);
    expect(logs.some((l) => l.includes("DeviceNotRegistered"))).toBe(true);
  });

  it("AC-7 a transport-level send failure logs and never breaks the call", async () => {
    const send = async (messages: ExpoPushMessage[]) =>
      messages.map((_, index) => ({
        index,
        status: "error" as const,
        errorCode: "TransportError",
        message: "exp.host unreachable",
      }));
    const { relay, pairing, store, logs } = newWorld({ send });
    const host = await registeredHost(relay);
    const { channel, conversation } = await setupConversation(host);
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone);
    await openAsk(host, channel, conversation, {
      kind: "question",
      question: "which one?",
    });
    // The asks.open call itself already answered ok — the push failure is
    // async, logged, and the registration stays (a transient net blip must
    // not drop the token).
    expect(await store.listDevicePush()).toHaveLength(1);
    expect(logs.some((l) => l.includes("TransportError"))).toBe(true);
  });

  it("a host send throw is swallowed and logged — the relay answer already went out", async () => {
    const send = async () => {
      throw new Error("dns exploded");
    };
    const { relay, pairing, logs } = newWorld({ send });
    const host = await registeredHost(relay);
    const { channel, conversation } = await setupConversation(host);
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone);
    await host.connection.receive(
      req("asks.open", {
        channelId: channel.id,
        conversationId: conversation.id,
        turnId: "turn-1",
        requestId: "req-1",
        request: { kind: "question", question: "which one?" },
      }),
    );
    expect(resultOf(host.frames, lastId()).result).toHaveProperty("ask");
    await new Promise((r) => setTimeout(r, 0));
    expect(logs.some((l) => l.includes("dns exploded"))).toBe(true);
  });

  it("engine.event for an unknown conversation emits nothing and pushes nothing", async () => {
    const { relay, pairing, sent } = newWorld();
    const host = await registeredHost(relay);
    const phone = await helloedDevice(pairing, relay);
    await registerPush(phone);
    await engineEvent(
      host,
      { id: "conv-missing" },
      turnCompleted(1, { stopReason: "end_turn" }),
    );
    expect(sent).toHaveLength(0);
  });
});
