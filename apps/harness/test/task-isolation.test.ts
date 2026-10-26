import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTaskIsolation } from "../src/harness/task-isolation";
import {
  copyFixtureRepo,
  homes,
  isolateFixtureGit,
  seedFixtureRepo,
} from "./helpers";

/* #784: one seeded repo, copied per test — see `isolateFixtureGit`. */
isolateFixtureGit();

/**
 * D-#848: `task_create`'s isolation pick resolves in the harness — the
 * default forks the caller's checkout into `.lilos/wt/<slug>` on
 * `ws/<slug>` from its committed HEAD; "shared" and non-repo folders
 * keep the inherit-`cwd` behavior; a checkout with no commit to fork
 * refuses either way.
 */

const git = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

/* Fixture repos live under tmpdir — never under HOME — so every `home`
   here is inert; the real harness home is what `~` would mean. */
const HOME = homedir();

let template = "";

beforeAll(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lilos-iso-seed-")));
  template = seedFixtureRepo(root, "main", ["feat/x"]);
});

afterAll(() => {
  if (template) rmSync(template, { recursive: true, force: true });
});

function seedRepo() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "lilos-iso-")));
  homes.push(parent);
  const dir = join(parent, "repo");
  copyFixtureRepo(template, dir);
  return dir;
}

const headOf = (dir: string) => git(dir, ["rev-parse", "HEAD"]).trim();

describe("resolveTaskIsolation (D-#848)", () => {
  it("defaults to a worktree fork of the caller's checkout HEAD", async () => {
    const repo = seedRepo();
    const r = await resolveTaskIsolation({
      cwd: repo,
      seed: "Fix the login bug",
      home: HOME,
    });
    expect(r.cwd).toBe(join(repo, ".lilos", "wt", "fix-login"));
    expect(r.workspace).toEqual({
      mode: "new",
      repoPath: repo,
      branch: "ws/fix-login",
      base: headOf(repo),
    });
  });

  it("a linked-worktree caller forks its own HEAD, under the main checkout", async () => {
    const repo = seedRepo();
    const wtDir = join(repo, ".lilos", "wt", "feat");
    git(repo, ["worktree", "add", "-b", "ws/feat", wtDir, "feat/x"]);
    // One commit on the worktree's branch — the child's base is THAT
    // sha, not main's (the parent local commit, T3 semantics).
    git(wtDir, ["commit", "--allow-empty", "-qm", "wip"]);
    const r = await resolveTaskIsolation({
      cwd: wtDir,
      workspace: { mode: "existing", repoPath: repo, branch: "ws/feat" },
      seed: "continue the fix",
      home: HOME,
    });
    expect(r.workspace?.mode).toBe("new");
    if (r.workspace?.mode !== "new") throw new Error("unreachable");
    expect(r.workspace.repoPath).toBe(repo);
    expect(r.workspace.base).toBe(headOf(wtDir));
    expect(r.workspace.base).not.toBe(headOf(repo));
    expect(r.cwd).toBe(join(repo, ".lilos", "wt", "continue-fix"));
    expect(r.workspace.branch).toBe("ws/continue-fix");
  });

  it("dedupes the slug against branches, worktrees, and stale dirs", async () => {
    const repo = seedRepo();
    git(repo, [
      "worktree",
      "add",
      "-b",
      "ws/fix-bug",
      `${repo}/.lilos/wt/fix-bug`,
      "main",
    ]);
    mkdirSync(join(repo, ".lilos", "wt", "fix-bug-1"));
    const r = await resolveTaskIsolation({
      cwd: repo,
      seed: "fix bug",
      home: HOME,
    });
    expect(r.cwd).toBe(join(repo, ".lilos", "wt", "fix-bug-2"));
    expect(r.workspace?.mode === "new" && r.workspace.branch).toBe(
      "ws/fix-bug-2",
    );
  });

  it('"shared" never probes git — inherits the caller\'s folder', async () => {
    const r = await resolveTaskIsolation({
      cwd: "/does/not/exist",
      isolation: "shared",
      seed: "anything",
      home: HOME,
    });
    expect(r).toEqual({});
  });

  it("a non-repo folder shares by default but refuses an explicit worktree", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "lilos-plain-")));
    homes.push(dir);
    expect(
      await resolveTaskIsolation({ cwd: dir, seed: "x", home: HOME }),
    ).toEqual({});
    await expect(
      resolveTaskIsolation({
        cwd: dir,
        isolation: "worktree",
        seed: "x",
        home: HOME,
      }),
    ).rejects.toThrow(/git repo.*shared/);
  });

  it("a folder-less caller shares by default; explicit worktree refuses", async () => {
    expect(await resolveTaskIsolation({ seed: "x", home: HOME })).toEqual({});
    await expect(
      resolveTaskIsolation({ isolation: "worktree", seed: "x", home: HOME }),
    ).rejects.toThrow(/git folder.*shared/);
  });

  it("an unborn checkout refuses both spellings — no commit to fork", async () => {
    const dir = join(
      realpathSync(mkdtempSync(join(tmpdir(), "lilos-unborn-"))),
      "repo",
    );
    homes.push(dir);
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-qb", "main"]);
    for (const isolation of [undefined, "worktree" as const]) {
      await expect(
        resolveTaskIsolation({ cwd: dir, isolation, seed: "x", home: HOME }),
      ).rejects.toThrow(/no commit.*shared/);
    }
  });
});
