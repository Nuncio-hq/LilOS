import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_API } from "@lilos/contracts/host";
import { FakeEngine } from "@lilos/engine-fake";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callHost, handleHostFrame } from "../src/index";

/**
 * AC tests against a real temp git repo. The fixture: one commit, then a
 * modified file, an untracked file, and a nested subdir repo of its own.
 */
let dir = "";
const git = (args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8" });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lilos-host-"));
  git(["init", "-b", "main"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "keep.md"), "# keep\n");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  git(["checkout", "-b", "feature"]);
  // dirty: modified + untracked
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "new.txt"), "fresh\nfile\n");
  // a nested sibling dir that is NOT a repo + a subdir that is
  mkdirSync(join(dir, "plain"));
  mkdirSync(join(dir, "subrepo"));
  execFileSync("git", ["init", "-b", "main"], { cwd: join(dir, "subrepo") });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("host api (temp git repo)", () => {
  it("AC-1 fs.list marks git repos and lists real folders", async () => {
    const r = (await callHost("fs.list", { path: dir })) as {
      entries: { name: string; kind: string; repo?: { head: string | null } }[];
    };
    const names = r.entries.map((e) => e.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("plain");
    expect(names).toContain("subrepo");
    // `.git` is real and reported, but never carries a repo mark itself.
    expect(r.entries.find((e) => e.name === ".git")?.repo).toBeUndefined();
    const sub = r.entries.find((e) => e.name === "subrepo");
    expect(sub?.repo?.head).toBe("main");
    expect(r.entries.find((e) => e.name === "plain")?.repo).toBeUndefined();
  });

  it("AC-1 fs.complete autocompletes directory paths", async () => {
    const r = (await callHost("fs.complete", {
      word: `${dir}/sub`,
    })) as { suggestions: string[] };
    expect(r.suggestions).toEqual([`${dir}/subrepo`]);
    const none = (await callHost("fs.complete", {
      word: `${dir}/zz`,
    })) as { suggestions: string[] };
    expect(none.suggestions).toEqual([]);
  });

  it("AC-1 git.isRepo distinguishes repo vs plain dir", async () => {
    const yes = (await callHost("git.isRepo", { path: dir })) as {
      isRepo: boolean;
      root?: string;
    };
    expect(yes.isRepo).toBe(true);
    const no = (await callHost("git.isRepo", {
      path: join(dir, "plain"),
    })) as { isRepo: boolean };
    // `plain` is inside the outer repo → still a repo (its root is the outer)
    expect(no.isRepo).toBe(true);
    const outside = (await callHost("git.isRepo", {
      path: tmpdir(),
    })) as { isRepo: boolean };
    expect(outside.isRepo).toBe(false);
  });

  it("AC-2 fs.tree lists repo files relative, skipping .git internals", async () => {
    const r = (await callHost("fs.tree", { path: dir })) as {
      files: string[];
      truncated: boolean;
    };
    expect(r.files).toContain("a.txt");
    expect(r.files).toContain("new.txt");
    expect(r.files.some((f) => f.startsWith(".git/"))).toBe(false);
  });

  it("AC-2 fs.read returns text content", async () => {
    const r = (await callHost("fs.read", { path: `${dir}/a.txt` })) as {
      content: string;
      size: number;
      binary: boolean;
    };
    expect(r.content).toBe("one\ntwo\n");
    expect(r.binary).toBe(false);
    expect(r.size).toBe(8);
  });

  it("AC-3 git.diff reports modified + untracked files with patches", async () => {
    const r = (await callHost("git.diff", { path: dir })) as {
      files: {
        path: string;
        status: string;
        add: number;
        del: number;
        patch: string;
      }[];
    };
    const mod = r.files.find((f) => f.path === "a.txt");
    expect(mod?.status).toBe("modified");
    expect(mod?.add).toBe(1);
    expect(mod?.patch).toContain("+two");
    expect(mod?.patch).not.toContain("diff --git");
    expect(mod?.patch).not.toMatch(/^---/m);
    const untracked = r.files.find((f) => f.path === "new.txt");
    expect(untracked?.status).toBe("added");
    expect(untracked?.patch).toContain("+fresh");
  });

  it("AC-3 git.status lists the same change set", async () => {
    const r = (await callHost("git.status", { path: dir })) as {
      clean: boolean;
      branch: string | null;
      files: { path: string; status: string }[];
    };
    expect(r.branch).toBe("feature");
    expect(r.clean).toBe(false);
    expect(r.files.find((f) => f.path === "a.txt")?.status).toBe("modified");
    expect(r.files.find((f) => f.path === "new.txt")?.status).toBe("untracked");
  });

  it("AC-1 git.branches returns current + all locals + remote", async () => {
    const r = (await callHost("git.branches", { path: dir })) as {
      current: string | null;
      branches: string[];
      remote: string | null;
    };
    expect(r.current).toBe("feature");
    expect(r.branches).toEqual(["feature", "main"]);
    expect(r.remote).toBeNull();
  });

  it("AC-1 git.discoverRepos finds repo roots under scan roots", async () => {
    const r = (await callHost("git.discoverRepos", {
      roots: [join(dir, "..")],
      depth: 2,
    })) as { repos: { path: string }[] };
    expect(r.repos.some((p) => p.path === dir)).toBe(true);
    // `subrepo` is nested inside the repo → not re-discovered as its own root
    expect(r.repos.some((p) => p.path === join(dir, "subrepo"))).toBe(false);
  });

  it("AC-4 host calls work with no engine; engine-fake has no fs capability", async () => {
    const engine = new FakeEngine({ tick: 1 });
    // The fake engine speaks only the engine protocol — host/fs calls are
    // routed to the host, never dispatched to it.
    expect(await engine.dispatch("describe", {})).toBeTruthy();
    await expect(engine.dispatch("fs.list", { path: dir })).rejects.toThrow(
      /unknown method/,
    );
    const r = (await callHost("host.describe", {})) as {
      api: { name: string; version: number };
      methods: string[];
    };
    expect(r.api).toEqual(HOST_API);
    expect(r.methods).toContain("git.diff");
  });

  it("JSON-RPC frame round-trip + error codes", async () => {
    const frame = async (body: string) =>
      JSON.parse((await handleHostFrame(body)) ?? "null");
    const ok = await frame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "git.isRepo",
        params: { path: dir },
      }),
    );
    expect(ok.result.isRepo).toBe(true);
    const bad = await frame(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "fs.nope", params: {} }),
    );
    expect(bad.error.code).toBe(-32601);
    const badParams = await frame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "fs.read",
        params: { path: 5 },
      }),
    );
    expect(badParams.error.code).toBe(-32602);
    const missing = await frame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "fs.read",
        params: { path: `${dir}/nope` },
      }),
    );
    expect(missing.error.code).toBe(-32101);
  });
});
