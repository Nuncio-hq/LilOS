import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation } from "@lilos/contracts/app";
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

/* #784: one seeded repo, copied per test — see `isolateFixtureGit`. */
isolateFixtureGit();

/**
 * D-#848 end-to-end (engine-fake): `task_create` from a thread pinned to
 * a git repo resolves to a fresh worktree on the #156 path — the child's
 * engine session starts inside it, the parent's uncommitted edits stay
 * behind, and the tool result tells the caller so. Shared mode and the
 * refusal paths run through the same `createAppOps` the tool reaches.
 */

const git = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

let template = "";

beforeAll(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilos-task-seed-")));
  template = seedFixtureRepo(root, "main", ["feat/x"]);
});

afterAll(() => {
  if (template) rmSync(template, { recursive: true, force: true });
});

function seedRepo() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "lilos-task-")));
  homes.push(parent);
  const dir = join(parent, "repo");
  copyFixtureRepo(template, dir);
  return dir;
}

const headOf = (dir: string) => git(dir, ["rev-parse", "HEAD"]).trim();

/** Employees, a parent thread pinned to `cwd`, its root turn finished. */
async function parentIn(
  w: Awaited<ReturnType<typeof setupWorld>>,
  cwd: string,
  home: string,
) {
  const { employee: caller, channel: callerChannel } = await openDmConversation(
    w.user,
  );
  const { employee: worker } = await w.user.request<{
    employee: { id: string; name: string };
  }>("employees.create", { name: "Bea", role: "eng" });
  const { conversation: parent } = await w.user.request<{
    conversation: Conversation;
  }>("conversations.open", {
    channelId: callerChannel.id,
    text: "Summarize the week",
    cwd,
  });
  await waitFor(async () => {
    const { conversations } = await w.user.request<{
      conversations: { id: string; finishedSeq: number }[];
    }>("conversations.list", {});
    return conversations.find((c) => c.id === parent.id)?.finishedSeq
      ? true
      : undefined;
  }, "parent root turn");
  const ops = createAppOps({
    relay: w.harnessRelay,
    runningTurnId: () => undefined,
    log: w.log,
    home,
  })("s1", {
    employeeId: caller.id,
    channelId: callerChannel.id,
    conversationId: parent.id,
  });
  if (!ops) throw new Error("no appOps");
  return { caller, callerChannel, worker, parent, ops };
}

