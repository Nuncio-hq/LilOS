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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  gitWorktrees,
  worktreeAdd,
  worktreeEnsure,
  worktreeRemove,
} from "../src/index";
import { fixtureGit, pinFixtureRepo } from "./fixture-git";

/**
 * Issue #881: the settled-thread worktree cleanup on real temp repos — a
 * bare `origin` plus a working clone shaped like a real project (default
 * branch `main`, `origin/HEAD` set). Every keep/remove decision and the
 * restore run the product helpers against real git; nothing is stubbed.
 */
let root = "";
let repo = "";
let bare = "";

const git = (args: string[], cwd = repo) => fixtureGit(cwd, args);
const wtDir = (slug: string) => join(repo, ".lilos", "wt", slug);
const branchList = (name: string) =>
  git(["branch", "--list", name, "--format=%(refname:short)"]).trim();

const makeWorktree = async (slug: string) => {
  const dir = wtDir(slug);
  await worktreeAdd({ path: repo, dir, branch: `ws/${slug}`, base: "main" });
  return dir;
};

/** Commit a file inside the worktree's branch. */
const commitIn = (dir: string, name: string, text: string) => {
  writeFileSync(join(dir, name), text);
  git(["add", "."], dir);
  git(["commit", "-qm", `add ${name}`], dir);
};

