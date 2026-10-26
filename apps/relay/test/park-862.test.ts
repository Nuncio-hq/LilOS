/* D-#862 — thread parking as relay state: the four RPCs and their
   `conversation.updated` broadcast, the legacy `archived` alias folding
   into settle at the store seam, the early wakes (a new ask, a failed
   turn, Oscar's own message), Oscar's message resuming a settled thread,
   and snoozed push suppression (Needs-you is the one kind that gets
   through). engine-fake only — no real LLM. */
import type { Conversation } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { createPushFanout, type ExpoPushMessage } from "../src/push";
import {
  dmWithConversation,
  eventsNamed,
  helloedToken,
  lastId,
  newRelay,
  registeredHost,
  req,
  resultOf,
} from "./helpers";
import { createMemoryStore } from "./memory-store";

const convOf = (frames: unknown[]) =>
  (resultOf(frames, lastId()).result as { conversation: Conversation })
    .conversation;

const setup = async () => {
  const store = createMemoryStore();
  const relay = newRelay({ store });
  const oscar = await helloedToken(relay);
  const { channel, conversation } = await dmWithConversation(
    oscar.connection,
    oscar.frames,
  );
  /* conversation.updated reaches channel subscribers — subscribe so the
     tests below see the broadcast, like the list's client does. */
  await oscar.connection.receive(
    req("channel.subscribe", { channelId: channel.id }),
  );
  oscar.frames.length = 0;
  return { store, relay, oscar, channel, conversation };
};

describe("D-#862 park RPCs", () => {
  it("pin stamps pinnedAt; unpin clears it", async () => {
    const { oscar, conversation } = await setup();
    await oscar.connection.receive(
      req("conversations.pin", {
        conversationId: conversation.id,
        pinned: true,
      }),
    );
    const pinned = convOf(oscar.frames);
    expect(pinned.pinnedAt).toBeTypeOf("number");
    await oscar.connection.receive(
      req("conversations.pin", {
        conversationId: conversation.id,
        pinned: false,
      }),
    );
    expect(convOf(oscar.frames).pinnedAt).toBeUndefined();
  });

  it("settle stamps manual + the archived mirror, and drops pin + snooze", async () => {
    const { oscar, conversation } = await setup();
    await oscar.connection.receive(
      req("conversations.pin", {
        conversationId: conversation.id,
        pinned: true,
      }),
    );
    await oscar.connection.receive(
      req("conversations.snooze", {
        conversationId: conversation.id,
        until: Date.now() + 60_000,
      }),
    );
    await oscar.connection.receive(
      req("conversations.settle", {
        conversationId: conversation.id,
        settled: true,
      }),
    );
    const settled = convOf(oscar.frames);
    expect(settled.settledAt).toBeTypeOf("number");
    expect(settled.settledReason).toBe("manual");
    expect(settled.archived).toBe(true);
    expect(settled.pinnedAt).toBeUndefined();
    expect(settled.snoozedUntil).toBeUndefined();

    await oscar.connection.receive(
      req("conversations.settle", {
        conversationId: conversation.id,
        settled: false,
      }),
    );
    const back = convOf(oscar.frames);
    expect(back.settledAt).toBeUndefined();
    expect(back.settledReason).toBeUndefined();
    expect(back.settledPr).toBeUndefined();
    expect(back.archived).toBe(false);
  });

  it("snooze stamps until; until:null is Wake now", async () => {
    const { oscar, conversation } = await setup();
    const until = Date.now() + 60_000;
    await oscar.connection.receive(
      req("conversations.snooze", { conversationId: conversation.id, until }),
    );
    expect(convOf(oscar.frames).snoozedUntil).toBe(until);
    await oscar.connection.receive(
      req("conversations.snooze", {
        conversationId: conversation.id,
        until: null,
      }),
    );
    expect(convOf(oscar.frames).snoozedUntil).toBeUndefined();
  });

  it("setAutoSettle flips the flag (false on the wire, true back to absent)", async () => {
    const { oscar, conversation } = await setup();
    await oscar.connection.receive(
      req("conversations.setAutoSettle", {
        conversationId: conversation.id,
        enabled: false,
      }),
    );
    expect(convOf(oscar.frames).autoSettle).toBe(false);
    await oscar.connection.receive(
      req("conversations.setAutoSettle", {
        conversationId: conversation.id,
        enabled: true,
      }),
    );
    expect(convOf(oscar.frames).autoSettle).toBeUndefined();
  });

  it("a second connected client sees each park change on conversation.updated", async () => {
    const { relay, oscar, channel, conversation } = await setup();
    const other = await helloedToken(relay);
    await other.connection.receive(
      req("channel.subscribe", { channelId: channel.id }),
    );
    other.frames.length = 0;
    await oscar.connection.receive(
      req("conversations.settle", {
        conversationId: conversation.id,
        settled: true,
      }),
    );
    const updates = eventsNamed(other.frames, "conversation.updated");
    expect(updates).toHaveLength(1);
    const params = updates[0]?.params as { conversation: Conversation };
    expect(params.conversation.id).toBe(conversation.id);
    expect(params.conversation.settledAt).toBeTypeOf("number");
  });

  it("legacy conversations.update {archived} is the settle alias both ways", async () => {
    const { oscar, conversation } = await setup();
    await oscar.connection.receive(
      req("conversations.update", {
        conversationId: conversation.id,
        archived: true,
      }),
    );
    const settled = convOf(oscar.frames);
    expect(settled.archived).toBe(true);
    expect(settled.settledAt).toBeTypeOf("number");
    expect(settled.settledReason).toBe("manual");
    await oscar.connection.receive(
      req("conversations.update", {
        conversationId: conversation.id,
        archived: false,
      }),
    );
    const back = convOf(oscar.frames);
    expect(back.archived).toBe(false);
    expect(back.settledAt).toBeUndefined();
  });
});

