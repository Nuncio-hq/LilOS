import { describe, expect, it } from "vitest";
import type { EngineConnection } from "../src/engine/client";
import { openDmConversation, setupWorld, waitFor } from "./helpers";

/* A bind-path failure (here: session.start rejecting once) must not eat
   the send — the delivered claim is already made when the bind runs, so
   without the early-park retry the message is deduped forever and no
   turn ever runs. */
describe("early retry on bind failure", () => {
  it("re-binds and still prompts a send whose first session.start failed", async () => {
    let sessionStartCalls = 0;
    const w = await setupWorld({
      wrap: (conn, engine) => {
        const orig = conn.request.bind(conn);
        return {
          ...conn,
          request: <T = unknown>(method: string, params?: unknown) => {
            if (method === "session.start") {
              sessionStartCalls += 1;
              if (sessionStartCalls === 1)
                return Promise.reject(new Error("boom: start timed out"));
            }
            return orig<T>(method, params);
          },
        } as EngineConnection;
      },
    });
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "hello there",
      });

      // The send is parked + retried: a second session.start runs, the
      // prompt lands, and the engine mints a turn.
      await waitFor(
        () => sessionStartCalls >= 2 || undefined,
        "second session.start",
      );
      await waitFor(
        () => w.engineCalls.find((c) => c.method === "prompt") ?? undefined,
        "prompt call",
      );
      expect(w.engineCalls.filter((c) => c.method === "prompt")).toHaveLength(
        1,
      );
      expect(conversation.id).toBeTruthy();
    } finally {
      await w.cleanup();
    }
  });

  it("surfaces an engine error once the retry budget is spent", async () => {
    const w = await setupWorld({
      wrap: (conn) => {
        const orig = conn.request.bind(conn);
        return {
          ...conn,
          request: <T = unknown>(method: string, params?: unknown) =>
            method === "session.start"
              ? Promise.reject(new Error("boom: engine never starts"))
              : orig<T>(method, params),
        } as EngineConnection;
      },
    });
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "hello there",
      });

      await waitFor(async () => {
        const { messages } = await w.user.request<{
          messages: { text: string }[];
        }>("messages.list", { channelId: channel.id, limit: 50 });
        return messages.find((m) => m.text.includes("Engine error"));
      }, "engine error note");
      const { conversations } = await w.user.request<{
        conversations: { id: string; turnFailure?: { text: string } }[];
      }>("conversations.list", {});
      expect(
        conversations.find((c) => c.id === conversation.id)?.turnFailure?.text,
      ).toContain("Engine error");
    } finally {
      await w.cleanup();
    }
  }, 20_000);
});
