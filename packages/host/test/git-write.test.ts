import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_ERRORS } from "@lilos/contracts/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callHost } from "../src/index";

/**
 * Issue #107 AC tests for the git-write host API. The fixture is a real temp
 * repo cloned-shaped against a *bare* `origin` (default branch `trunk`) plus
 * a feature branch with dirty files — `git commit`/`push`/`checkout -b` run
 * for real through execFile argv (never a shell string); nothing is stubbed
 * but the network never leaves the local bare remote. Auth failure is made
 * deterministic with GIT_SSH_COMMAND=false.
 */
let scanRoot = "";
let repo = "";
let bare = "";

const inRepo = (args: string[], cwd = repo) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const makeRepo = (name: string, remote = true) => {
  const dir = join(scanRoot, name);
  mkdirSync(dir);
  inRepo(["init", "-b", "trunk"], dir);
  inRepo(["config", "user.email", "t@t"], dir);
  inRepo(["config", "user.name", "t"], dir);
  writeFileSync(join(dir, "a.txt"), "one\n");
  inRepo(["add", "."], dir);
  inRepo(["commit", "-m", "init"], dir);
  if (remote) {
    inRepo(["remote", "add", "origin", bare], dir);
    inRepo(["push", "-u", "origin", "trunk"], dir);
    // Set origin/HEAD like a clone would — `git.branches`' `default` reads it.
    inRepo(["remote", "set-head", "origin", "-a"], dir);
  }
  return dir;
};

beforeAll(() => {
  scanRoot = mkdtempSync(join(tmpdir(), "lilos-gitwrite-"));
  bare = join(scanRoot, "remote.git");
  mkdirSync(bare);
  inRepo(["init", "--bare", "-b", "trunk"], bare);
  repo = makeRepo("repo");
  inRepo(["checkout", "-b", "feat/widgets"]);
  // dirty: one modified, one untracked — commit tests stage these.
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "new.txt"), "fresh\nfile\n");
});
afterAll(() => rmSync(scanRoot, { recursive: true, force: true }));

type CommitResult = {
  root: string;
  branch: string | null;
  sha: string;
  subject: string;
};
type PushResult = {
  root: string;
  branch: string | null;
  upstream: string | null;
};
type LogResult = {
  root: string;
  branch: string | null;
  base: string | null;
  commits: {
    sha: string;
    subject: string;
    files: { path: string; status: string; add: number; del: number }[];
  }[];
};

