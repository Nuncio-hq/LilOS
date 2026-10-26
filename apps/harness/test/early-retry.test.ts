import type { Conversation } from "@lilos/contracts/app";
import { connectFake, FakeEngine } from "@lilos/engine-fake";
import { describe, expect, it } from "vitest";
import type { EngineConnection } from "../src/engine/client";
import type { HarnessCtx, SessionBinding } from "../src/harness/ctx";
import { acpStallShape } from "../src/harness/delivery";
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

  it("a stalled start names the real reason, verbatim (D-#866 r5/r6)", async () => {
    const w = await setupWorld({
      wrap: (conn) => {
        const orig = conn.request.bind(conn);
        return {
          ...conn,
          request: <T = unknown>(method: string, params?: unknown) =>
            method === "session.start"
              ? Promise.reject(
                  new Error("agent did not answer session/new in 45000ms"),
                )
              : orig<T>(method, params),
        } as EngineConnection;
      },
    });
    try {
      const { channel } = await openDmConversation(w.user);
      await w.user.request<{ conversation: { id: string } }>(
        "conversations.open",
        { channelId: channel.id, text: "hello there" },
      );

      const note = await waitFor(async () => {
        const { messages } = await w.user.request<{
          messages: { text: string }[];
        }>("messages.list", { channelId: channel.id, limit: 50 });
        return messages.find((m) => m.text.includes("Engine error"));
      }, "engine error note");
      // The verbatim engine reason survives. r6: the macOS folder hint is
      // acp-runtime-only — this world is the default runtime, so the same
      // session/new-shaped failure must NOT carry Desktop advice.
      expect(note?.text).toContain("did not answer session/new in 45000ms");
      expect(note?.text).not.toContain("Files and Folders");
    } finally {
      await w.cleanup();
    }
  }, 20_000);

  it("the folder-consent hint is scoped to the acp session/new stall (D-#866 r6)", () => {
    /* The reviewer's complaint: r5 matched the generic "could not be
       bound", so a Hermes drop got Desktop advice. */
    expect(
      acpStallShape(
        "agent did not answer session/new in 45000ms",
        "acp:claude",
      ),
    ).toBe(true);
    /* Same text, default runtime → no Mac advice. */
    expect(
      acpStallShape("agent did not answer session/new in 45000ms", "hermes"),
    ).toBe(false);
    /* The generic bind failure, even on acp → no Mac advice. */
    expect(
      acpStallShape(
        "session could not be bound after several attempts",
        "acp:claude",
      ),
    ).toBe(false);
    /* A config-write timeout is a different stall — no advice. */
    expect(
      acpStallShape(
        "agent did not answer session/set_config_option in 45000ms",
        "acp:claude",
      ),
    ).toBe(false);
  });

  /* A `!binding` park has no flush timer — it relies on attachEngine's
     `early` sweep. When the bind resolves !conn after the sweep already
     ran (a conn attaching between the bind's conn-check and the park —
     widened from a pure timing gap to a deterministic hang by the r5
     error-recording chain), the send used to sit forever. Hold the first
     bind at a gate so the park lands after attach, exactly. */
  it("a send parked after the attach sweep still delivers (D-#866 r5)", async () => {
    const w = await setupWorld({ engine: null });
    try {
      const harness = w.harness as unknown as HarnessCtx;
      const orig = harness.bindingFor;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let calls = 0;
      harness.bindingFor = (
        conv: Conversation,
        channelId: string,
      ): Promise<SessionBinding | undefined> => {
        calls += 1;
        if (calls === 1) return gate.then(() => undefined);
        return orig.call(w.harness, conv, channelId);
      };

      const { channel } = await openDmConversation(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", { channelId: channel.id, text: "hello" });
      await waitFor(() => calls >= 1 || undefined, "first bind in flight");
      // Attach while the bind is still parked: the sweep finds `early`
      // empty. Releasing the bind parks the send after the sweep.
      w.harness.attachEngine(
        connectFake(new FakeEngine({ tick: 1 })) as unknown as EngineConnection,
      );
      release();

      const answer = await waitFor(async () => {
        const { messages } = await w.user.request<{
          messages: { authorKind: string; conversationId: string }[];
        }>("messages.list", { channelId: channel.id, limit: 50 });
        return messages.find(
          (m) =>
            m.authorKind === "employee" && m.conversationId === conversation.id,
        );
      }, "first answer after attach");
      expect(answer).toBeTruthy();
    } finally {
      await w.cleanup();
    }
  }, 20_000);
});
