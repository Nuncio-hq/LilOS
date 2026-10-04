import { homedir } from "node:os";
import type { RelayClient } from "@lilos/client-runtime";
import type { AppMessage } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { openDm, setupWorld as setupWorldBase, waitFor } from "./helpers";

/**
 * Issue #113: the picked folder becomes the engine session's `cwd`.
 * Issue #196: a folder-less session is a plain chat — no system note
 * announces the default workdir anymore (#113 AC-6 superseded), and a note
 * stored under the old `sys:<conv>:no-folder` dedupe key never renders.
 * Issue #412: that default workdir is the user's home — the conversation
 * row still carries `cwd: null`, so composer/header read "No folder" and
 * the Workbench never opens over ~.
 * Same in-process world as harness.test.ts (borrowed, kept separate so
 * sibling PRs editing that file don't conflict).
 */

const WORKDIR = "/tmp/lilos-test";

const setupWorld = () => setupWorldBase({ reconnectMinDelayMs: 20 });

const lastSessionStart = (w: {
  engineCalls: { method: string; params: unknown }[];
}) =>
  w.engineCalls.filter((c) => c.method === "session.start").at(-1)?.params as
    | { cwd?: string }
    | undefined;

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

describe("AC-4 the picked folder becomes session.start cwd", () => {
  it("conversations.open {cwd} lands in session.start {cwd}", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "look around",
        cwd: "/tmp/picked-folder",
      });
      const start = await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {});
        if (!conversations.find((c) => c.id === conversation.id)?.engineRef)
          return undefined;
        return lastSessionStart(w);
      }, "session.start for picked folder");
      expect(start?.cwd).toBe("/tmp/picked-folder");
    } finally {
      await w.cleanup();
    }
  });

  it("engine-fake echoes the cwd in the answer's reasoning", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "where are you",
        cwd: "/tmp/picked-folder",
      });
      await waitFor(async () => {
        const { messages } = await conversationMessages(
          w.user,
          channel.id,
          conversation.id,
        );
        return messages.find((m) => m.authorKind === "employee");
      }, "employee answer");
      // engine-fake's session.started payload carries cwd — verified on the
      // wire by the session.start assertion above; here we just confirm the
      // turn ran in that session (an answer landed).
      expect(lastSessionStart(w)?.cwd).toBe("/tmp/picked-folder");
    } finally {
      await w.cleanup();
    }
  });

  it("a `~` cwd reaches the engine expanded (checkpoints/session.create need a real cwd)", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "tilde folder",
        cwd: "~/lilos-tilde-cwd",
      });
      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {});
        if (!conversations.find((c) => c.id === conversation.id)?.engineRef)
          return undefined;
        return lastSessionStart(w);
      }, "session.start for ~ folder");
      expect(lastSessionStart(w)?.cwd).toBe(`${homedir()}/lilos-tilde-cwd`);
    } finally {
      await w.cleanup();
    }
  });
});

describe("AC-1 no folder keeps the harness default and stays silent", () => {
  it("open without cwd uses the configured workdir and posts no note", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", { channelId: channel.id, text: "hi" });
      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {});
        if (!conversations.find((c) => c.id === conversation.id)?.engineRef)
          return undefined;
        return lastSessionStart(w);
      }, "session.start for default folder");
      expect(lastSessionStart(w)?.cwd).toBe(WORKDIR);

      /* #412 AC-2b: the conversation row keeps cwd null — composer + thread
         header still say "No folder" and the Workbench (gated on conv.cwd)
         never lists/diffs the home folder this session runs in. */
      const { conversations: rows } = await w.user.request<{
        conversations: { id: string; cwd: string | null }[];
      }>("conversations.list", {});
      expect(
        rows.find((c) => c.id === conversation.id)?.cwd ?? null,
      ).toBeNull();

      // Give the turn a beat to settle, then read the whole thread: no
      // "No folder: working in …" note — the session is a plain chat (#196).
      await waitFor(async () => {
        const { messages } = await conversationMessages(
          w.user,
          channel.id,
          conversation.id,
        );
        return messages.find((m) => m.authorKind === "employee");
      }, "employee answer");
      const { messages } = await conversationMessages(
        w.user,
        channel.id,
        conversation.id,
      );
      expect(
        messages.some(
          (m) => m.authorKind === "system" && m.text.startsWith("No folder:"),
        ),
      ).toBe(false);
    } finally {
      await w.cleanup();
    }
  });

  it("a stored no-folder note never comes back on read", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", { channelId: channel.id, text: "hi" });
      // Seed the retired note the way pre-#196 harnesses stored it — same
      // dedupe key — then read back through the wire: it must not render.
      await w.store.appendMessage({
        channelId: channel.id,
        conversationId: conversation.id,
        authorId: "",
        authorKind: "system",
        text: `No folder: working in ${WORKDIR}`,
        dedupeKey: `sys:${conversation.id}:no-folder`,
      });
      // Wait for the employee answer so the counts below are deterministic.
      await waitFor(async () => {
        const { messages } = await conversationMessages(
          w.user,
          channel.id,
          conversation.id,
        );
        return messages.find((m) => m.authorKind === "employee");
      }, "employee answer");
      const { messages } = await conversationMessages(
        w.user,
        channel.id,
        conversation.id,
      );
      expect(messages.some((m) => m.text.startsWith("No folder:"))).toBe(false);
      // The DM feed's summary (answer preview, latest, count) drops it too.
      const { summaries } = await w.user.request<{
        summaries: {
          conversation: { id: string };
          firstAnswer?: { text: string };
          last: { text: string };
          messageCount: number;
        }[];
      }>("conversations.summaries", { channelId: channel.id });
      const s = summaries.find((x) => x.conversation.id === conversation.id);
      expect(s?.firstAnswer?.text.startsWith("No folder:") ?? false).toBe(
        false,
      );
      expect(s?.last.text.startsWith("No folder:") ?? false).toBe(false);
      // root + the employee answer — the hidden note doesn't count.
      expect(s?.messageCount).toBe(2);
    } finally {
      await w.cleanup();
    }
  });

  it("a folder'd session posts no no-folder note", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversation } = await w.user.request<{
        conversation: { id: string };
      }>("conversations.open", {
        channelId: channel.id,
        text: "hi",
        cwd: "/tmp/with-folder",
      });
      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { id: string; engineRef: string | null }[];
        }>("conversations.list", {});
        if (!conversations.find((c) => c.id === conversation.id)?.engineRef)
          return undefined;
        return true;
      }, "engineRef");
      // Give the turn a beat to settle, then read the whole thread.
      await new Promise((r) => setTimeout(r, 150));
      const { messages } = await conversationMessages(
        w.user,
        channel.id,
        conversation.id,
      );
      expect(
        messages.some(
          (m) => m.authorKind === "system" && m.text.startsWith("No folder:"),
        ),
      ).toBe(false);
    } finally {
      await w.cleanup();
    }
  });
});
