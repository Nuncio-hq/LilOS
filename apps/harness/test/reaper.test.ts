import type { RelayClient } from "@lilos/client-runtime";
import type { AppMessage, Ask, Conversation } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import type { EngineConnection } from "../src/engine/client";
import {
  openDmConversation,
  setupWorld as setupWorldBase,
  waitFor,
} from "./helpers";

/**
 * #346 — idle-close engine sessions, end to end over the real wire. The
 * reaper suspends a session quiet past the timeout (`session.suspend`,
 * never `session.stop`), the conversation's `life` closes, and the next
 * message reopens the SAME engine session through the resume path.
 * World: the shared #437 rig — the reaper knobs go in via `harnessExtra`.
 */

const IDLE_MS = 200;
const TICK_MS = 15;

type World = Awaited<ReturnType<typeof setupWorldBase>> & {
  engineConn: EngineConnection;
};

const setupWorld = async (sessionIdleMs: number): Promise<World> => {
  const w = await setupWorldBase({
    reconnectMinDelayMs: 20,
    harnessExtra: { sessionIdleMs, reaperIntervalMs: TICK_MS },
  });
  if (!w.engineConn) throw new Error("world built without an engine");
  return w as World;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const suspendCalls = (w: World) =>
  w.engineCalls.filter((c) => c.method === "session.suspend");

const startCalls = (w: World) =>
  w.engineCalls.filter((c) => c.method === "session.start");

const postMessage = (
  user: RelayClient,
  channelId: string,
  conversationId: string,
  text: string,
) =>
  user.request<{ message: AppMessage }>("messages.post", {
    channelId,
    conversationId,
    text,
    authorKind: "user",
  });

const conv = async (w: World, id: string) => {
  const { conversations } = await w.user.request<{
    conversations: Conversation[];
  }>("conversations.list", {});
  return conversations.find((c) => c.id === id);
};

const convLife = async (w: World, id: string) => (await conv(w, id))?.life;

const answerTexts = async (w: World, channelId: string, convId: string) => {
  const { messages } = await w.user.request<{ messages: AppMessage[] }>(
    "messages.list",
    { channelId, limit: 200 },
  );
  return messages
    .filter((m) => m.conversationId === convId && m.authorKind === "employee")
    .map((m) => m.text);
};

const openConv = async (w: World, channelId: string, text: string) => {
  const { conversation } = await w.user.request<{
    conversation: { id: string; engineRef: string | null };
  }>("conversations.open", { channelId, text });
  /* waitFor returns on !== undefined — null means "row exists, not bound
     yet": map it to undefined so the wait really covers the bind. */
  await waitFor(
    async () => (await conv(w, conversation.id))?.engineRef ?? undefined,
    "engine session bound",
  );
  return conversation;
};

describe("#346 idle-close", () => {
  it("AC-3 suspends a session idle past the timeout and AC-4 marks its life closed", async () => {
    const w = await setupWorld(IDLE_MS);
    try {
      const { channel } = await openDmConversation(w.user);
      const conversation = await openConv(w, channel.id, "summarize the repo");
      await waitFor(
        () => (suspendCalls(w).length ? true : undefined),
        "session.suspend after the idle timeout",
      );
      await waitFor(
        async () =>
          (await convLife(w, conversation.id)) === "closed" ? true : undefined,
        "conversation life closed",
      );
      /* Suspend, never stop — the engine keeps what resume needs. */
      expect(w.engineCalls.filter((c) => c.method === "session.stop")).toEqual(
        [],
      );
    } finally {
      await w.cleanup();
    }
  });

  it("AC-3 never suspends while a turn runs", async () => {
    const w = await setupWorld(IDLE_MS);
    try {
      const { channel } = await openDmConversation(w.user);
      // LILOS_TURN_HOLD parks the fake's turn mid-run, past turn.started.
      const conversation = await openConv(
        w,
        channel.id,
        "LILOS_TURN_HOLD work the held turn",
      );
      await waitFor(
        () => w.engineCalls.some((c) => c.method === "prompt") || undefined,
        "prompt dispatched",
      );
      // Past the idle timeout with the turn still running: no suspend.
      await sleep(IDLE_MS + 4 * TICK_MS + 100);
      expect(suspendCalls(w)).toEqual([]);
      await w.user.request("turns.interrupt", {
        conversationId: conversation.id,
      });
      // Turn ends → the idle clock restarts → the suspend arrives.
      await waitFor(
        () => (suspendCalls(w).length ? true : undefined),
        "suspend once the turn has ended",
      );
    } finally {
      await w.cleanup();
    }
  });

  it("AC-3 never suspends while an ask is open", async () => {
    const w = await setupWorld(IDLE_MS);
    try {
      const { channel } = await openDmConversation(w.user);
      // An edit prompt parks the fake's turn on an approval ask.
      const conversation = await openConv(
        w,
        channel.id,
        "Add a footer to the page",
      );
      await waitFor(async () => {
        const { asks } = await w.user.request<{ asks: Ask[] }>("asks.list", {
          conversationId: conversation.id,
          state: "open",
        });
        return asks.find((a) => a.request.kind === "approval");
      }, "open approval ask");
      await sleep(IDLE_MS + 4 * TICK_MS + 100);
      expect(suspendCalls(w)).toEqual([]);
      /* The edit script raises asks until the turn ends — keep approving
         until the last one resolves and the idle clock can run out. */
      for (let i = 0; i < 40 && !suspendCalls(w).length; i++) {
        const { asks } = await w.user.request<{ asks: Ask[] }>("asks.list", {
          conversationId: conversation.id,
          state: "open",
        });
        for (const a of asks)
          await w.user.request("asks.respond", {
            askId: a.id,
            outcome: "once",
          });
        await sleep(TICK_MS * 4);
      }
      expect(suspendCalls(w).length).toBeGreaterThan(0);
    } finally {
      await w.cleanup();
    }
  });

  it("AC-3 never suspends while a subagent is running", async () => {
    const w = await setupWorld(IDLE_MS);
    try {
      const { channel } = await openDmConversation(w.user);
      /* The held async helper emits subagent.started but parks its
         subagent.completed until the next turn intake — the session is
         quiet yet still has a running subagent. */
      const conversation = await openConv(
        w,
        channel.id,
        "LILOS_DELEGATE_ASYNC_HOLD delegate the work",
      );
      await waitFor(
        async () =>
          (await answerTexts(w, channel.id, conversation.id)).some((t) =>
            t.includes("helpers reported back"),
          ) || undefined,
        "delegate turn finished",
      );
      await sleep(IDLE_MS + 4 * TICK_MS + 100);
      expect(suspendCalls(w)).toEqual([]);
      /* The next prompt flushes the held close — the subagent completes
         and the session becomes suspendable again. */
      await postMessage(w.user, channel.id, conversation.id, "thanks");
      await waitFor(
        () => (suspendCalls(w).length ? true : undefined),
        "suspend once the subagent has closed",
      );
    } finally {
      await w.cleanup();
    }
  });

  it("AC-3 background jobs do not block the suspend", async () => {
    const w = await setupWorld(IDLE_MS);
    try {
      const { channel } = await openDmConversation(w.user);
      // A dev-server prompt leaves a long-running job on the fake.
      const conversation = await openConv(
        w,
        channel.id,
        "dev server for the app",
      );
      await waitFor(
        async () =>
          (await answerTexts(w, channel.id, conversation.id)).some((t) =>
            t.includes("Dev server is up"),
          ) || undefined,
        "job turn finished",
      );
      /* The job still runs — suspend anyway; its process dies with it. */
      await waitFor(
        () => (suspendCalls(w).length ? true : undefined),
        "suspend despite the running job",
      );
    } finally {
      await w.cleanup();
    }
  });

  it("AC-3 a zero timeout never suspends", async () => {
    const w = await setupWorld(0);
    try {
      const { channel } = await openDmConversation(w.user);
      await openConv(w, channel.id, "summarize the repo");
      await sleep(IDLE_MS + 6 * TICK_MS + 150);
      expect(suspendCalls(w)).toEqual([]);
    } finally {
      await w.cleanup();
    }
  });

  it("AC-2 the next message resumes the same session and AC-5 tells it once", {
    timeout: 15_000,
  }, async () => {
    const w = await setupWorld(IDLE_MS);
    try {
      const { channel } = await openDmConversation(w.user);
      const conversation = await openConv(
        w,
        channel.id,
        "remember the codeword ZEBRA_9",
      );
      /* AC-4 on the wire: every `life` write for this conversation, in
           order — closed on suspend, open again on the resume's reopen.
           (Reading the row races the next idle timeout.) */
      await w.user.request("channel.subscribe", { channelId: channel.id });
      const lives: string[] = [];
      const off = w.user.onEvent((method, params) => {
        const c = (params as { conversation?: { id?: string; life?: string } })
          .conversation;
        if (
          method === "conversation.updated" &&
          c?.id === conversation.id &&
          c.life
        )
          lives.push(c.life);
      });
      await waitFor(
        () => (suspendCalls(w).length ? true : undefined),
        "idle suspend",
      );
      await waitFor(
        () => (lives.includes("closed") ? true : undefined),
        "life closed on the wire",
      );

      await postMessage(
        w.user,
        channel.id,
        conversation.id,
        "recall: what do you remember?",
      );
      /* AC-2: turn 1 is still remembered — the session resumed with its
           memory, not a fresh context. */
      const recalled = await waitFor(async () => {
        const texts = await answerTexts(w, channel.id, conversation.id);
        return texts.find((t) => t.includes("ZEBRA_9"));
      }, "resume answer references turn 1");
      /* Same engine session: no second session.start — the suspended id
           reopened in place. */
      expect(startCalls(w)).toHaveLength(1);
      await waitFor(
        () => (lives.includes("open") ? true : undefined),
        "life open again on the wire",
      );
      off();

      /* AC-5: the resumed turn's intake carried the reopened notice — a
           later recall echoes what the agent actually saw. Exactly once:
           turn 3's own intake took no second copy. */
      await postMessage(w.user, channel.id, conversation.id, "recall: again");
      const again = await waitFor(async () => {
        const texts = await answerTexts(w, channel.id, conversation.id);
        const t = texts.find((x) => x.includes("reopened"));
        return t?.includes("ZEBRA_9") ? t : undefined;
      }, "recall lists turn 1 and the notice together");
      expect(again?.match(/reopened/g)).toHaveLength(1);
      expect(recalled).toBeTruthy();
    } finally {
      await w.cleanup();
    }
  });

  it("AC-2 a prompt INVALID_STATE on a dead session rebinds — no re-queue loop", async () => {
    const w = await setupWorld(0); // reaper off; the session dies by hand
    try {
      const { channel } = await openDmConversation(w.user);
      const conversation = await openConv(
        w,
        channel.id,
        "remember the codeword ZEBRA_9",
      );
      const engineRef = (await conv(w, conversation.id))?.engineRef;
      /* session.stop ends it for good — the harness only learns at the
         next prompt (the parent's INVALID_STATE case). */
      await w.engineConn.request("session.stop", { sessionId: engineRef });
      await postMessage(w.user, channel.id, conversation.id, "still there?");
      /* The loop is gone: INVALID_STATE rebinds — a fresh session.start —
         and the queued message prompts on it. */
      await waitFor(
        () => (startCalls(w).length >= 2 ? true : undefined),
        "rebind session.start",
      );
      await waitFor(async () => {
        const texts = await answerTexts(w, channel.id, conversation.id);
        return texts.length ? true : undefined;
      }, "answer after rebind");
    } finally {
      await w.cleanup();
    }
  });
});
