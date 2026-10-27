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
import { createAppOps } from "../src/harness/app-ops";
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
      await waitFor(() => (existsSync(cwd) ? true : undefined), "dir back");
      await waitFor(async () => {
        const messages = await messagesIn(w, conversation.channelId);
        return messages.filter(
          (m) =>
            m.conversationId === conversation.id && m.authorKind === "employee",
        )[1];
      }, "answer on the restored worktree");
      expect(existsSync(join(cwd, "output.txt"))).toBe(true);
      expect(git(cwd, ["symbolic-ref", "--short", "HEAD"]).trim()).toBe(
        "ws/return",
      );
    } finally {
      await w.cleanup();
    }
  }, 30_000);
});
