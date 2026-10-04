import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayClient } from "@lilos/client-runtime";
import type { AppMessage } from "@lilos/contracts/app";
import { FakeEngine } from "@lilos/engine-fake";
import type { CheckpointStore } from "@lilos/host";
import { describe, expect, it } from "vitest";
import type { EngineConnection } from "../src/engine/client";
import type { Harness } from "../src/harness";
import {
  openDm,
  type Relay,
  setupWorld as setupWorldBase,
  waitFor as waitForBase,
} from "./helpers";

/**
 * Issue #134 harness leg: the checkpoint stamp on each user message, the
 * `conversations.rewind` host call (files + engine), the running-turn
 * refusal, and the queued-message prune. Same in-process world as
 * folder-cwd.test.ts, kept in its own file to dodge sibling-PR conflicts.
 */

const waitFor = <T>(
  fn: () => T | undefined | Promise<T | undefined>,
  what: string,
): Promise<T> => waitForBase(fn, what, 15_000);

/** Checkpoint-store stub: ids count snapshots, restore calls are recorded. */
function stubCheckpoints() {
  let n = 0;
  const calls: { snapshots: string[]; restores: [string, string][] } = {
    snapshots: [],
    restores: [],
  };
  const store: CheckpointStore = {
    snapshot: async (cwd: string) => {
      calls.snapshots.push(cwd);
      return `ck-${++n}`;
    },
    restore: async (cwd: string, checkpoint: string) => {
      calls.restores.push([cwd, checkpoint]);
      return { removed: [], restoredTo: checkpoint };
    },
    list: async () => [],
    prune: async () => {},
  };
  return { store, calls };
}

interface World {
  relay: Relay;
  engine: FakeEngine;
  engineConn: EngineConnection;
  checkpoints: ReturnType<typeof stubCheckpoints>;
  harness: Harness;
  user: RelayClient;
  workdir: string;
  cleanup: () => Promise<void>;
}

async function setupWorld(opts?: {
  engine?: FakeEngine;
  attachEngine?: boolean;
}): Promise<World> {
  const workdir = mkdtempSync(join(tmpdir(), "lilos-rewind-"));
  const checkpoints = stubCheckpoints();
  const w = await setupWorldBase({
    engine: opts?.engine,
    attachEngine: opts?.attachEngine,
    workdir,
    rmWorkdir: true,
    checkpoints: checkpoints.store,
    reconnectMinDelayMs: 20,
  });
  return {
    relay: w.relay,
    engine: w.engine as FakeEngine,
    engineConn: w.engineConn as EngineConnection,
    checkpoints,
    harness: w.harness,
    user: w.user,
    workdir,
    cleanup: w.cleanup,
  };
}

async function sendAndAnswer(
  user: RelayClient,
  channelId: string,
  conversationId: string | undefined,
  text: string,
  /** Pick a real folder — checkpoints only stamp for folder-bound
      sessions (#412). */
  cwd?: string,
) {
  if (conversationId) {
    await user.request("messages.post", {
      channelId,
      conversationId,
      text,
    });
  } else {
    const opened = await user.request<{ conversation: { id: string } }>(
      "conversations.open",
      { channelId, text, ...(cwd ? { cwd } : {}) },
    );
    conversationId = opened.conversation.id;
  }
  const messages = await waitFor(
    async () => {
      const { messages } = await user.request<{ messages: AppMessage[] }>(
        "messages.list",
        { channelId, conversationId, limit: 100 },
      );
      const last = messages.at(-1);
      return last?.authorKind === "employee" ? messages : undefined;
    },
    `employee answer to "${text.slice(0, 30)}"`,
  );
  return { conversationId, messages };
}

const conversationMessages = (
  user: RelayClient,
  channelId: string,
  conversationId: string,
) =>
  user.request<{ messages: AppMessage[] }>("messages.list", {
    channelId,
    conversationId,
    limit: 100,
  });

