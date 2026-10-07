import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayClient } from "@lilos/client-runtime";
import type { AppMessage } from "@lilos/contracts/app";
import type { FakeEngine } from "@lilos/engine-fake";
import { describe, expect, it } from "vitest";
import type { Harness } from "../src/harness";
import {
  openDm,
  type Relay,
  setupWorld as setupWorldBase,
  waitFor as waitForBase,
} from "./helpers";

/**
 * Issue #581 harness leg: `conversations.moveFolder` re-homes the session's
 * working folder through the engine (`session.moveWorkspace`, capability
 * `workspace_move`), stamps the landed cwd on the conversation row, and
 * posts the honest system note — the running session moved, or the next
 * turn works there. An engine that can't move gets a refusal, never a
 * label-only write.
 */

const waitFor = <T>(
  fn: () => T | undefined | Promise<T | undefined>,
  what: string,
): Promise<T> => waitForBase(fn, what, 15_000);

interface World {
  relay: Relay;
  engine: FakeEngine;
  engineCalls: { method: string; params: unknown }[];
  harness: Harness;
  user: RelayClient;
  homeDir: string;
  workdir: string;
  cleanup: () => Promise<void>;
}

async function setupWorld(opts?: {
  engineOpts?: ConstructorParameters<typeof FakeEngine>[0];
  attachEngine?: boolean;
}): Promise<World> {
  const workdir = mkdtempSync(join(tmpdir(), "lilos-581-work-"));
  const homeDir = mkdtempSync(join(tmpdir(), "lilos-581-home-"));
  const w = await setupWorldBase({
    workdir,
    rmWorkdir: true,
    homeDir,
    engineOpts: opts?.engineOpts,
    attachEngine: opts?.attachEngine,
    reconnectMinDelayMs: 20,
  });
  return {
    relay: w.relay,
    engine: w.engine as FakeEngine,
    engineCalls: w.engineCalls,
    harness: w.harness,
    user: w.user,
    homeDir,
    workdir,
    cleanup: w.cleanup,
  };
}

