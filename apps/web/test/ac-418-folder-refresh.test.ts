/* Issue #418: the Add-a-folder listing must re-read the dir on every ask —
   a folder created while the app is open shows the next time the picker
   opens; no listing is cached for the page's lifetime (AC-1). The host
   transport is mocked onto a real tmpdir — the disk read is real (fs.readdir
   like the host's fs.list), only the wire is skipped. */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";

vi.mock("../src/lib/host", () => ({
  hostList: vi.fn(async (path: string) => ({
    path,
    entries: readdirSync(path, { withFileTypes: true }).map((e) => ({
      name: e.name,
      kind: e.isDirectory() ? ("dir" as const) : ("file" as const),
    })),
  })),
  hostIsRepo: vi.fn(async () => ({ isRepo: false })),
  hostBranches: vi.fn(async () => ({
    root: "",
    current: null,
    branches: [],
    remote: null,
    default: null,
  })),
  hostDiscoverRepos: vi.fn(async () => ({ repos: [] })),
  hostRoots: vi.fn(() => [] as string[]),
  initHost: vi.fn(),
  hostUser: vi.fn(async () => ({
    username: "t",
    fullName: null,
    home: "/tmp",
  })),
}));

import { fsRows, loadDir, needDir } from "../src/lib/folders";
import { hostList } from "../src/lib/host";

const ROOT = mkdtempSync(join(tmpdir(), "lilos-418-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("issue #418 folder picker refresh", () => {
  test("AC-1 needDir re-reads a dir after a new folder appears", async () => {
    const dir = join(ROOT, "relist");
    mkdirSync(join(dir, "alpha"), { recursive: true });
    const first = await needDir(dir);
    expect(first?.[dir]?.children).toEqual(["alpha"]);

    // A new subdir appears while the app is open — the next ask must see it.
    mkdirSync(join(dir, "beta"));
    const second = await needDir(dir);
    expect(second?.[dir]?.children).toEqual(["alpha", "beta"]);
  });

  test("AC-1 loadDir refreshes fsRows on the next picker open", async () => {
    const dir = join(ROOT, "fsrows");
    mkdirSync(join(dir, "one"), { recursive: true });
    loadDir(dir);
    await needDir(dir); // joins the in-flight fetch loadDir started
    expect(fsRows.get()[dir]?.children).toEqual(["one"]);

    mkdirSync(join(dir, "two"));
    loadDir(dir);
    await needDir(dir);
    expect(fsRows.get()[dir]?.children).toEqual(["one", "two"]);
  });

  test("AC-1 in-flight asks still dedupe to one fs.list; a later ask refetches", async () => {
    const dir = join(ROOT, "dedupe");
    mkdirSync(dir, { recursive: true });
    const list = vi.mocked(hostList);
    list.mockClear();

    const [a, b] = await Promise.all([needDir(dir), needDir(dir)]);
    expect(list.mock.calls.filter(([p]) => p === dir)).toHaveLength(1);
    expect(b).toEqual(a);

    mkdirSync(join(dir, "later"));
    await needDir(dir);
    expect(list.mock.calls.filter(([p]) => p === dir)).toHaveLength(2);
  });
});