describe("conversations.rewind — harness leg (#134)", () => {
  it("stamps the pre-turn folder checkpoint on the user message", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversationId } = await sendAndAnswer(
        w.user,
        channel.id,
        undefined,
        "look around",
        w.workdir,
      );
      const { messages } = await waitFor(async () => {
        const { messages } = await conversationMessages(
          w.user,
          channel.id,
          conversationId,
        );
        return messages.find((m) => m.authorKind === "user")?.checkpoint
          ? { messages }
          : undefined;
      }, "checkpoint stamped on the user message");
      const userMsg = messages.find((m) => m.authorKind === "user");
      expect(userMsg?.checkpoint).toBe("ck-1");
      expect(w.checkpoints.calls.snapshots).toEqual([w.workdir]);
    } finally {
      await w.cleanup();
    }
  });

  it("rewind restores the checkpoint and drops the engine's turns", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversationId, messages: first } = await sendAndAnswer(
        w.user,
        channel.id,
        undefined,
        "remember alpha",
        w.workdir,
      );
      void first;
      /* sendAndAnswer returns after the turn — and the stamp lands before
         the prompt — so both messages already carry checkpoints. */
      const { messages: second } = await sendAndAnswer(
        w.user,
        channel.id,
        conversationId,
        "remember beta",
      );
      const msg2 = second
        .filter((m) => m.authorKind === "user")
        .find((m) => m.text === "remember beta");
      if (!msg2) throw new Error("user message 'remember beta' not posted");
      // Rewind "to before" msg2: msg1's turn stays, msg2's drops.
      const res = await w.user.request<{
        engineRewound: boolean;
        filesRestored: boolean;
        removedCount: number;
        removedIds: string[];
      }>("conversations.rewind", {
        conversationId,
        messageId: msg2.id,
      });
      expect(res.engineRewound).toBe(true);
      expect(res.filesRestored).toBe(true);
      expect(res.removedCount).toBeGreaterThanOrEqual(2);
      // The folder restored to the checkpoint stamped on the target message.
      expect(w.checkpoints.calls.restores).toEqual([[w.workdir, "ck-2"]]);

      // The tail is gone from the thread…
      const { messages } = await conversationMessages(
        w.user,
        channel.id,
        conversationId,
      );
      const visible = messages.filter((m) => !m.rewound);
      expect(visible.some((m) => m.text === "remember beta")).toBe(false);

      // …and from the agent's memory: a recall probe names only turn 1.
      const { messages: probed } = await sendAndAnswer(
        w.user,
        channel.id,
        conversationId,
        "recall: what do you remember?",
      );
      const answer = probed.at(-1)?.text ?? "";
      expect(answer).toContain("remember alpha");
      expect(answer).not.toContain("remember beta");
    } finally {
      await w.cleanup();
    }
  });

  it("AC-5: refuses -32009 while a turn is running", async () => {
    // Slow fake: the answer takes long enough that the rewind lands mid-turn.
    const w = await setupWorld({ engine: new FakeEngine({ tick: 150 }) });
    try {
      const channel = await openDm(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", { channelId: channel.id, text: "work work" });
      const msg1 = await waitFor(async () => {
        const { messages } = await conversationMessages(
          w.user,
          channel.id,
          conversation.id,
        );
        return messages.find((m) => m.authorKind === "user");
      }, "root user message");
      const conflict = await waitFor(async () => {
        try {
          await w.user.request("conversations.rewind", {
            conversationId: conversation.id,
            messageId: msg1.id,
          });
          return undefined;
        } catch (e) {
          const code = (e as { data?: { code?: string } }).data?.code;
          return code === "conflict" ? code : undefined;
        }
      }, "running-turn conflict");
      expect(conflict).toBe("conflict");
      /* NB: polling only proves the refusal — once the turn finishes a
         retried rewind legitimately succeeds (the "drops turns" test above
         covers the happy path). */
    } finally {
      await w.cleanup();
    }
  }, 15_000);

  it("capability absent: files restore, engine keeps its turns (AC-3)", async () => {
    const w = await setupWorld({
      engine: new FakeEngine({ tick: 1, capabilities: { rewind: false } }),
    });
    try {
      const channel = await openDm(w.user);
      const { conversationId, messages: first } = await sendAndAnswer(
        w.user,
        channel.id,
        undefined,
        "remember alpha",
        w.workdir,
      );
      void first;
      const { messages: second } = await sendAndAnswer(
        w.user,
        channel.id,
        conversationId,
        "remember beta",
      );
      const msg2 = second
        .filter((m) => m.authorKind === "user")
        .find((m) => m.text === "remember beta");
      if (!msg2) throw new Error("user message 'remember beta' not posted");
      const res = await w.user.request<{
        engineRewound: boolean;
        filesRestored: boolean;
      }>("conversations.rewind", {
        conversationId,
        messageId: msg2.id,
      });
      expect(res.engineRewound).toBe(false);
      expect(res.filesRestored).toBe(true);
      expect(w.checkpoints.calls.restores).toEqual([[w.workdir, "ck-2"]]);

      // The engine still remembers: a recall probe names both turns.
      const { messages: probed } = await sendAndAnswer(
        w.user,
        channel.id,
        conversationId,
        "recall: what do you remember?",
      );
      const answer = probed.at(-1)?.text ?? "";
      expect(answer).toContain("remember alpha");
      expect(answer).toContain("remember beta");
    } finally {
      await w.cleanup();
    }
  });

  it("queued-behind-start messages at/after the rewind point never send", async () => {
    /* No engine yet: messages post before a binding exists land in the
       harness's `early` hold — a rewind must prune the tail or the dropped
       message would still prompt once the engine connects. */
    const w = await setupWorld({ attachEngine: false });
    try {
      const channel = await openDm(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", { channelId: channel.id, text: "first" });
      const { message: second } = await w.user.request<{
        message: AppMessage;
      }>("messages.post", {
        channelId: channel.id,
        conversationId: conversation.id,
        text: "second — should be rewound",
      });
      // Rewind "to before" msg2: the queued second send must never prompt.
      await w.user.request("conversations.rewind", {
        conversationId: conversation.id,
        messageId: second.id,
      });
      // Now the engine connects; only the surviving message may prompt.
      const prompts: unknown[] = [];
      const orig = w.engineConn.request.bind(w.engineConn);
      w.engineConn.request = <T = unknown>(
        method: string,
        params?: unknown,
      ): Promise<T> => {
        if (method === "prompt") prompts.push(params);
        return orig<T>(method, params);
      };
      w.harness.attachEngine(w.engineConn);
      await waitFor(async () => {
        const { messages } = await conversationMessages(
          w.user,
          channel.id,
          conversation.id,
        );
        return messages.find((m) => m.authorKind === "employee")
          ? true
          : undefined;
      }, "engine answer after attach");
      const texts = prompts.map((p) => JSON.stringify(p));
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain("first");
      expect(texts[0]).not.toContain("second");
    } finally {
      await w.cleanup();
    }
  });

  it("a folder-less session stamps no checkpoint and restores nothing (#412)", async () => {
    /* Folder-less sessions run in the user's home — snapshotting ~ into the
       shadow store, or restoring a checkpoint over it, must never happen. */
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversationId, messages } = await sendAndAnswer(
        w.user,
        channel.id,
        undefined,
        "plain chat",
      );
      const userMsg = messages.find((m) => m.authorKind === "user");
      if (!userMsg) throw new Error("user message not posted");
      expect(w.checkpoints.calls.snapshots).toEqual([]);
      expect(userMsg.checkpoint ?? null).toBeNull();
      const res = await w.user.request<{
        engineRewound: boolean;
        filesRestored: boolean;
      }>("conversations.rewind", {
        conversationId,
        messageId: userMsg.id,
      });
      expect(res.filesRestored).toBe(false);
      expect(w.checkpoints.calls.restores).toEqual([]);
    } finally {
      await w.cleanup();
    }
  });
});