describe("D-#862 early wake", () => {
  const snoozed = async (
    oscar: Awaited<ReturnType<typeof helloedToken>>,
    conversationId: string,
  ) => {
    await oscar.connection.receive(
      req("conversations.snooze", {
        conversationId,
        until: Date.now() + 60_000,
      }),
    );
    oscar.frames.length = 0;
  };

  it("a new ask wakes the snoozed thread", async () => {
    const { store, relay, oscar, channel, conversation } = await setup();
    await snoozed(oscar, conversation.id);
    const host = await registeredHost(relay);
    await host.connection.receive(
      req("asks.open", {
        channelId: channel.id,
        conversationId: conversation.id,
        turnId: "turn-1",
        requestId: "req-1",
        request: { kind: "question", question: "Which branch?" },
      }),
    );
    const woken = await store.getConversation(conversation.id);
    expect(woken?.snoozedUntil).toBeUndefined();
    expect(
      eventsNamed(oscar.frames, "conversation.updated"),
    ).not.toHaveLength(0);
  });

  it("a failed turn wakes the snoozed thread", async () => {
    const { store, relay, oscar, conversation } = await setup();
    await snoozed(oscar, conversation.id);
    const host = await registeredHost(relay);
    await host.connection.receive(
      req("conversations.update", {
        conversationId: conversation.id,
        turnFailure: { kind: "generic", text: "engine died" },
      }),
    );
    const woken = convOf(host.frames);
    expect(woken.snoozedUntil).toBeUndefined();
    expect(woken.turnFailure?.text).toBe("engine died");
    expect(await store.getConversation(conversation.id)).toMatchObject({
      turnFailure: { kind: "generic", text: "engine died" },
    });
  });

  it("Oscar's own message wakes a snoozed thread AND un-settles a settled one", async () => {
    const { store, oscar, channel, conversation } = await setup();
    await oscar.connection.receive(
      req("conversations.settle", {
        conversationId: conversation.id,
        settled: true,
      }),
    );
    await oscar.connection.receive(
      req("conversations.snooze", {
        conversationId: conversation.id,
        until: Date.now() + 60_000,
      }),
    );
    await oscar.connection.receive(
      req("messages.post", {
        channelId: channel.id,
        conversationId: conversation.id,
        text: "one more thing",
      }),
    );
    const resumed = await store.getConversation(conversation.id);
    expect(resumed?.snoozedUntil).toBeUndefined();
    expect(resumed?.settledAt).toBeUndefined();
    expect(resumed?.archived).toBe(false);
  });

  it("employee, system and host-posted user lines never wake the snooze", async () => {
    const { store, relay, oscar, channel, conversation } = await setup();
    await snoozed(oscar, conversation.id);
    const host = await registeredHost(relay);
    for (const post of [
      { authorKind: "employee", text: "answer" },
      { authorKind: "system", text: "note" },
      /* The host's own user-kind line (its injected turn) is not Oscar. */
      { authorKind: "user", text: "host line" },
    ]) {
      await host.connection.receive(
        req("messages.post", {
          channelId: channel.id,
          conversationId: conversation.id,
          ...post,
        }),
      );
    }
    expect(
      (await store.getConversation(conversation.id))?.snoozedUntil,
    ).toBeTypeOf("number");
  });
});

