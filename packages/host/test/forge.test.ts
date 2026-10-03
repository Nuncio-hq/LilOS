import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_ERRORS } from "@lilos/contracts/host";
import { FakeEngine } from "@lilos/engine-fake";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { callHost } from "../src/index";

/**
 * Issue #37 AC tests for the forge host API. `gh` is faked by a stateful bun
 * script on PATH (test/fake-gh/gh) serving fixtures from $GH_FAKE_DIR — the
 * real code path (packages/host → execFile gh → JSON out) is exercised end to
 * end; only GitHub itself is stubbed. Real leg: scripts/live/37-forge.sh.
 */
const FAKE_GH_DIR = join(dirname(fileURLToPath(import.meta.url)), "fake-gh");
chmodSync(join(FAKE_GH_DIR, "gh"), 0o755);

const PR_VIEW = {
  number: 7,
  title: "Add the forge tab",
  body: "## Summary\n\nWire the PR tab to the host forge.",
  url: "https://github.com/acme/widgets/pull/7",
  state: "OPEN",
  author: { login: "builder" },
  baseRefName: "main",
  headRefName: "feat/forge",
  createdAt: "2026-09-20T10:00:00Z",
  mergedAt: null,
  mergedBy: null,
  mergeCommit: null,
  mergeable: "MERGEABLE",
  statusCheckRollup: [
    {
      __typename: "CheckRun",
      name: "typecheck",
      status: "COMPLETED",
      conclusion: "SUCCESS",
    },
    {
      __typename: "CheckRun",
      name: "lint",
      status: "IN_PROGRESS",
      conclusion: null,
    },
    { __typename: "StatusContext", context: "ci/policy", state: "FAILURE" },
    { __typename: "StatusContext", context: "netlify", state: "SUCCESS" },
  ],
  comments: [
    {
      author: { login: "reviewer" },
      body: "Looks good",
      createdAt: "2026-09-21T08:00:00Z",
    },
  ],
};

let repo = "";
let ghDir = "";
let logFile = "";
let env: { PATH?: string; GH_FAKE_DIR?: string; GH_FAKE_LOG?: string } = {};

const viewFile = () => join(ghDir, "view.json");
const writePr = (over: Record<string, unknown> = {}) =>
  writeFileSync(viewFile(), JSON.stringify({ ...PR_VIEW, ...over }));
const readLog = () =>
  existsSync(logFile) ? readFileSync(logFile, "utf8") : "";