describe("git write methods (issue #107)", () => {
  it("AC-1 git.commit stages only the listed files and commits with the message", async () => {
    // A third dirty file NOT in the list must stay uncommitted.
    writeFileSync(join(repo, "extra.txt"), "mine\n");
    const r = (await callHost("git.commit", {
      path: repo,
      files: ["a.txt", "new.txt"],
      message: "add the widget bits",
    })) as CommitResult;
    expect(r.branch).toBe("feat/widgets");
    expect(r.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(r.subject).toBe("add the widget bits");
    expect(inRepo(["log", "-1", "--format=%s"])).toBe("add the widget bits\n");
    const st = (await callHost("git.status", { path: repo })) as {
      files: { path: string }[];
    };
    expect(st.files.map((f) => f.path)).toEqual(["extra.txt"]);
  });

  it("AC-1 git.commit never sweeps in files someone else already staged", async () => {
    // The blocker a bare `git commit -m` had: the index may hold entries the
    // agent's shell or the user's IDE staged — `--only` keeps them out.
    writeFileSync(join(repo, "b.txt"), "bee\n");
    inRepo(["add", "extra.txt"]); // staged out-of-band, NOT in the list
    const r = (await callHost("git.commit", {
      path: repo,
      files: ["b.txt"],
      message: "only b",
    })) as CommitResult;
    expect(r.subject).toBe("only b");
    expect(inRepo(["show", "--name-status", "--format=", "HEAD"])).toBe(
      "A\tb.txt\n",
    );
    // extra.txt is still staged, still uncommitted.
    expect(inRepo(["status", "--porcelain"])).toBe("A  extra.txt\n");
  });

  it("AC-1 git.commit refuses a '-'-leading path (argv never a flag)", async () => {
    await expect(
      callHost("git.commit", {
        path: repo,
        files: ["-am", "new.txt"],
        message: "x",
      }),
    ).rejects.toMatchObject({ code: HOST_ERRORS.INVALID_PARAMS });
  });

  it("AC-1 git.commit on a clean selection answers reason 'nothing'", async () => {
    // `keep.md`-style: path exists but has no change → add is a no-op and
    // `git commit` fails with the plain 'nothing' reason.
    writeFileSync(join(repo, "keep.md"), "# keep\n");
    inRepo(["add", "keep.md"]);
    inRepo(["commit", "-m", "add keep"]);
    await expect(
      callHost("git.commit", {
        path: repo,
        files: ["keep.md"],
        message: "again",
      }),
    ).rejects.toMatchObject({
      code: HOST_ERRORS.GIT_FAILED,
      data: { reason: "nothing" },
    });
  });

  it("AC-1 git.log lists the branch's commits vs its birth sha", async () => {
    const r = (await callHost("git.log", { path: repo })) as LogResult;
    expect(r.branch).toBe("feat/widgets");
    // feat/widgets was born at trunk's tip — exactly its own commits,
    // newest first (init on trunk is not in the range).
    expect(r.commits.map((c) => c.subject)).toEqual([
      "add keep",
      "only b",
      "add the widget bits",
    ]);
    const c = r.commits[2];
    expect(c.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(c.files.map((f) => f.path).sort()).toEqual(["a.txt", "new.txt"]);
    expect(c.files.find((f) => f.path === "a.txt")?.status).toBe("modified");
    expect(c.files.find((f) => f.path === "new.txt")?.status).toBe("added");
    expect(c.files.find((f) => f.path === "a.txt")?.add).toBe(1);
  });

  it("AC-4 git.createBranch validates, creates and checks out the branch", async () => {
    const r = (await callHost("git.createBranch", {
      path: repo,
      name: "feat/login-form",
    })) as { branch: string };
    expect(r.branch).toBe("feat/login-form");
    expect(inRepo(["symbolic-ref", "--short", "HEAD"])).toBe(
      "feat/login-form\n",
    );
    inRepo(["checkout", "feat/widgets"]);
  });

  it("AC-4 git.createBranch refuses an existing name with reason 'exists'", async () => {
    await expect(
      callHost("git.createBranch", { path: repo, name: "feat/widgets" }),
    ).rejects.toMatchObject({
      code: HOST_ERRORS.GIT_FAILED,
      data: { reason: "exists" },
    });
  });

  it("AC-4 git.createBranch rejects an invalid name as INVALID_PARAMS", async () => {
    await expect(
      callHost("git.createBranch", { path: repo, name: "..bad" }),
    ).rejects.toMatchObject({ code: HOST_ERRORS.INVALID_PARAMS });
  });

  it("AC-3 git.push sets upstream on the first push — never force", async () => {
    const r = (await callHost("git.push", { path: repo })) as PushResult;
    expect(r.branch).toBe("feat/widgets");
    expect(r.upstream).toBe("origin/feat/widgets");
    // The bare remote really has the branch.
    const refs = inRepo(["for-each-ref", "--format=%(refname)"], bare);
    expect(refs).toContain("refs/heads/feat/widgets");
    // Second push (already-tracking) takes the plain `git push` path.
    const again = (await callHost("git.push", { path: repo })) as PushResult;
    expect(again.upstream).toBe("origin/feat/widgets");
  });

  it("AC-3 git.push rejected (non-fast-forward) reads plainly", async () => {
    // Another clone advances origin/feat/widgets past our checkout.
    const other = join(scanRoot, "other");
    inRepo(["clone", bare, other], scanRoot);
    inRepo(["config", "user.email", "t@t"], other);
    inRepo(["config", "user.name", "t"], other);
    inRepo(["checkout", "feat/widgets"], other);
    writeFileSync(join(other, "a.txt"), "one\ntwo\nthree\n");
    inRepo(["commit", "-am", "someone else"], other);
    inRepo(["push", "origin", "feat/widgets"], other);
    // Our checkout now trails it — never force, report 'rejected'.
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nOURS\n");
    inRepo(["commit", "-am", "ours"], repo);
    await expect(callHost("git.push", { path: repo })).rejects.toMatchObject({
      code: HOST_ERRORS.GIT_FAILED,
      data: { reason: "rejected" },
    });
  });

  it("AC-3 git.push with no remote configured reads as 'no-remote'", async () => {
    const lonely = makeRepo("lonely", false);
    await expect(callHost("git.push", { path: lonely })).rejects.toMatchObject({
      code: HOST_ERRORS.GIT_FAILED,
      data: { reason: "no-remote" },
    });
  });

  it("AC-3 git.push auth failure reads as 'auth' (never raw stderr)", async () => {
    const locked = makeRepo("locked", false);
    inRepo(["remote", "add", "origin", "git@fake.test:x/y.git"], locked);
    const saved = {
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
      GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT,
    };
    process.env.GIT_SSH_COMMAND = "false";
    process.env.GIT_TERMINAL_PROMPT = "0";
    try {
      await expect(
        callHost("git.push", { path: locked }),
      ).rejects.toMatchObject({
        code: HOST_ERRORS.GIT_FAILED,
        data: { reason: "auth" },
      });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  /* Issue #393 AC-5: `git pull --ff-only` — the rejected push's named fix. */
  it("AC-5 git.pull on a diverged history answers reason 'diverged' — never merges, never rebases", async () => {
    // The AC-3 rejection left feat/widgets diverged (local "ours" vs remote
    // "someone else"). A fast-forward is impossible; HEAD must not move.
    const headBefore = inRepo(["rev-parse", "HEAD"], repo);
    await expect(callHost("git.pull", { path: repo })).rejects.toMatchObject({
      code: HOST_ERRORS.GIT_FAILED,
      data: { reason: "diverged" },
    });
    expect(inRepo(["rev-parse", "HEAD"], repo)).toBe(headBefore);
    expect(inRepo(["log", "--format=%s", "-3"], repo)).not.toMatch(/merge/i);
  });

  it("AC-5 git.pull fast-forwards a checkout that is only behind", async () => {
    // User resolved the divergence in a terminal (the copy's own advice),
    // then a newer remote commit lands — behind but fast-forwardable.
    inRepo(["reset", "--hard", "origin/feat/widgets"], repo);
    const other2 = join(scanRoot, "other2");
    inRepo(["clone", bare, other2], scanRoot);
    inRepo(["config", "user.email", "t@t"], other2);
    inRepo(["config", "user.name", "t"], other2);
    inRepo(["checkout", "feat/widgets"], other2);
    writeFileSync(join(other2, "later.txt"), "later\n");
    inRepo(["add", "."], other2);
    inRepo(["commit", "-m", "later work"], other2);
    inRepo(["push", "origin", "feat/widgets"], other2);
    const r = (await callHost("git.pull", { path: repo })) as PushResult;
    expect(r.branch).toBe("feat/widgets");
    expect(r.upstream).toBe("origin/feat/widgets");
    expect(inRepo(["log", "-1", "--format=%s"], repo)).toBe("later work\n");
  });

  it("AC-5 git.pull with no remote configured answers plainly", async () => {
    const lonely2 = makeRepo("lonely2", false);
    await expect(callHost("git.pull", { path: lonely2 })).rejects.toMatchObject(
      {
        code: HOST_ERRORS.GIT_FAILED,
        data: { reason: "no-remote" },
      },
    );
  });

  it("AC-5 git.pull on a branch without upstream answers plainly", async () => {
    inRepo(["checkout", "-b", "no-upstream"], repo);
    await expect(callHost("git.pull", { path: repo })).rejects.toMatchObject({
      code: HOST_ERRORS.GIT_FAILED,
    });
    inRepo(["checkout", "feat/widgets"], repo);
  });

  it("AC-4 git.branches reports the remote default branch", async () => {
    const r = (await callHost("git.branches", { path: repo })) as {
      current: string | null;
      default: string | null;
      remote: string | null;
    };
    expect(r.current).toBe("feat/widgets");
    expect(r.default).toBe("trunk");
    expect(r.remote).toContain("remote.git");
  });

  it("AC-5 git.log on the default branch falls back to its upstream", async () => {
    // trunk tracks origin/trunk and is one commit behind? No — ahead-by-one
    // after an unpushed local commit: the log shows exactly that commit.
    inRepo(["checkout", "trunk"]);
    writeFileSync(join(repo, "main.md"), "main\n");
    inRepo(["add", "main.md"]);
    inRepo(["commit", "-m", "on trunk"]);
    const r = (await callHost("git.log", { path: repo })) as LogResult;
    expect(r.branch).toBe("trunk");
    expect(r.base).toBe("origin/trunk");
    expect(r.commits.map((c) => c.subject)).toEqual(["on trunk"]);
    inRepo(["checkout", "feat/widgets"]);
  });

  it("AC-6 git.commit on a non-repo answers NOT_A_REPO", async () => {
    const plain = mkdtempSync(join(tmpdir(), "lilos-plain-"));
    try {
      await expect(
        callHost("git.commit", { path: plain, files: ["a"], message: "x" }),
      ).rejects.toMatchObject({ code: HOST_ERRORS.NOT_A_REPO });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
