import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppMessage, Conversation } from "@lilos/contracts/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectEngineWs } from "../src/engine/client";
import { fakeEngineLauncher } from "../src/engine/launcher";
import { EngineSupervisor } from "../src/engine/supervisor";
import { createAppOps } from "../src/harness/app-ops";
import { createMemoryLogger } from "../src/log";
import {
  copyFixtureRepo,
  homes,
  isolateFixtureGit,
  mkhome,
  openDmConversation,
  seedFixtureRepo,
  setupWorld,
  waitFor,
} from "./helpers";

/* Same fixture rule as task-worktree.test.ts (#784): one seeded repo per
   file, copied per test, git isolated from the machine's config. */
isolateFixtureGit();

/**
 * D-#881 end-to-end (engine-fake): a settled thread whose `cwd` is a
 * `.lilos/wt` worktree gives the copy back — the folder disappears and one
 * quiet system line lands on the thread. Dirty or unpushed work keeps it
 * (and says why); a running turn defers the cleanup until it finishes;
 * coming back (un-settle, a fresh send) re-materializes it from the
 * branch before the turn starts.
 */

const git = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

let template = "";

beforeAll(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilos-wtc-seed-")));
  template = seedFixtureRepo(root, "main");
});

afterAll(() => {
  if (template) rmSync(template, { recursive: true, force: true });
});

function seedRepo() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "lilos-wtc-")));
  homes.push(parent);
  const dir = join(parent, "repo");
  copyFixtureRepo(template, dir);
  return dir;
}

type World = Awaited<ReturnType<typeof setupWorld>>;

const messagesIn = async (w: World, channelId: string) =>
  (
    await w.user.request<{ messages: AppMessage[] }>("messages.list", {
      channelId,
      limit: 100,
    })
  ).messages;

const systemLine = async (
  w: World,
  conv: { id: string; channelId: string },
  match: string | RegExp,
) =>
  waitFor(async () => {
    const messages = await messagesIn(w, conv.channelId);
    return messages.find(
      (m) =>
        m.conversationId === conv.id &&
        m.authorKind === "system" &&
        (typeof match === "string"
          ? m.text.includes(match)
          : match.test(m.text)),
    );
  }, `system line ${match}`);

const convRow = async (w: World, id: string) => {
  const { conversations } = await w.user.request<{
    conversations: Conversation[];
  }>("conversations.list", { includeArchived: true });
  return conversations.find((c) => c.id === id);
};

const settle = (w: World, id: string, settled = true) =>
  w.user.request("conversations.settle", { conversationId: id, settled });

const finished = async (w: World, id: string) =>
  waitFor(async () => {
    const conv = await convRow(w, id);
    return conv?.finishedSeq ? conv : undefined;
  }, `turn finished on ${id}`);

/** Open a workstream thread on `cwd = <repo>/.lilos/wt/<slug>` (the #156
    open path — the harness materializes the worktree at bind). */
async function openWorkstream(
  w: World,
  channelId: string,
  repo: string,
  slug: string,
  text: string,
) {
  const cwd = join(repo, ".lilos", "wt", slug);
  const { conversation } = await w.user.request<{
    conversation: Conversation;
  }>("conversations.open", {
    channelId,
    text,
    cwd,
    workspace: {
      mode: "new",
      repoPath: repo,
      branch: `ws/${slug}`,
      base: "main",
    },
  });
  await waitFor(async () => {
    const call = w.engineCalls.find(
      (c) =>
        c.method === "session.start" &&
        (c.params as { cwd?: string }).cwd === cwd,
    );
    return call ? true : undefined;
  }, "session.start in the worktree");
  expect(existsSync(cwd)).toBe(true);
  return { conversation, cwd };
}