describe("D-#862 snoozed push suppression", () => {
  const ALL_ON = {
    needsApproval: true,
    waitingForInput: true,
    completed: true,
    failed: true,
    stuck: true,
  };

  const pushWorld = async () => {
    const store = createMemoryStore();
    const sent: ExpoPushMessage[] = [];
    const push = createPushFanout({
      store,
      send: async (messages) => {
        sent.push(...messages);
        return messages.map((_, index) => ({
          index,
          status: "ok" as const,
        }));
      },
    });
    const relay = newRelay({ store, push });
    await store.setDevicePush({
      deviceId: "d1",
      token: "ExponentPushToken[d1]",
      prefs: ALL_ON,
      at: Date.now(),
    });
    const oscar = await helloedToken(relay);
    const { channel, conversation } = await dmWithConversation(
      oscar.connection,
      oscar.frames,
    );
    oscar.frames.length = 0;
    return { store, relay, oscar, channel, conversation, sent };
  };

  it("a snoozed thread suppresses turn pushes; an ask still pushes + wakes", async () => {
    const { store, relay, oscar, channel, conversation, sent } =
      await pushWorld();
    await oscar.connection.receive(
      req("conversations.snooze", {
        conversationId: conversation.id,
        until: Date.now() + 60_000,
      }),
    );
    const host = await registeredHost(relay);
    await host.connection.receive(
      req("engine.event", {
        conversationId: conversation.id,
        sessionId: "fake:sess-1",
        event: {
          seq: 1,
          sessionId: "fake:sess-1",
          type: "turn.completed",
          payload: { turnId: "turn-1", stopReason: "end_turn" },
        },
      }),
    );
    await host.connection.receive(
      req("engine.event", {
        conversationId: conversation.id,
        sessionId: "fake:sess-1",
        event: {
          seq: 2,
          sessionId: "fake:sess-1",
          type: "session.state",
          payload: { state: "error", reason: "died" },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(0);

    /* Needs-you is the one push a snooze never silences — and the ask
       wakes the thread, so the next completion pushes again. */
    await host.connection.receive(
      req("asks.open", {
        channelId: channel.id,
        conversationId: conversation.id,
        turnId: "turn-2",
        requestId: "req-1",
        request: { kind: "question", question: "Pick a branch" },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toBe("Pick a branch");
    expect(
      (await store.getConversation(conversation.id))?.snoozedUntil,
    ).toBeUndefined();

    await host.connection.receive(
      req("engine.event", {
        conversationId: conversation.id,
        sessionId: "fake:sess-1",
        event: {
          seq: 3,
          sessionId: "fake:sess-1",
          type: "turn.completed",
          payload: { turnId: "turn-3", stopReason: "end_turn" },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(2);
  });
});
