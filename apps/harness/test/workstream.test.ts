import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayClient } from "@lilos/client-runtime";
import type { AppMessage, Conversation } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { openDm, setupWorld as setupWorldBase, waitFor } from "./helpers";

/**
 * Issue #156 AC-4: a "new workstream" open materializes its git worktree
 * before `session.start`, `folders.detail` forwards the recents-gated
 * branch/workstream probe, and `existing`/`direct` modes land their cwd as
 * picked. Same in-process world as folder-cwd.test.ts.
 */

const setupWorld = () => setupWorldBase({ reconnectMinDelayMs: 20 });

const git = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

/** A real repo with one commit + a named feature branch. */
function seedRepo() {
  // realpath: git reports /private/tmp on macOS, not the tmpdir() alias.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lilos-ws-")));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "# seed\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-qm", "seed"]);
  git(dir, ["branch", "feat/x"]);
  return dir;
}

const engineRef = async (user: RelayClient, conversationId: string) => {
  const { conversations } = await user.request<{
    conversations: { id: string; engineRef: string | null }[];
  }>("conversations.list", {});
  return conversations.find((c) => c.id === conversationId)?.engineRef;
};

const lastSessionStart = (w: {
  engineCalls: { method: string; params: unknown }[];
}) =>
  w.engineCalls.filter((c) => c.method === "session.start").at(-1)?.params as
    | { cwd?: string }
    | undefined;

const messagesIn = (user: RelayClient, channelId: string, convId: string) =>
  user.request<{ messages: AppMessage[] }>("messages.list", {
    channelId,
    conversationId: convId,
    limit: 100,
  });

describe("AC-4 workstream modes (#156)", () => {
  it('mode "new" creates the worktree + branch, then starts the session in it', async () => {
    const repo = seedRepo();
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const dir = `${repo}/.lilos/wt/add-file`;
      const { conversation } = await w.user.request<{
        conversation: Conversation;
      }>("conversations.open", {
        channelId: channel.id,
        text: "add a file",
        cwd: dir,
        workspace: {
          mode: "new",
          repoPath: repo,
          branch: "ws/add-file",
          base: "main",
        },
      });
      await waitFor(async () => {
        const ref = await engineRef(w.user, conversation.id);
        return ref ? lastSessionStart(w) : undefined;
      }, "session.start");

      // The worktree exists, registered, on its own branch.
      const wt = git(repo, ["worktree", "list", "--porcelain"]);
      expect(wt).toContain(`worktree ${dir}`);
      expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
        "ws/add-file\n",
      );
      // session.start ran inside it.
      expect(lastSessionStart(w)?.cwd).toBe(dir);
      // .lilos is ignored in the parent checkout (worktrees stay invisible).
      expect(existsSync(join(repo, ".lilos", ".gitignore"))).toBe(true);
      expect(git(repo, ["status", "--porcelain"])).toBe("");
    } finally {
      await w.cleanup();
    }
  });

  it('a second open onto an existing worktree reuses it (no "already exists" failure)', {
    timeout: 20_000,
  }, async () => {
    const repo = seedRepo();
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const dir = `${repo}/.lilos/wt/add-file`;
      const workspace = {
        mode: "new",
        repoPath: repo,
        branch: "ws/add-file",
        base: "main",
      };
      for (const text of ["first", "second"]) {
        const { conversation } = await w.user.request<{
          conversation: Conversation;
        }>("conversations.open", {
          channelId: channel.id,
          text,
          cwd: dir,
          workspace,
        });
        await waitFor(async () => {
          const ref = await engineRef(w.user, conversation.id);
          return ref ? true : undefined;
        }, `engineRef for ${text}`);
      }
      expect(lastSessionStart(w)?.cwd).toBe(dir);
    } finally {
      await w.cleanup();
    }
  });

  it('mode "existing" starts the session in the picked worktree', {
    timeout: 20_000,
  }, async () => {
    const repo = seedRepo();
    const dir = `${repo}/.lilos/wt/old`;
    git(repo, ["worktree", "add", "-b", "ws/old", dir, "main"]);
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversation } = await w.user.request<{
        conversation: Conversation;
      }>("conversations.open", {
        channelId: channel.id,
        text: "continue old work",
        cwd: dir,
        workspace: { mode: "existing", repoPath: repo, branch: "ws/old" },
      });
      await waitFor(async () => {
        const ref = await engineRef(w.user, conversation.id);
        return ref ? lastSessionStart(w) : undefined;
      }, "session.start");
      expect(lastSessionStart(w)?.cwd).toBe(dir);
    } finally {
      await w.cleanup();
    }
  });

  it("a worktree failure posts a system note and does not start a session", async () => {
    const w = await setupWorld();
    try {
      const channel = await openDm(w.user);
      const { conversation } = await w.user.request<{
        conversation: Conversation;
      }>("conversations.open", {
        channelId: channel.id,
        text: "work on it",
        cwd: "/tmp/lilos-nope/.lilos/wt/x",
        workspace: {
          mode: "new",
          repoPath: "/tmp/lilos-nope",
          branch: "ws/x",
          base: "main",
        },
      });
      const note = await waitFor(async () => {
        const { messages } = await messagesIn(
          w.user,
          channel.id,
          conversation.id,
        );
        return messages.find(
          (m) =>
            m.authorKind === "system" &&
            m.text.startsWith("Couldn't create worktree"),
        );
      }, "worktree failure note");
      expect(note.text).toContain("ws/x");
      expect(w.engineCalls.some((c) => c.method === "session.start")).toBe(
        false,
      );
    } finally {
      await w.cleanup();
    }
  });
});

describe("AC-4 folders.detail probe (#156)", () => {
  it("a recents-listed repo returns branches and linked worktrees (own checkout filtered)", async () => {
    const repo = seedRepo();
    const dir = `${repo}/.lilos/wt/old`;
    git(repo, ["worktree", "add", "-b", "ws/old", dir, "feat/x"]);
    const w = await setupWorld();
    try {
      await w.user.request("folders.add", { path: repo });
      const detail = await w.user.request<{
        missing: boolean;
        isRepo: boolean;
        root?: string;
        current?: string | null;
        branches: string[];
        workstreams: { branch: string; path: string; from?: string }[];
      }>("folders.detail", { path: repo });
      expect(detail.missing).toBe(false);
      expect(detail.isRepo).toBe(true);
      expect(detail.current).toBe("main");
      expect(detail.branches).toEqual(
        expect.arrayContaining(["main", "feat/x", "ws/old"]),
      );
      expect(detail.workstreams).toEqual([
        expect.objectContaining({
          branch: "ws/old",
          path: dir,
          from: "feat/x",
        }),
      ]);
    } finally {
      await w.cleanup();
    }
  });

  it("a recents-listed non-repo says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lilos-plain-"));
    const w = await setupWorld();
    try {
      await w.user.request("folders.add", { path: dir });
      const detail = await w.user.request<{
        isRepo: boolean;
        missing: boolean;
      }>("folders.detail", { path: dir });
      expect(detail).toMatchObject({ isRepo: false, missing: false });
    } finally {
      await w.cleanup();
    }
  });
});
