import { describe, expect, it } from "vitest";
import {
  dmWithConversation,
  errorData,
  eventsNamed,
  helloed,
  lastId,
  newRelay,
  req,
  resultOf,
} from "./helpers";

/**
 * Relay-side coverage for the #26 surface: harness.register host gate,
 * asks.* round-trip + validation, turns.interrupt broadcast,
 * channel.created broadcast, and pending-turn replay on register.
 */

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

  it("channel.subscribe replays the channel's asks in their current state (#148)", async () => {
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

    // Open an approval ask and a question ask BEFORE the watcher subscribes,
    // then resolve the question — the ask set is already non-trivial when the
    // subscription lands, exactly like a page that loaded late.
    await host.connection.receive(
      req("asks.open", {
        channelId: channel.id,
        conversationId: conversation.id,
        turnId: "t1",
        requestId: "r1",
        request: {
          kind: "approval",
          command: "patch README.md",
          options: ["once", "always", "deny"],
        },
      }),
    );
    const { ask: open1 } = resultOf(host.frames, lastId()).result as {
      ask: { id: string };
    };
    await host.connection.receive(
      req("asks.open", {
        channelId: channel.id,
        conversationId: conversation.id,
        turnId: "t1",
        requestId: "r2",
        request: { kind: "question", question: "Which file?" },
      }),
    );
    const { ask: open2 } = resultOf(host.frames, lastId()).result as {
      ask: { id: string };
    };
    await watcher.connection.receive(
      req("asks.respond", { askId: open2.id, outcome: "answer", answer: "x" }),
    );

    watcher.frames.length = 0;
    await watcher.connection.receive(
      req("channel.subscribe", { channelId: channel.id }),
    );

    const askIds = (method: string) =>
      eventsNamed(watcher.frames, method).map(
        (e) => (e.params as { ask: { id: string } }).ask.id,
      );
    expect(askIds("ask.opened")).toContain(open1.id);
    // The resolved ask replays with its terminal state so a fresh subscriber
    // never resurrects it as still-open.
    expect(askIds("ask.resolved")).toContain(open2.id);
    const resolvedReplay = eventsNamed(watcher.frames, "ask.resolved").find(
      (e) => (e.params as { ask: { id: string } }).ask.id === open2.id,
    );
    expect(
      (resolvedReplay?.params as { ask: { state: string } } | undefined)?.ask
        .state,
    ).toBe("resolved");
  });

  it("broadcasts host.changed on harness.register and host disconnect (#53)", async () => {
    const relay = newRelay();
    const host = await helloed(relay);
    const watcher = await helloed(relay);

    watcher.frames.length = 0;
    await host.connection.receive(
      req("harness.register", { protocolVersion: 1, version: "0.0.0-test" }),
    );
    const ups = eventsNamed(watcher.frames, "host.changed");
    expect(ups).toHaveLength(1);
    expect((ups[0].params as { connected: boolean }).connected).toBe(true);

    watcher.frames.length = 0;
    host.connection.closed();
    const downs = eventsNamed(watcher.frames, "host.changed");
    expect(downs).toHaveLength(1);
    expect((downs[0].params as { connected: boolean }).connected).toBe(false);
  });
});