async function sendAndAnswer(
  user: RelayClient,
  channelId: string,
  conversationId: string | undefined,
  text: string,
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

const convOf = (user: RelayClient, channelId: string, id: string) =>
  user
    .request<{
      conversations: { id: string; cwd?: string | null; engineRef?: string }[];
    }>("conversations.list", { channelId })
    .then((r) => r.conversations.find((c) => c.id === id));

const moveErr = async (
  user: RelayClient,
  conversationId: string,
  path: string,
): Promise<{ code?: number; message: string }> => {
  try {
    await user.request("conversations.moveFolder", { conversationId, path });
    throw new Error("expected moveFolder to reject");
  } catch (e) {
    return e as { code?: number; message: string };
  }
};

describe("conversations.moveFolder — harness leg (#581)", () => {
  it("AC-2 a folder-less thread moves: engine session.moveWorkspace + landed cwd + honest note", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversationId } = await sendAndAnswer(
        w.user,
        channel.id,
        undefined,
        "hi",
      );
      // The engine session bound (engineRef stamped) before the move.
      await waitFor(async () => {
        const c = await convOf(w.user, channel.id, conversationId);
        return c?.engineRef ? c : undefined;
      }, "engineRef bound");

      const target = join(w.homeDir, "picked");
      mkdirSync(target);
      const { conversation } = await w.user.request<{
        conversation: { id: string; cwd?: string | null };
      }>("conversations.moveFolder", {
        conversationId,
        path: target,
      });
      // Stored collapsed (under-home paths render as ~/…).
      expect(conversation.cwd).toBe("~/picked");

      const moveCalls = w.engineCalls.filter(
        (c) => c.method === "session.moveWorkspace",
      );
      expect(moveCalls).toHaveLength(1);
      expect(moveCalls[0].params).toMatchObject({ cwd: target });

      const { messages } = await w.user.request<{ messages: AppMessage[] }>(
        "messages.list",
        { channelId: channel.id, conversationId, limit: 100 },
      );
      const note = messages.at(-1);
      expect(note?.authorKind).toBe("system");
      expect(note?.text).toContain("~/picked");
      expect(note?.text).toContain("the running session moved too");

      // The next turn runs in the moved folder — engine-fake echoes its cwd.
      const { messages: after } = await sendAndAnswer(
        w.user,
        channel.id,
        conversationId,
        "where are you",
      );
      expect(after.at(-1)?.text ?? "").toContain(target);
    } finally {
      await w.cleanup();
    }
  });

  it("a live session in one folder re-homes to another", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const dirA = join(w.homeDir, "a");
      mkdirSync(dirA);
      const { conversationId } = await sendAndAnswer(
        w.user,
        channel.id,
        undefined,
        "hi",
        dirA,
      );
      const dirB = join(w.homeDir, "b");
      mkdirSync(dirB);
      const { conversation } = await w.user.request<{
        conversation: { cwd?: string | null };
      }>("conversations.moveFolder", {
        conversationId,
        path: dirB,
      });
      expect(conversation.cwd).toBe("~/b");
    } finally {
      await w.cleanup();
    }
  });

  it("a missing folder is refused and nothing moves", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversationId } = await sendAndAnswer(
        w.user,
        channel.id,
        undefined,
        "hi",
      );
      const err = await moveErr(
        w.user,
        conversationId,
        join(w.homeDir, "does-not-exist"),
      );
      expect(err.message).toContain("does not exist");
      expect(
        w.engineCalls.filter((c) => c.method === "session.moveWorkspace"),
      ).toHaveLength(0);
      const conv = await convOf(w.user, channel.id, conversationId);
      expect(conv?.cwd ?? null).toBeNull();
    } finally {
      await w.cleanup();
    }
  });

  it("a path outside the home folder is refused (boundary)", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversationId } = await sendAndAnswer(
        w.user,
        channel.id,
        undefined,
        "hi",
      );
      const err = await moveErr(w.user, conversationId, "/etc");
      /* The JSON-RPC code lands in data.code on the client error; the
         boundary refusal reads plainly. */
      expect(err.message).toContain("outside the Mac's home folder");
    } finally {
      await w.cleanup();
    }
  });

  it("an engine without workspace_move is refused, never a label-only write", async () => {
    const w = await setupWorld({
      engineOpts: { capabilities: { workspace_move: false } },
    });
    try {
      const channel = await openDm(w.user);
      const { conversationId } = await sendAndAnswer(
        w.user,
        channel.id,
        undefined,
        "hi",
      );
      await waitFor(async () => {
        const c = await convOf(w.user, channel.id, conversationId);
        return c?.engineRef ? c : undefined;
      }, "engineRef bound");
      const target = join(w.homeDir, "picked");
      mkdirSync(target);
      const err = await moveErr(w.user, conversationId, target);
      expect(err.message).toContain("can't move");
      const conv = await convOf(w.user, channel.id, conversationId);
      expect(conv?.cwd ?? null).toBeNull();
    } finally {
      await w.cleanup();
    }
  });

  it("a session the engine forgot still stamps the folder (next turn works there)", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversationId } = await sendAndAnswer(
        w.user,
        channel.id,
        undefined,
        "hi",
      );
      await waitFor(async () => {
        const c = await convOf(w.user, channel.id, conversationId);
        return c?.engineRef ? c : undefined;
      }, "engineRef bound");

      /* Forget the session on the engine only — the conversation keeps its
         engineRef; the move then stamps cwd without a fake "moved". */
      const engine = w.harness as unknown as {
        engine: { request?: (m: string, p?: unknown) => Promise<unknown> };
      };
      const conn = engine.engine;
      const req = conn.request;
      if (!req) throw new Error("no conn.request");
      const orig = req.bind(conn);
      conn.request = (m: string, p?: unknown) =>
        m === "session.moveWorkspace"
          ? Promise.reject(
              Object.assign(new Error("no session"), { code: -32001 }),
            )
          : orig(m, p);

      const target = join(w.homeDir, "picked");
      mkdirSync(target);
      const { conversation } = await w.user.request<{
        conversation: { cwd?: string | null };
      }>("conversations.moveFolder", {
        conversationId,
        path: target,
      });
      expect(conversation.cwd).toBe("~/picked");
      const { messages } = await w.user.request<{ messages: AppMessage[] }>(
        "messages.list",
        { channelId: channel.id, conversationId, limit: 100 },
      );
      expect(messages.at(-1)?.text).toContain("the next turn works there");
    } finally {
      await w.cleanup();
    }
  });
});
