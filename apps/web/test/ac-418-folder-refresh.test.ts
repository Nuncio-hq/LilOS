/* Issue #418: the Add-a-folder listing must re-read the dir on every ask —
   a folder created while the app is open shows the next time the picker
   opens; no listing is cached for the page's lifetime (AC-1). The host
   transport is mocked onto a real tmpdir — the disk read is real (fs.readdir
   like the host's fs.list), only the wire is skipped. The test drives the
   dialog's real surface: loadDir → fsRows. */

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

import { fsRows, loadDir } from "../src/lib/folders";
import { hostList } from "../src/lib/host";

const ROOT = mkdtempSync(join(tmpdir(), "lilos-418-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const children = (dir: string) => fsRows.get()[dir]?.children;

describe("issue #418 folder picker refresh", () => {
  test("AC-1 loadDir re-reads a dir after a new folder appears", async () => {
    const dir = join(ROOT, "relist");
    mkdirSync(join(dir, "alpha"), { recursive: true });
    loadDir(dir);
    await vi.waitFor(() => expect(children(dir)).toEqual(["alpha"]));

    // A new subdir appears while the app is open — the next ask must see it.
    mkdirSync(join(dir, "beta"));
    loadDir(dir);
    await vi.waitFor(() => expect(children(dir)).toEqual(["alpha", "beta"]));
  });

  test("AC-1 in-flight asks still dedupe to one fs.list; a later ask refetches", async () => {
    const dir = join(ROOT, "dedupe");
    mkdirSync(dir, { recursive: true });
    const list = vi.mocked(hostList);
    list.mockClear();

    // Two asks inside one in-flight window share a single fs.list.
    loadDir(dir);
    loadDir(dir);
    await vi.waitFor(() => expect(children(dir)).toBeDefined());
    expect(list.mock.calls.filter(([p]) => p === dir)).toHaveLength(1);

    mkdirSync(join(dir, "later"));
    loadDir(dir);
    await vi.waitFor(() => expect(children(dir)).toEqual(["later"]));
    expect(list.mock.calls.filter(([p]) => p === dir)).toHaveLength(2);
  });
});