describe("settled worktree cleanup (D-#881)", () => {
  it("task_create worktree → turn finishes → settle → folder gone + quiet line", async () => {
    const repo = seedRepo();
    const homeDir = mkhome();
    const w = await setupWorld({ homeDir });
    try {
      const { employee: caller, channel: callerChannel } =
        await openDmConversation(w.user);
      await w.user.request("employees.create", { name: "Bea", role: "eng" });
      const { conversation: parent } = await w.user.request<{
        conversation: Conversation;
      }>("conversations.open", {
        channelId: callerChannel.id,
        text: "Summarize the week",
        cwd: repo,
      });
      await finished(w, parent.id);
      const ops = createAppOps({
        relay: w.harnessRelay,
        runningTurnId: () => undefined,
        log: w.log,
        home: homeDir,
      })("s1", {
        employeeId: caller.id,
        channelId: callerChannel.id,
        conversationId: parent.id,
      });
      if (!ops) throw new Error("no appOps");
      const r = await ops.taskCreate({
        agent: "Bea",
        prompt: "Check the flaky test",
        title: "Fix the flaky test",
      });
      const child = await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: Conversation[];
        }>("conversations.list", {});
        const c = conversations.find((x) => x.parentId === parent.id);
        return c?.finishedSeq ? c : undefined;
      }, "child turn finished");
      expect(child.cwd).toBe(r.task.worktree?.path);

      await settle(w, child.id);
      const dir = r.task.worktree?.path ?? "";
      await waitFor(() => (!existsSync(dir) ? true : undefined), "dir gone");
      const line = await systemLine(w, child, "Worktree cleaned up");
      /* ws/<slug> rode no commits — merged on main → branch went with it. */
      expect(line.text).toBe("Worktree cleaned up (branch merged)");
      expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(
        ".lilos/wt",
      );
      expect(
        git(repo, ["branch", "--list", "ws/*", "--format=%(refname:short)"]),
      ).toBe("");
      /* D-#881 review: the quiet line is a host-posted SYSTEM message —
         the relay's resume rule must leave the settle alone, or every
         restart would ping-pong remove→line→un-settle→restore. */
      await new Promise((r) => setTimeout(r, 400));
      const after = await convRow(w, child.id);
      expect(after?.settledAt).toBeTypeOf("number");
      expect(after?.archived).toBe(true);
      expect(existsSync(dir)).toBe(false);
      expect(
        (await messagesIn(w, child.channelId)).filter(
          (m) =>
            m.conversationId === child.id &&
            m.authorKind === "system" &&
            m.text.startsWith("Worktree cleaned up"),
        ).length,
      ).toBe(1);
    } finally {
      await w.cleanup();
    }
  }, 30_000);

  it("dirty copy is kept and the thread says why", async () => {
    const repo = seedRepo();
    const w = await setupWorld({ homeDir: mkhome() });
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation, cwd } = await openWorkstream(
        w,
        channel.id,
        repo,
        "keep-dirty",
        "Work here",
      );
      await finished(w, conversation.id);
      writeFileSync(join(cwd, "unsaved.txt"), "don't lose me\n");

      await settle(w, conversation.id);
      const line = await systemLine(w, conversation, "Kept the worktree");
      expect(line.text).toBe(
        "Kept the worktree: it has unsaved or unpushed changes (1 file)",
      );
      expect(existsSync(join(cwd, "unsaved.txt"))).toBe(true);
      /* …and nothing else happened — no second line, folder intact. */
      const messages = await messagesIn(w, conversation.channelId);
      expect(
        messages.filter(
          (m) =>
            m.conversationId === conversation.id &&
            m.authorKind === "system" &&
            m.text.startsWith("Kept the worktree"),
        ).length,
      ).toBe(1);
    } finally {
      await w.cleanup();
    }
  }, 30_000);

  it("unpushed commits keep the copy", async () => {
    const repo = seedRepo();
    const w = await setupWorld({ homeDir: mkhome() });
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation, cwd } = await openWorkstream(
        w,
        channel.id,
        repo,
        "keep-unpushed",
        "Work here",
      );
      await finished(w, conversation.id);
      writeFileSync(join(cwd, "new-work.txt"), "unpushed\n");
      git(cwd, ["add", "."]);
      git(cwd, ["commit", "-qm", "wip"]);

      await settle(w, conversation.id);
      await systemLine(w, conversation, "Kept the worktree");
      expect(existsSync(join(cwd, "new-work.txt"))).toBe(true);
      expect(
        git(repo, [
          "branch",
          "--list",
          "ws/keep-unpushed",
          "--format=%(refname:short)",
        ]).trim(),
      ).toBe("ws/keep-unpushed");
    } finally {
      await w.cleanup();
    }
  }, 30_000);

  it("a running turn is untouched — cleanup fires once it finishes", async () => {
    const repo = seedRepo();
    const w = await setupWorld({ homeDir: mkhome() });
    try {
      const { channel } = await openDmConversation(w.user);
      /* `stuck:` holds the turn open until it is interrupted. */
      const { conversation, cwd } = await openWorkstream(
        w,
        channel.id,
        repo,
        "busy",
        "stuck:",
      );
      await waitFor(
        async () =>
          (await convRow(w, conversation.id))?.state === "active" || undefined,
        "turn running",
      );

      await settle(w, conversation.id);
      await waitFor(
        async () =>
          (await convRow(w, conversation.id))?.settledAt !== undefined ||
          undefined,
        "settled",
      );
      /* The settle landed; the cleanup skipped the live turn — the copy
         stays and no line posted yet. */
      await new Promise((r) => setTimeout(r, 300));
      expect(existsSync(cwd)).toBe(true);
      expect(
        (await messagesIn(w, conversation.channelId)).some(
          (m) =>
            m.conversationId === conversation.id && m.authorKind === "system",
        ),
      ).toBe(false);

      await w.user.request("turns.interrupt", {
        conversationId: conversation.id,
      });
      await waitFor(
        () => (!existsSync(cwd) ? true : undefined),
        "dir gone after turn",
      );
      await systemLine(w, conversation, "Worktree cleaned up");
    } finally {
      await w.cleanup();
    }
  }, 30_000);

  it("coming back re-creates the worktree from the branch before the turn", async () => {
    const repo = seedRepo();
    const w = await setupWorld({ homeDir: mkhome() });
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation, cwd } = await openWorkstream(
        w,
        channel.id,
        repo,
        "return",
        "Work here",
      );
      await finished(w, conversation.id);
      /* Give the branch work worth keeping — pushed so the copy is safe
         to remove while the branch survives. */
      const remote = join(repo, "..", "remote.git");
      mkdirSync(remote);
      git(remote, ["init", "--bare", "-q", "-b", "main"]);
      git(cwd, ["remote", "add", "origin", remote]);
      writeFileSync(join(cwd, "output.txt"), "result\n");
      git(cwd, ["add", "."]);
      git(cwd, ["commit", "-qm", "result"]);
      git(cwd, ["push", "-qu", "origin", "ws/return"]);

      await settle(w, conversation.id);
      await waitFor(() => (!existsSync(cwd) ? true : undefined), "dir gone");
      await systemLine(w, conversation, "Worktree cleaned up");

      /* The user sends into the shelf — the relay un-settles on the send;
         the worktree must be back from ws/return before the turn runs. */
      await w.user.request("messages.post", {
        channelId: channel.id,
        conversationId: conversation.id,
        text: "one more thing",
        authorKind: "user",
      });
      await waitFor(
        () => (existsSync(join(cwd, "output.txt")) ? true : undefined),
        "dir back",
      );
      await waitFor(async () => {
        const messages = await messagesIn(w, conversation.channelId);
        return messages.filter(
          (m) =>
            m.conversationId === conversation.id && m.authorKind === "employee",
        )[1];
      }, "answer on the restored worktree");
      expect(git(cwd, ["symbolic-ref", "--short", "HEAD"]).trim()).toBe(
        "ws/return",
      );
    } finally {
      await w.cleanup();
    }
  }, 30_000);

  it("a live thread inside the same folder blocks; its settle releases", async () => {
    const repo = seedRepo();
    const w = await setupWorld({ homeDir: mkhome() });
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation: a, cwd } = await openWorkstream(
        w,
        channel.id,
        repo,
        "shared",
        "Work here",
      );
      await finished(w, a.id);
      /* A second LIVE thread parked on the same folder — a shared-
         isolation helper, a second thread bound to it. Its turn runs
         there; removing A's copy out from under it is the data-loss
         case the sharer guard exists for. */
      const { conversation: b } = await w.user.request<{
        conversation: Conversation;
      }>("conversations.open", {
        channelId: channel.id,
        text: "share the folder",
        cwd,
      });
      await finished(w, b.id);

      await settle(w, a.id);
      await new Promise((r) => setTimeout(r, 400));
      expect(existsSync(cwd)).toBe(true);
      expect(
        (await messagesIn(w, a.channelId)).some(
          (m) => m.conversationId === a.id && m.authorKind === "system",
        ),
      ).toBe(false);

      /* The last sharer settling retires the guard — A's copy goes now,
         and A's thread gets its line. */
      await settle(w, b.id);
      await waitFor(
        () => (!existsSync(cwd) ? true : undefined),
        "dir gone after the sharer settled",
      );
      await systemLine(w, a, "Worktree cleaned up");
    } finally {
      await w.cleanup();
    }
  }, 30_000);

  it("a sharer settled mid-turn still blocks until its turn ends", async () => {
    const repo = seedRepo();
    const w = await setupWorld({ homeDir: mkhome() });
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation: a, cwd } = await openWorkstream(
        w,
        channel.id,
        repo,
        "held",
        "Work here",
      );
      await finished(w, a.id);
      /* B parks on A's folder and gets settled WHILE its turn is still
         running — the stamp says "done", the folder says "in use".
         Removing under the running turn is exactly the loss the
         sharer guard's activity check exists for. */
      const { conversation: b } = await w.user.request<{
        conversation: Conversation;
      }>("conversations.open", {
        channelId: channel.id,
        text: "stuck:",
        cwd,
      });
      await waitFor(
        async () => (await convRow(w, b.id))?.state === "active" || undefined,
        "b turn running",
      );
      await settle(w, b.id);
      await settle(w, a.id);
      await new Promise((r) => setTimeout(r, 500));
      expect(existsSync(cwd)).toBe(true);
      expect(
        (await messagesIn(w, a.channelId)).some(
          (m) =>
            m.conversationId === a.id &&
            m.authorKind === "system" &&
            m.text.startsWith("Worktree cleaned up"),
        ),
      ).toBe(false);
      /* B's turn ending updates its row — the rescan re-runs A's check,
         B is now settled AND idle, and the copy goes. */
      await w.user.request("turns.interrupt", { conversationId: b.id });
      await waitFor(
        () => (!existsSync(cwd) ? true : undefined),
        "dir gone after B's turn ended",
      );
      await systemLine(w, a, "Worktree cleaned up");
    } finally {
      await w.cleanup();
    }
  }, 30_000);

  it("an un-settle mid-remove restores — the sibling's remove rode its OWN chain", async () => {
    const repo = seedRepo();
    const w = await setupWorld({ homeDir: mkhome() });
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation: a, cwd } = await openWorkstream(
        w,
        channel.id,
        repo,
        "race",
        "Work here",
      );
      await finished(w, a.id);
      /* 300 committed files make `git worktree remove` slow enough that
         an un-settle can land MID-remove — the window where running the
         sibling's remove on OUR chain would strand the restore (it
         would peek mid-remove, see the folder, and skip). Push the
         branch so the copy is removable and the branch survives for
         the rebuild. */
      const remote = join(repo, "..", "remote.git");
      mkdirSync(remote);
      git(remote, ["init", "--bare", "-q", "-b", "main"]);
      git(cwd, ["remote", "add", "origin", remote]);
      for (let i = 0; i < 300; i++) {
        writeFileSync(
          join(cwd, `f${String(i).padStart(3, "0")}.txt`),
          `${i}\n`,
        );
      }
      git(cwd, ["add", "."]);
      git(cwd, ["commit", "-qm", "bulk"]);
      git(cwd, ["push", "-qu", "origin", "ws/race"]);
      const { conversation: b } = await w.user.request<{
        conversation: Conversation;
      }>("conversations.open", {
        channelId: channel.id,
        text: "share the folder",
        cwd,
      });
      await finished(w, b.id);
      await settle(w, a.id); // blocked — B is live
      /* B settles → A's cleanup is enqueued ON A'S OWN CHAIN. An
         un-settle landing while it runs queues its restore behind the
         remove — the folder comes back instead of vanishing under a
         live thread. */
      await settle(w, b.id);
      await new Promise((r) => setTimeout(r, 50));
      await settle(w, a.id, false);
      /* Whatever order the remove and the un-settle actually committed
         in, the folder ends up present: either the cleanup read the
         un-settled row and never ran, or it removed and the queued
         restore rebuilt. The losing outcome — gone under a live thread
         — is the bug. */
      await waitFor(
        () => (existsSync(join(cwd, "f000.txt")) ? true : undefined),
        "dir back (or never gone)",
        8_000,
      );
    } finally {
      await w.cleanup();
    }
  }, 30_000);

  it("a settle rescans settled threads in ONE bounded pass — no recursion", async () => {
    const repo = seedRepo();
    const w = await setupWorld({ homeDir: mkhome() });
    try {
      const { channel } = await openDmConversation(w.user);
      /* Ten ordinary settled chats — never worktrees, so they never
         earn a "handled" mark. The regression: the rescan re-entered
         the full entry point for every settled row, each re-entry
         rescanning all the others — the cascade never ended. */
      const ordinary: Conversation[] = [];
      for (let i = 0; i < 10; i++) {
        const { conversation } = await w.user.request<{
          conversation: Conversation;
        }>("conversations.open", {
          channelId: channel.id,
          text: `chat ${i}`,
          cwd: repo,
        });
        ordinary.push(conversation);
      }
      /* Two worktree threads, each parked behind a live sharer so they
         sit settled-but-unhandled when the trigger settle lands. */
      const w1 = await openWorkstream(w, channel.id, repo, "one", "work");
      const w2 = await openWorkstream(w, channel.id, repo, "two", "work");
      await finished(w, w1.conversation.id);
      await finished(w, w2.conversation.id);
      const s1 = (
        await w.user.request<{ conversation: Conversation }>(
          "conversations.open",
          { channelId: channel.id, text: "share one", cwd: w1.cwd },
        )
      ).conversation;
      const s2 = (
        await w.user.request<{ conversation: Conversation }>(
          "conversations.open",
          { channelId: channel.id, text: "share two", cwd: w2.cwd },
        )
      ).conversation;
      await finished(w, s1.id);
      await finished(w, s2.id);
      for (const c of ordinary) await settle(w, c.id);
      await settle(w, w1.conversation.id); // blocked — s1 is live
      await settle(w, w2.conversation.id); // blocked — s2 is live

      /* Count entry-point invocations: one per row event is the design;
         a recursive rescan counts in the thousands. */
      const h = w.harness as unknown as {
        cleanupSettledWorktree: (conv: Conversation) => Promise<void>;
      };
      const orig = h.cleanupSettledWorktree;
      let calls = 0;
      h.cleanupSettledWorktree = (conv: Conversation) => {
        calls++;
        return orig.call(w.harness, conv);
      };
      try {
        /* Retiring each sharer releases exactly its own worktree — one
           settle, one bounded rescan, one cleanup step on the sibling's
           own chain. */
        await settle(w, s1.id);
        await waitFor(
          () => (!existsSync(w1.cwd) ? true : undefined),
          "w1 gone",
        );
        await settle(w, s2.id);
        await waitFor(
          () => (!existsSync(w2.cwd) ? true : undefined),
          "w2 gone",
        );
      } finally {
        h.cleanupSettledWorktree = orig;
      }
      await systemLine(w, w1.conversation, "Worktree cleaned up");
      await systemLine(w, w2.conversation, "Worktree cleaned up");
      expect(calls).toBeLessThan(30);
    } finally {
      await w.cleanup();
    }
  }, 30_000);

  it("a restart's startup scan stays bounded with many settled threads", async () => {
    const repo = seedRepo();
    const w = await setupWorld({ homeDir: mkhome() });
    try {
      const { channel } = await openDmConversation(w.user);
      /* The app's real shape: ~34 threads, a handful settled ordinary
         chats among them. The scan lists once and each settled row's
         own chain does the work — nothing re-enters. */
      const convs: Conversation[] = [];
      for (let i = 0; i < 32; i++) {
        const { conversation } = await w.user.request<{
          conversation: Conversation;
        }>("conversations.open", {
          channelId: channel.id,
          text: `t${i}`,
          cwd: repo,
        });
        convs.push(conversation);
      }
      const w1 = await openWorkstream(w, channel.id, repo, "sweep1", "x");
      const w2 = await openWorkstream(w, channel.id, repo, "sweep2", "x");
      await finished(w, w1.conversation.id);
      await finished(w, w2.conversation.id);
      for (const c of convs.slice(0, 7)) await settle(w, c.id);
      await settle(w, w1.conversation.id);
      await settle(w, w2.conversation.id);
      await waitFor(
        () => (!existsSync(w1.cwd) && !existsSync(w2.cwd) ? true : undefined),
        "pre-scan dirs gone",
      );

      /* Re-run the register-time scan the way a restart does. */
      const h = w.harness as unknown as {
        cleanupSettledWorktree: (conv: Conversation) => Promise<void>;
        onRelayReady: () => Promise<void>;
      };
      const orig = h.cleanupSettledWorktree;
      let calls = 0;
      h.cleanupSettledWorktree = (conv: Conversation) => {
        calls++;
        return orig.call(w.harness, conv);
      };
      try {
        await h.onRelayReady();
      } finally {
        h.cleanupSettledWorktree = orig;
      }
      /* One entry call per settled row in the scan list — never a
         re-entry per settled sibling. */
      expect(calls).toBeLessThan(60);
    } finally {
      await w.cleanup();
    }
  }, 60_000);

  it("a thread filed on a subfolder inside a worktree settles silently", async () => {
    const repo = seedRepo();
    const w = await setupWorld({ homeDir: mkhome() });
    try {
      const { channel } = await openDmConversation(w.user);
      /* cwd is INSIDE a worktree but not the worktree itself — not a
         direct child of .lilos/wt, so it's none of the cleanup's
         business: no verdict line, nothing touched. */
      const { conversation } = await w.user.request<{
        conversation: Conversation;
      }>("conversations.open", {
        channelId: channel.id,
        text: "filed deep",
        cwd: join(repo, ".lilos", "wt", "deep", "inner"),
        workspace: { mode: "existing", repoPath: repo, branch: "ws/deep" },
      });
      await finished(w, conversation.id);
      await settle(w, conversation.id);
      await new Promise((r) => setTimeout(r, 500));
      expect(
        (await messagesIn(w, conversation.channelId)).some(
          (m) =>
            m.conversationId === conversation.id && m.authorKind === "system",
        ),
      ).toBe(false);
    } finally {
      await w.cleanup();
    }
  }, 30_000);

  it("un-settle after the cleanup restores the copy — no message needed", async () => {
    const repo = seedRepo();
    const w = await setupWorld({ homeDir: mkhome() });
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation, cwd } = await openWorkstream(
        w,
        channel.id,
        repo,
        "unshelf",
        "Work here",
      );
      await finished(w, conversation.id);
      /* Push the branch so the copy is removable while the branch
         survives to be re-attached. */
      const remote = join(repo, "..", "remote.git");
      mkdirSync(remote);
      git(remote, ["init", "--bare", "-q", "-b", "main"]);
      git(cwd, ["remote", "add", "origin", remote]);
      writeFileSync(join(cwd, "output.txt"), "result\n");
      git(cwd, ["add", "."]);
      git(cwd, ["commit", "-qm", "result"]);
      git(cwd, ["push", "-qu", "origin", "ws/unshelf"]);

      await settle(w, conversation.id);
      await waitFor(() => (!existsSync(cwd) ? true : undefined), "dir gone");
      await systemLine(w, conversation, "Worktree cleaned up");

      /* An un-settle (the shelf button, not a message) must still put
         the copy back — "dir missing and thread is live" is the whole
         restore condition, so an un-settle that lands mid-cleanup wins
         the same way. */
      await settle(w, conversation.id, false);
      /* The dir appears before the checkout lands — wait on a file the
         restore must contain, not the folder itself. */
      await waitFor(
        () => (existsSync(join(cwd, "output.txt")) ? true : undefined),
        "dir back after un-settle",
      );
      expect(git(cwd, ["symbolic-ref", "--short", "HEAD"]).trim()).toBe(
        "ws/unshelf",
      );
    } finally {
      await w.cleanup();
    }
  }, 30_000);

  it("an engine restart rebind of a settled thread does NOT re-create the copy", async () => {
    const repo = seedRepo();
    const w = await setupWorld({ homeDir: mkhome() });
    try {
      const { channel } = await openDmConversation(w.user);
      const { conversation, cwd } = await openWorkstream(
        w,
        channel.id,
        repo,
        "reboot",
        "Work here",
      );
      await finished(w, conversation.id);
      await settle(w, conversation.id);
      await waitFor(() => (!existsSync(cwd) ? true : undefined), "dir gone");
      await systemLine(w, conversation, "Worktree cleaned up");

      /* A fresh engine process knows none of the sessions — the resync
         re-binds the (settled) binding; `ensureWorktree` must refuse:
         restore is for LIVE threads only. */
      const log = createMemoryLogger();
      const supervisor = new EngineSupervisor({
        launcher: fakeEngineLauncher({ repoRoot: process.cwd(), tick: 1, log }),
        connect: async (url) => connectEngineWs(url),
        onConnection: (conn) => w.harness.attachEngine(conn),
        onState: () => {},
        log,
        minBackoffMs: 10,
        maxConsecutiveCrashes: 3,
      });
      const before = (await convRow(w, conversation.id))?.engineRef;
      await supervisor.start();
      try {
        await waitFor(
          async () => {
            const ref = (await convRow(w, conversation.id))?.engineRef;
            return ref && ref !== before ? ref : undefined;
          },
          "rebound session ref",
          8_000,
        );
        await new Promise((r) => setTimeout(r, 300));
        expect(existsSync(cwd)).toBe(false);
        const after = await convRow(w, conversation.id);
        expect(after?.settledAt).toBeTypeOf("number");
      } finally {
        await supervisor.stop();
      }
    } finally {
      await w.cleanup();
    }
  }, 30_000);
});
