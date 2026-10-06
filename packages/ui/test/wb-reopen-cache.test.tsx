// @vitest-environment happy-dom
/* Issue #544 red-first: reopening the Workbench shows the LAST KNOWN
   Files/Changes/Commits/PR on the first frame — a per-folder cache
   (key host + cwd) holds them outside component state while fresh reads
   revalidate behind (stale-while-revalidate). Reads also land
   independently: a held `forge.pr` never blocks Files/Changes, and an
   open file view survives the panel's unmount. */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type {
  Diff,
  GitCommit,
  HostAccessors,
  Thread,
  WbTab,
  Work,
} from "../src/types";
import { Workbench } from "../src/workbench/workbench";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof Element.prototype.scrollIntoView === "undefined") {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof Element.prototype.getAnimations === "undefined") {
  Element.prototype.getAnimations = () => [];
}
afterEach(cleanup);

const CWD = "/tmp/wb-reopen-repo";
const WORK: Work = { ticket: "T-544", title: "Reopen", path: CWD };
const THREAD: Thread = { session: "s_544", replies: [] };

const pending = <T,>() => new Promise<T | null>(() => {});
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const p = new Promise<T>((r) => {
    resolve = r;
  });
  return { p, resolve };
};

/* One host object identity per test (the cache keys on it); `impls` swaps
   what the accessors do, so the first mount resolves and the remount's
   revalidate reads stay held. */
const makeHost = (impls: Partial<HostAccessors> = {}) => {
  const impl = {
    tree: () => pending<string[]>(),
    diff: () => pending<Diff[]>(),
    read: () =>
      pending<{ content: string; binary: boolean; truncated: boolean }>(),
    pr: () => pending<{ pr: null; branch: string }>(),
    status: () => pending<{ branch: string; clean: boolean }>(),
    branches: () =>
      pending<{ current: string; branches: string[]; remote: null }>(),
    log: () => pending<GitCommit[]>(),
    ...impls,
  };
  const host: HostAccessors = {
    tree: (cwd) => impl.tree(cwd),
    diff: (cwd) => impl.diff(cwd),
    read: (cwd, p) => impl.read(cwd, p),
    pr: (cwd) => impl.pr(cwd),
    status: (cwd) => impl.status(cwd),
    branches: (cwd) => impl.branches(cwd),
    log: (cwd) => impl.log(cwd),
  };
  return { host, setImpl: (o: Partial<typeof impl>) => Object.assign(impl, o) };
};

const mount = (host: HostAccessors, tab: WbTab = "files") =>
  render(
    <Workbench
      thread={THREAD}
      work={WORK}
      isDM
      tab={tab}
      setTab={() => {}}
      onClose={() => {}}
      human={() => undefined}
      host={host}
    />,
  );
const rows = (c: HTMLElement) =>
  [...c.querySelectorAll('[role="treeitem"]')].map((e) => e.textContent);

describe("#544 stale-while-revalidate per-folder cache", () => {
  test("AC-1/3/1: remount renders last-known rows on the first frame with reads held; fresh data updates in place", async () => {
    const { host, setImpl } = makeHost({
      tree: async () => ["a.txt", "src/deep.txt"],
      diff: async () => [],
      status: async () => ({ branch: "trunk", clean: true }),
      branches: async () => ({
        current: "trunk",
        branches: ["trunk"],
        remote: null,
      }),
      log: async () => [],
      pr: async () => ({ pr: null, branch: "trunk" }),
    });
    const first = mount(host, "files");
    await waitFor(() =>
      expect(rows(first.container).length).toBeGreaterThan(0),
    );
    const before = rows(first.container);
    first.unmount();

    /* Every read held pending — the remount must still show the
       last-known rows NOW (first frame), not after the round lands. */
    const tree2 = deferred<string[] | null>();
    const diff2 = deferred<Diff[] | null>();
    setImpl({ tree: () => tree2.p, diff: () => diff2.p });
    const second = mount(host, "files");
    expect(rows(second.container)).toEqual(before);
    expect(second.queryByText(/Reading/)).toBeNull();

    /* …then the revalidate lands and updates the list in place. */
    tree2.resolve(["a.txt", "src/deep.txt", "new.txt"]);
    diff2.resolve([]);
    await waitFor(() => expect(second.queryByText("new.txt")).toBeTruthy());
  });

  test("AC-2: a held forge.pr never blocks Files/Changes; the PR tab fills in when it answers", async () => {
    const pr = deferred<{ pr: null; branch: string } | null>();
    const { host } = makeHost({
      tree: async () => ["a.txt"],
      diff: async () => [
        {
          path: "a.txt",
          add: 1,
          del: 0,
          status: "modified",
          patch: "@@ -1 +1 @@\n-x\n+y\n",
        },
      ],
      status: async () => ({ branch: "trunk", clean: false }),
      branches: async () => ({
        current: "trunk",
        branches: ["trunk"],
        remote: null,
      }),
      log: async () => [],
      pr: () => pr.p,
    });
    const r = mount(host, "changes");

    /* The folder tabs render as soon as their own reads land — the ~1s
       `gh` call is not in their way. */
    await waitFor(() =>
      expect(r.container.querySelector('[data-wb-tab="changes"]')).toBeTruthy(),
    );
    await waitFor(() =>
      expect(r.container.querySelector('[data-wb-tab="files"]')).toBeTruthy(),
    );
    expect(r.container.querySelector("[data-diff]")).toBeTruthy();

    pr.resolve({ pr: null, branch: "trunk" });
    await waitFor(() =>
      expect(r.container.querySelector('[data-wb-tab="pr"]')).toBeTruthy(),
    );
  });

  test("AC-4: an open file view survives the panel's unmount and shows on reopen", async () => {
    const readD = deferred<{
      content: string;
      binary: boolean;
      truncated: boolean;
    } | null>();
    const { host, setImpl } = makeHost({
      tree: async () => ["a.txt"],
      diff: async () => [],
      read: async () => ({
        content: "file-body",
        binary: false,
        truncated: false,
      }),
      status: async () => ({ branch: "trunk", clean: true }),
      branches: async () => ({
        current: "trunk",
        branches: ["trunk"],
        remote: null,
      }),
      log: async () => [],
      pr: async () => ({ pr: null, branch: "trunk" }),
    });
    const first = mount(host, "files");
    await waitFor(() =>
      expect(rows(first.container).length).toBeGreaterThan(0),
    );
    // Open the file view.
    const row = [...first.container.querySelectorAll('[role="treeitem"]')].find(
      (e) => e.textContent?.includes("a.txt"),
    ) as HTMLElement;
    fireEvent.click(row);
    await waitFor(() =>
      expect(first.container.querySelector("[data-fileview]")).toBeTruthy(),
    );
    expect(first.queryByText("file-body")).toBeTruthy();
    first.unmount();

    setImpl({ read: () => readD.p });
    const second = mount(host, "files");
    // The open file view is back on the first frame, from the cache.
    expect(second.container.querySelector("[data-fileview]")).toBeTruthy();
    expect(second.queryByText("file-body")).toBeTruthy();
    readD.resolve({ content: "file-body", binary: false, truncated: false });
  });
});