beforeAll(() => {
  env = {
    PATH: process.env.PATH,
    GH_FAKE_DIR: process.env.GH_FAKE_DIR,
    GH_FAKE_LOG: process.env.GH_FAKE_LOG,
  };
  repo = mkdtempSync(join(tmpdir(), "lilos-forge-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  git(["checkout", "-b", "feat/forge"]);
  process.env.PATH = `${FAKE_GH_DIR}:${env.PATH}`;
});

beforeEach(() => {
  ghDir = mkdtempSync(join(tmpdir(), "lilos-gh-"));
  logFile = join(ghDir, "gh.log");
  process.env.GH_FAKE_DIR = ghDir;
  process.env.GH_FAKE_LOG = logFile;
  writePr();
});

afterEach(() => rmSync(ghDir, { recursive: true, force: true }));

afterAll(() => {
  for (const k of ["PATH", "GH_FAKE_DIR", "GH_FAKE_LOG"] as const) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  rmSync(repo, { recursive: true, force: true });
});

type PrResult = {
  root: string;
  branch: string | null;
  pr: {
    number: number;
    url: string;
    repo: string;
    title: string;
    body: string;
    state: "open" | "merged" | "closed";
    author: string;
    base: string;
    head: string;
    openedAt: string;
    mergeable: string;
    merged?: { by: string | null; at: string; sha: string };
    checks: { name: string; status: string }[];
    comments: { author: string; at: string; body: string }[];
  } | null;
};

describe("forge host api (fake gh)", () => {
  it("AC-1 forge.pr returns the branch's PR: title, body, checks, comments", async () => {
    const r = (await callHost("forge.pr", { path: repo })) as PrResult;
    expect(r.branch).toBe("feat/forge");
    const pr = r.pr;
    expect(pr).not.toBeNull();
    expect(pr?.number).toBe(7);
    expect(pr?.repo).toBe("acme/widgets");
    expect(pr?.title).toBe("Add the forge tab");
    expect(pr?.body).toContain("Wire the PR tab");
    expect(pr?.state).toBe("open");
    expect(pr?.base).toBe("main");
    expect(pr?.head).toBe("feat/forge");
    expect(pr?.mergeable).toBe("mergeable");
    const status = (n: string) => pr?.checks.find((c) => c.name === n)?.status;
    expect(status("typecheck")).toBe("passed");
    expect(status("lint")).toBe("pending");
    expect(status("ci/policy")).toBe("failed");
    expect(status("netlify")).toBe("passed");
    expect(pr?.comments[0]).toMatchObject({
      author: "reviewer",
      body: "Looks good",
      at: "2026-09-21T08:00:00Z",
    });
    // gh was actually invoked for the PR read.
    expect(readLog()).toContain("pr view");
  });

  it("AC-1 forge.pr returns pr:null when the branch has no PR", async () => {
    rmSync(viewFile());
    const r = (await callHost("forge.pr", { path: repo })) as PrResult;
    expect(r.pr).toBeNull();
    const plain = mkdtempSync(join(tmpdir(), "lilos-norepo-"));
    await expect(callHost("forge.pr", { path: plain })).rejects.toMatchObject({
      code: HOST_ERRORS.NOT_A_REPO,
    });
    rmSync(plain, { recursive: true, force: true });
  });

  it("AC-2 forge.comment posts the body via gh and it shows on the PR", async () => {
    const r = (await callHost("forge.comment", {
      path: repo,
      body: "ship it",
    })) as { url: string };
    expect(r.url).toBe(
      "https://github.com/acme/widgets/pull/7#issuecomment-9001",
    );
    expect(readLog()).toContain("pr comment");
    expect(readLog()).toContain("ship it");
    const after = (await callHost("forge.pr", { path: repo })) as PrResult;
    expect(after.pr?.comments.at(-1)).toMatchObject({
      author: "oscar",
      body: "ship it",
    });
  });

  it("AC-3 forge.merge runs gh pr merge --squash and reports the real result", async () => {
    const r = (await callHost("forge.merge", {
      path: repo,
      method: "squash",
    })) as { merged: boolean; pr: PrResult["pr"] };
    expect(r.merged).toBe(true);
    expect(r.pr?.state).toBe("merged");
    expect(r.pr?.merged?.sha).toBe("f".repeat(40));
    expect(r.pr?.merged?.by).toBe("oscar");
    expect(readLog()).toContain("pr merge");
    expect(readLog()).toContain("--squash");
    // The reported state came from re-reading the PR, not from trusting gh.
    const again = (await callHost("forge.pr", { path: repo })) as PrResult;
    expect(again.pr?.state).toBe("merged");
  });

  it("AC-3 forge.merge honours merge/rebase; a conflicting PR fails GH_FAILED", async () => {
    await callHost("forge.merge", { path: repo, method: "rebase" });
    expect(readLog()).toContain("--rebase");
    writePr({ mergeable: "CONFLICTING" });
    await expect(
      callHost("forge.merge", { path: repo, method: "merge" }),
    ).rejects.toMatchObject({ code: HOST_ERRORS.GH_FAILED });
  });

  it("AC-3 forge.comment/forge.merge on a branch with no PR fail with PR_NOT_FOUND", async () => {
    rmSync(viewFile());
    await expect(
      callHost("forge.comment", { path: repo, body: "hi" }),
    ).rejects.toMatchObject({ code: HOST_ERRORS.PR_NOT_FOUND });
    await expect(
      callHost("forge.merge", { path: repo, method: "squash" }),
    ).rejects.toMatchObject({ code: HOST_ERRORS.PR_NOT_FOUND });
  });

  it("AC-4 forge calls are host API, not engine — FakeEngine rejects them", async () => {
    const engine = new FakeEngine({ tick: 1 });
    await expect(engine.dispatch("forge.pr", { path: repo })).rejects.toThrow(
      /unknown method/,
    );
    const d = (await callHost("host.describe", {})) as { methods: string[] };
    for (const m of ["forge.pr", "forge.comment", "forge.merge"]) {
      expect(d.methods).toContain(m);
    }
  });

  /* #114 AC-5 — every gh failure carries a typed reason in error data, so the
     Workbench renders plain copy + one next step instead of raw stderr. */

  it("#114 AC-5 gh not installed maps to reason 'missing' — never a bare 'gh failed:'", async () => {
    // execFile ENOENT carries stderr:"" on both Node and Bun; the detail must
    // fall back to err.message (regression: packaged app showed "gh failed:"
    // blank because launchd's PATH hid gh AND stderr:"" shadowed the message).
    const bare = mkdtempSync(join(tmpdir(), "lilos-nogh-"));
    symlinkSync("/usr/bin/git", join(bare, "git"));
    const saved = process.env.PATH;
    // Only `git` on PATH: CI's Ubuntu image ships gh in /usr/bin, so adding
    // system dirs would find a real (signed-out) gh instead of none.
    process.env.PATH = bare;
    try {
      await expect(callHost("forge.pr", { path: repo })).rejects.toMatchObject({
        code: HOST_ERRORS.GH_FAILED,
        message: expect.stringMatching(/^gh failed: \S/),
        data: { reason: "missing" },
      });
    } finally {
      process.env.PATH = saved;
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("#114 AC-5 gh signed out (exit 4 + auth copy) maps to 'unauthenticated'", async () => {
    writeFileSync(join(ghDir, "fail"), "auth\n");
    await expect(callHost("forge.pr", { path: repo })).rejects.toMatchObject({
      code: HOST_ERRORS.GH_FAILED,
      data: { reason: "unauthenticated" },
    });
  });

  it("#114 AC-5 gh's auth copy maps to 'unauthenticated' even on exit 1", async () => {
    // Some gh versions answer auth-required text with a plain exit 1 — the
    // stderr signal is what matters, not the code.
    writeFileSync(join(ghDir, "fail"), "please run: gh auth login\n");
    await expect(callHost("forge.pr", { path: repo })).rejects.toMatchObject({
      code: HOST_ERRORS.GH_FAILED,
      data: { reason: "unauthenticated" },
    });
  });

  it("#114 AC-5 any other gh failure maps to 'other' with the raw detail", async () => {
    writeFileSync(join(ghDir, "fail"), "boom\n");
    await expect(callHost("forge.pr", { path: repo })).rejects.toMatchObject({
      code: HOST_ERRORS.GH_FAILED,
      data: { reason: "other", detail: "fake gh: boom" },
    });
  });

  it("forge.pr by explicit number resolves that PR", async () => {
    const r = (await callHost("forge.pr", {
      path: repo,
      number: 7,
    })) as PrResult;
    expect(r.pr?.number).toBe(7);
  });

  /* #159 forge.prs — every PR for the checkout's branch(es). */
  const listFile = (branch: string) =>
    join(ghDir, `list-${branch.replaceAll("/", "__")}.json`);
  const writeList = (branch: string, prs: unknown[]) =>
    writeFileSync(listFile(branch), JSON.stringify(prs));
  const ghPr = (n: number, over: Record<string, unknown> = {}) => ({
    number: n,
    title: `PR ${n}`,
    url: `https://github.com/acme/widgets/pull/${n}`,
    state: "OPEN",
    isDraft: false,
    headRefName: "feat/forge",
    baseRefName: "main",
    createdAt: "2026-09-24T08:00:00Z",
    statusCheckRollup: [],
    ...over,
  });
  type PrsResult = {
    root: string;
    branches: string[];
    prs: {
      number: number;
      state: "open" | "merged" | "closed";
      draft: boolean;
      checks: "none" | "pending" | "passing" | "failing";
    }[];
  };

  it("#159 AC-2 forge.prs lists several PRs — open first, then draft, merged, closed; newest first", async () => {
    writeList("feat/forge", [
      ghPr(91, { state: "MERGED", headRefName: "feat/forge" }),
      ghPr(93, {
        state: "CLOSED",
        statusCheckRollup: [
          { __typename: "StatusContext", context: "ci", state: "FAILURE" },
        ],
      }),
      ghPr(96, {
        isDraft: true,
        statusCheckRollup: [
          { __typename: "CheckRun", name: "ci", status: "IN_PROGRESS" },
        ],
      }),
      ghPr(95, {
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            name: "ci",
            status: "COMPLETED",
            conclusion: "SUCCESS",
          },
        ],
      }),
    ]);
    const r = (await callHost("forge.prs", { path: repo })) as PrsResult;
    expect(r.branches).toEqual(["feat/forge"]);
    expect(r.prs.map((p) => p.number)).toEqual([95, 96, 91, 93]);
    expect(r.prs.map((p) => p.state)).toEqual([
      "open",
      "open",
      "merged",
      "closed",
    ]);
    expect(r.prs[1]?.draft).toBe(true);
    expect(r.prs.map((p) => p.checks)).toEqual([
      "passing",
      "pending",
      "none",
      "failing",
    ]);
    expect(readLog()).toContain("pr list");
    expect(readLog()).toContain("--state all");
    expect(readLog()).toContain("--head feat/forge");
  });

  it("#159 AC-2 forge.prs probes every given branch and dedupes by number", async () => {
    writeList("feat/forge", [ghPr(95)]);
    writeList("ws/extra", [
      ghPr(97, { headRefName: "ws/extra" }),
      ghPr(95, { headRefName: "feat/forge" }), // same PR surfaced twice
    ]);
    const r = (await callHost("forge.prs", {
      path: repo,
      branches: ["ws/extra"],
    })) as PrsResult;
    expect(r.branches).toEqual(["feat/forge", "ws/extra"]);
    expect(r.prs.map((p) => p.number)).toEqual([97, 95]);
    expect(readLog()).toContain("--head ws/extra");
  });

  it("#159 AC-4 forge.prs on a branch with no PRs answers an empty list", async () => {
    // No list-*.json fixture: the fake gh prints [] — real gh does the same.
    const r = (await callHost("forge.prs", { path: repo })) as PrsResult;
    expect(r.branches).toEqual(["feat/forge"]);
    expect(r.prs).toEqual([]);
  });

  /* issue #107 AC-4 — forge.create drives `gh pr create` argv-style; the
     fake gh writes view.json so the next forge.pr re-read sees the new PR,
     exactly like the real gh it stands in for. */

  it("#107 AC-4 forge.create opens the PR via `gh pr create` and forge.pr then sees it", async () => {
    // No view.json yet → the branch starts PR-less, like a real create flow.
    rmSync(viewFile(), { force: true });
    const r = (await callHost("forge.create", {
      path: repo,
      title: "Ship the widgets",
      body: "## Summary\n\nAdds widgets.",
      base: "main",
    })) as { url: string; number?: number };
    expect(r).toEqual({
      url: "https://github.com/acme/widgets/pull/8",
      number: 8,
    });
    const log = readLog();
    expect(log).toContain("pr create");
    expect(log).toContain("--title Ship the widgets");
    expect(log).toContain("--base main");
    // The re-read now finds the created PR (fake gh persisted view.json).
    const pr = (await callHost("forge.pr", { path: repo })) as PrResult;
    expect(pr.pr?.number).toBe(8);
    expect(pr.pr?.head).toBe("feat/forge");
    expect(pr.pr?.base).toBe("main");
  });

  it("#107 AC-4 forge.create without a base lets gh pick the repo default", async () => {
    rmSync(viewFile(), { force: true });
    const r = (await callHost("forge.create", {
      path: repo,
      title: "no base",
      body: "",
    })) as { url: string };
    expect(r.url).toContain("/pull/");
    expect(readLog()).not.toContain("--base");
  });

  it("#107 AC-4 forge.create surfaces gh's typed reasons (signed-out → unauthenticated)", async () => {
    rmSync(viewFile(), { force: true });
    writeFileSync(join(ghDir, "fail"), "auth\n");
    await expect(
      callHost("forge.create", { path: repo, title: "x", body: "" }),
    ).rejects.toMatchObject({
      code: HOST_ERRORS.GH_FAILED,
      data: { reason: "unauthenticated" },
    });
  });

  it("#107 AC-4 forge.create on a non-repo throws NOT_A_REPO", async () => {
    const plain = mkdtempSync(join(tmpdir(), "lilos-norepo-"));
    try {
      await expect(
        callHost("forge.create", { path: plain, title: "x", body: "" }),
      ).rejects.toMatchObject({ code: HOST_ERRORS.NOT_A_REPO });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("#159 AC-4 forge.prs on a non-repo throws NOT_A_REPO; signed-out gh surfaces GH_FAILED", async () => {
    const plain = mkdtempSync(join(tmpdir(), "lilos-norepo-"));
    await expect(callHost("forge.prs", { path: plain })).rejects.toMatchObject({
      code: HOST_ERRORS.NOT_A_REPO,
    });
    rmSync(plain, { recursive: true, force: true });

    writeFileSync(join(ghDir, "fail"), "auth\n");
    await expect(callHost("forge.prs", { path: repo })).rejects.toMatchObject({
      code: HOST_ERRORS.GH_FAILED,
      data: { reason: "unauthenticated" },
    });
  });
});