beforeAll(() => {
  /* realpath: git registers canonical paths — the assertions compare. */
  root = realpathSync(mkdtempSync(join(tmpdir(), "lilos-wtclean-")));
  bare = join(root, "remote.git");
  mkdirSync(bare);
  fixtureGit(bare, ["init", "--bare", "-b", "main"]);
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-b", "main"]);
  pinFixtureRepo(repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
  git(["remote", "add", "origin", bare]);
  git(["push", "-qu", "origin", "main"]);
  git(["remote", "set-head", "origin", "-a"]);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("worktreeRemove (D-#881)", () => {
  it("clean + merged: removes the copy, deletes the branch, marks its tip", async () => {
    const dir = await makeWorktree("merged");
    commitIn(dir, "w.txt", "work\n");
    /* Land the branch on the default line: merge in the main checkout,
       push so origin/main also holds the tip. */
    git(["checkout", "-q", "main"]);
    git(["merge", "-q", "--no-edit", "ws/merged"]);
    git(["push", "-q", "origin", "main"]);
    const tip = git(["rev-parse", "ws/merged"]).trim();

    const r = await worktreeRemove({ path: repo, dir, branch: "ws/merged" });
    expect(r).toEqual({ removed: true, branchDeleted: true });
    expect(existsSync(dir)).toBe(false);
    expect(branchList("ws/merged")).toBe("");
    /* The pruned marker keeps the tip — the restore path reads "gone"
       from it instead of inventing a fresh branch. */
    expect(git(["rev-parse", "refs/lilos/pruned/ws/merged"]).trim()).toBe(tip);
    const { worktrees } = await gitWorktrees({ path: repo });
    expect(worktrees.map((w) => w.path)).not.toContain(dir);
  });

  it("clean + pushed but unmerged: removes the copy, keeps the branch", async () => {
    const dir = await makeWorktree("pushed");
    commitIn(dir, "p.txt", "p\n");
    git(["push", "-qu", "origin", "ws/pushed"], dir);

    const r = await worktreeRemove({ path: repo, dir, branch: "ws/pushed" });
    expect(r).toEqual({ removed: true, branchDeleted: false });
    expect(existsSync(dir)).toBe(false);
    expect(branchList("ws/pushed")).toBe("ws/pushed");
  });

  it("a branch that never got commits counts as merged", async () => {
    const dir = await makeWorktree("virgin");
    const r = await worktreeRemove({ path: repo, dir, branch: "ws/virgin" });
    expect(r).toEqual({ removed: true, branchDeleted: true });
    expect(existsSync(dir)).toBe(false);
  });

  it("dirty worktree is kept — untracked files count", async () => {
    const dir = await makeWorktree("dirty");
    writeFileSync(join(dir, "unsaved.txt"), "mine\n");
    const r = await worktreeRemove({ path: repo, dir, branch: "ws/dirty" });
    expect(r).toMatchObject({
      removed: false,
      branchDeleted: false,
      kept: "dirty",
      count: 1,
    });
    expect(existsSync(join(dir, "unsaved.txt"))).toBe(true);
    expect(branchList("ws/dirty")).toBe("ws/dirty");
  });

  it("unpushed commits keep the worktree", async () => {
    const dir = await makeWorktree("unpushed");
    commitIn(dir, "u.txt", "u\n");
    const r = await worktreeRemove({
      path: repo,
      dir,
      branch: "ws/unpushed",
    });
    expect(r).toMatchObject({
      removed: false,
      branchDeleted: false,
      kept: "unpushed",
      count: 1,
    });
    expect(existsSync(join(dir, "u.txt"))).toBe(true);
    expect(branchList("ws/unpushed")).toBe("ws/unpushed");
  });

  it("a folder git never made at the path is never ours to remove", async () => {
    const dir = wtDir("foreign");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keep.txt"), "x\n");
    const r = await worktreeRemove({ path: repo, dir, branch: "ws/foreign" });
    expect(r).toMatchObject({
      removed: false,
      branchDeleted: false,
      kept: "foreign",
    });
    expect(existsSync(join(dir, "keep.txt"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a missing dir still prunes and deletes a merged branch", async () => {
    const dir = await makeWorktree("stale");
    /* Someone removed the folder out-of-band — registration is stale;
       cleanup still settles the branch side. */
    rmSync(dir, { recursive: true, force: true });
    const r = await worktreeRemove({ path: repo, dir, branch: "ws/stale" });
    expect(r).toEqual({ removed: true, branchDeleted: true });
    const { worktrees } = await gitWorktrees({ path: repo });
    expect(worktrees.map((w) => w.path)).not.toContain(dir);
  });
});

describe("worktreeEnsure (D-#881)", () => {
  it("creates at base when nothing ever existed (mode new)", async () => {
    const dir = wtDir("fresh");
    const e = await worktreeEnsure({
      path: repo,
      dir,
      branch: "ws/fresh",
      base: "main",
    });
    expect(e.how).toBe("created");
    expect(git(["symbolic-ref", "--short", "HEAD"], dir).trim()).toBe(
      "ws/fresh",
    );
    /* Already there → present, no second add. */
    const again = await worktreeEnsure({
      path: repo,
      dir,
      branch: "ws/fresh",
      base: "main",
    });
    expect(again.how).toBe("present");
  });

  it("attaches the surviving branch at the same path (un-settle restore)", async () => {
    const dir = await makeWorktree("reattach");
    commitIn(dir, "r.txt", "r\n");
    git(["push", "-qu", "origin", "ws/reattach"], dir);
    await worktreeRemove({ path: repo, dir, branch: "ws/reattach" });
    expect(existsSync(dir)).toBe(false);

    const e = await worktreeEnsure({ path: repo, dir, branch: "ws/reattach" });
    expect(e.how).toBe("attached");
    expect(existsSync(join(dir, "r.txt"))).toBe(true);
    expect(git(["symbolic-ref", "--short", "HEAD"], dir).trim()).toBe(
      "ws/reattach",
    );
  });

  it("rebuilds a tracking copy from the remote when the local branch is gone", async () => {
    const dir = await makeWorktree("remoteonly");
    commitIn(dir, "x.txt", "x\n");
    git(["push", "-qu", "origin", "ws/remoteonly"], dir);
    await worktreeRemove({ path: repo, dir, branch: "ws/remoteonly" });
    /* Oscar pruned the local branch by hand — origin still carries it. */
    git(["branch", "-D", "ws/remoteonly"]);

    const e = await worktreeEnsure({
      path: repo,
      dir,
      branch: "ws/remoteonly",
    });
    expect(e.how).toBe("remote");
    expect(existsSync(join(dir, "x.txt"))).toBe(true);
    expect(
      git(
        ["rev-parse", "--abbrev-ref", "ws/remoteonly@{upstream}"],
        dir,
      ).trim(),
    ).toBe("origin/ws/remoteonly");
  });

  it("refuses a branch the cleanup pruned post-merge — 'gone'", async () => {
    const dir = await makeWorktree("pruned");
    /* ws/pruned's tip is an ancestor of main → merged → branch deleted. */
    await worktreeRemove({ path: repo, dir, branch: "ws/pruned" });
    await expect(
      worktreeEnsure({ path: repo, dir, branch: "ws/pruned", base: "main" }),
    ).rejects.toMatchObject({
      data: { reason: "gone" },
    });
    expect(existsSync(dir)).toBe(false);
  });
});