describe("task_create worktree isolation (D-#848)", () => {
  it("default: forks the parent's HEAD, starts the child in it, tells the parent", async () => {
    const repo = seedRepo();
    const homeDir = mkhome();
    const w = await setupWorld({ homeDir });
    try {
      const { parent, ops } = await parentIn(w, repo, homeDir);
      /* Uncommitted state on the parent's checkout: a modified tracked
         file and an untracked one. Neither may reach the child. */
      writeFileSync(join(repo, "README.md"), "# dirty\n");
      writeFileSync(join(repo, "untracked.txt"), "not committed\n");
      const base = headOf(repo);

      const r = await ops.taskCreate({
        agent: "Bea",
        prompt: "Check the flaky test",
        title: "Fix the flaky test",
      });

      const wtDir = join(repo, ".lilos", "wt", "fix-flaky");
      expect(r.task.worktree).toEqual({ path: wtDir, branch: "ws/fix-flaky" });
      expect(r.note).toContain(wtDir);
      expect(r.note).toContain("uncommitted");
      expect(r.note).toMatch(/[Mm]erging back/);

      /* The child binds → ensureWorktree (#156) → session.start inside
         the new worktree. */
      await waitFor(async () => {
        const call = w.engineCalls.find(
          (c) =>
            c.method === "session.start" &&
            (c.params as { cwd?: string }).cwd === wtDir,
        );
        return call ? true : undefined;
      }, "child session.start in the worktree");

      // A real registered worktree on its own branch at the parent's HEAD.
      expect(git(repo, ["worktree", "list", "--porcelain"])).toContain(
        `worktree ${wtDir}`,
      );
      expect(git(wtDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
        "ws/fix-flaky\n",
      );
      expect(headOf(wtDir)).toBe(base);
      // No uncommitted edits rode along.
      expect(existsSync(join(wtDir, "untracked.txt"))).toBe(false);
      expect(readFileSync(join(wtDir, "README.md"), "utf8")).toBe("# seed\n");
      // The parent's checkout is untouched (`.lilos` hides the worktree).
      expect(git(repo, ["status", "--porcelain"])).toBe(
        " M README.md\n?? untracked.txt\n",
      );

      // Filed under the parent's project, on the child's own channel.
      const { conversations } = await w.user.request<{
        conversations: Conversation[];
      }>("conversations.list", {});
      const child = conversations.find((c) => c.parentId === parent.id);
      expect(child?.projectId).toBe(parent.projectId);
      expect(child?.cwd).toBe(wtDir);
      expect(child?.workspace?.mode).toBe("new");
    } finally {
      await w.cleanup();
    }
  }, 30_000);

  it('"shared" runs the child in the parent\'s folder — no worktree, no note', async () => {
    const repo = seedRepo();
    const homeDir = mkhome();
    const w = await setupWorld({ homeDir });
    try {
      const { ops } = await parentIn(w, repo, homeDir);
      const r = await ops.taskCreate({
        agent: "Bea",
        prompt: "Look over the diff",
        isolation: "shared",
      });
      expect(r.task.worktree).toBeUndefined();
      expect(r.note).toBeUndefined();

      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: {
            id: string;
            parentId?: string;
            engineRef: string | null;
          }[];
        }>("conversations.list", {});
        return conversations.find((c) => c.parentId)?.engineRef
          ? true
          : undefined;
      }, "child session");
      const starts = w.engineCalls
        .filter((c) => c.method === "session.start")
        .map((c) => (c.params as { cwd: string }).cwd);
      expect(starts.at(-1)).toBe(repo);
      expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(
        ".lilos/wt",
      );
    } finally {
      await w.cleanup();
    }
  }, 30_000);

  it("a parent checkout with no commit refuses — nothing is created", async () => {
    const homeDir = mkhome();
    const dir = join(homeDir, "unborn");
    git(homeDir, ["init", "-qb", "main", dir]);
    const w = await setupWorld({ homeDir });
    try {
      const { parent, ops } = await parentIn(w, dir, homeDir);
      await expect(
        ops.taskCreate({ agent: "Bea", prompt: "Check it" }),
      ).rejects.toThrow(/no commit/);
      const { conversations } = await w.user.request<{
        conversations: { id: string; parentId?: string }[];
      }>("conversations.list", {});
      expect(conversations.filter((c) => c.parentId === parent.id)).toEqual([]);
      expect(git(dir, ["worktree", "list", "--porcelain"])).not.toContain(
        ".lilos/wt",
      );
    } finally {
      await w.cleanup();
    }
  }, 30_000);

  it("a non-repo folder shares the parent's folder by default", async () => {
    const homeDir = mkhome();
    const dir = join(homeDir, "plain");
    mkdirSync(dir);
    const w = await setupWorld({ homeDir });
    try {
      const { ops } = await parentIn(w, dir, homeDir);
      const r = await ops.taskCreate({
        agent: "Bea",
        prompt: "Look over the files",
      });
      expect(r.task.worktree).toBeUndefined();
      expect(r.note).toBeUndefined();
      const { conversations } = await w.user.request<{
        conversations: Conversation[];
      }>("conversations.list", {});
      const child = conversations.find((c) => c.parentId);
      expect(child?.cwd).toBe(dir);
      expect(child?.workspace).toBeUndefined();
    } finally {
      await w.cleanup();
    }
  }, 30_000);

  it("a requestId retry replays the stored worktree — no second fork", async () => {
    const repo = seedRepo();
    const homeDir = mkhome();
    const w = await setupWorld({ homeDir });
    try {
      const { ops } = await parentIn(w, repo, homeDir);
      const first = await ops.taskCreate({
        agent: "Bea",
        prompt: "Check the flaky test",
        title: "Fix the flaky test",
        requestId: "r-1",
      });
      const again = await ops.taskCreate({
        agent: "Bea",
        prompt: "Check the flaky test",
        title: "Fix the flaky test",
        requestId: "r-1",
      });
      expect(again.task.id).toBe(first.task.id);
      expect(again.task.worktree).toEqual(first.task.worktree);
      /* The note re-answers the SAME worktree — the intent recomputed a
         deduped slug but the stored row is the truth. */
      expect(again.note).toContain(first.task.worktree?.path ?? "");
      await waitFor(async () => {
        const { conversations } = await w.user.request<{
          conversations: { parentId?: string }[];
        }>("conversations.list", {});
        const kids = conversations.filter((c) => c.parentId);
        return kids.length === 1 ? kids : undefined;
      }, "exactly one child");
      /* The row lands before the bind finishes — wait for the worktree
         session before counting registrations. */
      const wtDir = first.task.worktree?.path ?? "";
      await waitFor(async () => {
        const call = w.engineCalls.find(
          (c) =>
            c.method === "session.start" &&
            (c.params as { cwd?: string }).cwd === wtDir,
        );
        return call ? true : undefined;
      }, "child session.start in the worktree");
      expect(
        git(repo, ["worktree", "list", "--porcelain"]).split("worktree ")
          .length - 1,
      ).toBe(2); // main checkout + the one task worktree
    } finally {
      await w.cleanup();
    }
  }, 30_000);
});
