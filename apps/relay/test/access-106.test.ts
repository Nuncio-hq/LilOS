import type { AppErrorCode } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import {
  errorOf,
  eventsNamed,
  helloed,
  lastId,
  newRelay,
  req,
  resultOf,
  setupChannel,
} from "./helpers";

/**
 * #106 approval modes — the access level is LilOS data on the conversation:
 * the relay stamps it at open (Settings' `defaultAccess` wins unless the
 * caller passes one), and `conversations.setAccess` is the pill's write
 * path (`conversation.updated` carries it to the host mid-turn).
 */

const openConv = async (
  frames: unknown[],
  connection: { receive(d: string): Promise<void> },
  params: Record<string, unknown>,
) => {
  await connection.receive(req("conversations.open", params));
  return (
    resultOf(frames, lastId()).result as {
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
    const { conversations } = resultOf(frames, lastId()).result as {
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
    const { conversation } = resultOf(frames, lastId()).result as {
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
    const { conversations } = resultOf(frames, lastId()).result as {
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
        resultOf(frames, lastId()).result as {
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
    expect(errorOf(frames, lastId()).data?.code).toBe(
      "not_found" satisfies AppErrorCode,
    );
    await connection.receive(
      req("conversations.setAccess", {
        conversationId: "conv_any",
        access: "yolo",
      }),
    );
    expect(errorOf(frames, lastId()).data?.code).toBe(
      "invalid_params" satisfies AppErrorCode,
    );
  });
});
