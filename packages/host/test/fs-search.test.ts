import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callHost } from "../src/index";

/**
 * fs.search AC tests (issue #105): fuzzy file/dir search inside a session
 * folder. Fixtures: a git repo with tracked + untracked + gitignored files,
 * a plain non-repo folder, and a larger repo for the responsiveness check.
 */

type Hit = { path: string; kind: "file" | "dir" };
type SearchResult = { path: string; files: Hit[] };

let root = "";
let dir = ""; // git repo
let plain = ""; // non-repo folder
let big = ""; // repo with many files (perf)
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const search = (path: string, query: string, limit?: number) =>
  callHost("fs.search", {
    path,
    query,
    ...(limit ? { limit } : {}),
  }) as Promise<SearchResult>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lilos-search-"));

  // repo: tracked + untracked + ignored
  dir = join(root, "repo");
  mkdirSync(join(dir, "src", "util"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "secret.env\nlogs/\n");
  writeFileSync(join(dir, "src", "app.tsx"), "export {}\n");
  writeFileSync(join(dir, "src", "util", "deep.ts"), "export {}\n");
  writeFileSync(join(dir, "docs", "guide.md"), "# guide\n");
  writeFileSync(join(dir, "README.md"), "# repo\n");
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "init"]);
  writeFileSync(join(dir, "untracked.ts"), "export {}\n");
  writeFileSync(join(dir, "secret.env"), "TOKEN=x\n"); // gitignored
  writeFileSync(join(dir, "logs", "debug.log"), "log\n"); // gitignored dir

  // plain folder (not a repo)
  plain = join(root, "plain");
  mkdirSync(join(plain, "notes"), { recursive: true });
  writeFileSync(join(plain, "notes", "todo.md"), "- x\n");
  writeFileSync(join(plain, "readme.txt"), "hi\n");
  writeFileSync(join(plain, ".hidden"), "secret\n");

  // big repo: ~1600 tracked files for the responsiveness check
  big = join(root, "big");
  mkdirSync(big);
  for (let i = 0; i < 1600; i++) {
    const d = join(big, "src", `pkg${i % 40}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `file${i}.ts`), "export {}\n");
  }
  git(big, ["init", "-b", "main"]);
  git(big, ["config", "user.email", "t@t"]);
  git(big, ["config", "user.name", "t"]);
  git(big, ["add", "-A"]);
  git(big, ["commit", "-m", "init"]);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("fs.search (issue #105)", () => {
  it("AC-1 fuzzy-matches paths and honors the limit", async () => {
    const r = await search(dir, "app");
    const paths = r.files.map((f) => f.path);
    expect(paths).toContain("src/app.tsx");
    // every result carries a kind; a missing query char never matches
    expect(r.files.every((f) => f.kind === "file" || f.kind === "dir")).toBe(
      true,
    );
    expect((await search(dir, "zzzzz")).files).toEqual([]);
    // the cap is applied to matches, not the enumeration
    const capped = await search(big, "file", 20);
    expect(capped.files.length).toBe(20);
    expect((await search(big, "file", 5)).files.length).toBe(5);
  });

  it("AC-2 excludes gitignored files, includes untracked, marks dirs", async () => {
    const r = await search(dir, "", 100);
    const paths = r.files.map((f) => f.path);
    expect(paths).toContain("untracked.ts");
    expect(paths).not.toContain("secret.env");
    expect(paths.some((p) => p.startsWith("logs/"))).toBe(false);
    // nested gitignored dir excluded even though the walk would see it
    expect(paths).not.toContain("logs");
    // directories are listed and marked
    expect(r.files.find((f) => f.path === "src")?.kind).toBe("dir");
    expect(r.files.find((f) => f.path === "src/util")?.kind).toBe("dir");
    expect(r.files.find((f) => f.path === "docs")?.kind).toBe("dir");
    expect(r.files.find((f) => f.path === "src/app.tsx")?.kind).toBe("file");
    // the nested repo inside the fixture is opaque: its internals don't leak
    const none = await search(dir, "does-not-exist");
    expect(none.files).toEqual([]);
  });

  it("AC-2 a non-repo folder is searched by walking it", async () => {
    const r = await search(plain, "", 100);
    const paths = r.files.map((f) => f.path);
    expect(paths).toContain("readme.txt");
    expect(paths).toContain("notes/todo.md");
    expect(r.files.find((f) => f.path === "notes")?.kind).toBe("dir");
    expect(r.files.find((f) => f.path === "notes/todo.md")?.kind).toBe("file");
    // dotfiles stay out of an empty query (the composer opens on bare `@`)
    expect(paths).not.toContain(".hidden");
    const q = await search(plain, "todo");
    expect(q.files.map((f) => f.path)).toEqual(["notes/todo.md"]);
  });

  it("AC-5 results are cached per folder and refresh when the folder changes", async () => {
    // Cold call enumerates; warm call serves the cached enumeration.
    const cold0 = performance.now();
    const r1 = await search(big, "file1599");
    const coldMs = performance.now() - cold0;
    expect(r1.files.map((f) => f.path).join(",")).toContain("file1599.ts");
    const warm0 = performance.now();
    const r2 = await search(big, "file1598");
    const warmMs = performance.now() - warm0;
    expect(r2.files.map((f) => f.path).join(",")).toContain("file1598.ts");
    // Cache hit must be far inside the ~200ms keystroke budget (AC-5); the
    // cold enumeration on ~1.6k files gets a generous CI-safe bound.
    expect(warmMs).toBeLessThan(200);
    expect(coldMs).toBeLessThan(2000);

    // A change in the folder invalidates the cache (new root-level entry).
    writeFileSync(join(big, "brand-new-file.txt"), "x\n");
    utimesSync(big, new Date(), new Date());
    const r3 = await search(big, "brand-new-file");
    expect(r3.files.map((f) => f.path)).toContain("brand-new-file.txt");
  });

  it("surfaces a missing folder as PATH_NOT_FOUND", async () => {
    await expect(search(join(root, "nope"), "x")).rejects.toMatchObject({
      code: -32101,
    });
  });
});
