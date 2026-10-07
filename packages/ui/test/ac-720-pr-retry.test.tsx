// @vitest-environment happy-dom
/* Issue #720 red-first: a signal-driven `forge.pr` re-read must not unmount
   the mounted `PrFailure` while it lands — the `prShown ? PrPanel :
   PrFailure` swap detaches the Retry button under an in-flight click
   (ac-114 AC-5's "element is not stable" → "element was detached from the
   DOM" timeout). The error copy's own instruction is "then Retry": while
   the landed answer is an error the poll holds, and the user's retry is the
   read that swaps the panel in. The no-PR state keeps self-healing — it has
   no pressable control to protect. */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type {
  HostAccessors,
  PrError,
  PullRequest,
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

const CWD = "/tmp/wb-720-repo";
const WORK: Work = { ticket: "T-720", title: "Detach", path: CWD };
const THREAD: Thread = { session: "s_720", replies: [] };

type PrRead = { pr: PullRequest | null; branch?: string; error?: PrError };
const PR7: PullRequest = {
  number: 7,
  repo: "acme/widgets",
  title: "Add the forge tab",
  body: "",
  status: "open",
  author: "builder",
  base: "trunk",
  head: "feat/forge",
  opened: "1h",
  checks: [{ name: "typecheck", status: "passed" }],
  comments: [],
};
const AUTH_ERROR: PrError = {
  reason: "unauthenticated",
  detail: "gh: not logged in",
};

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const p = new Promise<T>((r) => {
    resolve = r;
  });
  return { p, resolve };
};
const beat = (ms = 120) => new Promise((r) => setTimeout(r, ms));

/* Every `forge.pr` call queues a deferred — the test lands each read exactly
   when it wants to; the OTHER probe keys answer instantly so the mount
   round settles and the PR tab can show. */
const makeHost = () => {
  const prCalls: ReturnType<typeof deferred<PrRead | null>>[] = [];
  const host: HostAccessors = {
    tree: async () => ["a.txt"],
    diff: async () => [],
    read: async () => ({ content: "x", binary: false, truncated: false }),
    status: async () => ({ branch: "trunk", clean: true, files: [] }),
    branches: async () => ({
      current: "trunk",
      branches: ["trunk"],
      remote: null,
      default: null,
    }),
    log: async () => [],
    pr: () => {
      const d = deferred<PrRead | null>();
      prCalls.push(d);
      return d.p;
    },
  };
  return { host, prCalls };
};

const ui = (host: HostAccessors, running: boolean) => (
  <Workbench
    thread={THREAD}
    work={WORK}
    isDM
    tab={"pr" as WbTab}
    setTab={() => {}}
    onClose={() => {}}
    human={() => undefined}
    host={host}
    running={running}
  />
);

const retryBtn = (c: HTMLElement) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent === "Retry");

const callAt = <T,>(list: T[], i: number) => {
  const v = list[i];
  if (v === undefined) throw new Error(`forge.pr call ${i} never fired`);
  return v;
};

describe("#720 a scheduled forge.pr land cannot yank the mounted Retry button", () => {
  test("AC-1/2: a signal-driven re-read while the failure shows is held; the click's own read swaps in the panel", async () => {
    const { host, prCalls } = makeHost();
    const c = render(ui(host, false));
    /* Mount's `poll.signal()` fires the first `forge.pr` — gh answers the
       signed-out failure, and the PR tab renders its Retry. */
    await waitFor(() => expect(prCalls.length).toBe(1));
    callAt(prCalls, 0).resolve({
      pr: null,
      branch: "feat/forge",
      error: AUTH_ERROR,
    });
    await waitFor(() => expect(retryBtn(c.container)).toBeTruthy());
    const retry = retryBtn(c.container);
    if (!retry) throw new Error("Retry never rendered");

    /* A scheduled re-read fires mid-gesture — a `running` flip re-runs the
       probe effect, whose fresh poll signals immediately (same path as the
       PR-tab-shown trailing fire and the OS-window-focus signal). With the
       bug, its `{pr}` land swaps PrFailure → PrPanel and the button the
       click resolved detaches before the click dispatches. */
    c.rerender(ui(host, true));
    await beat();
    prCalls[1]?.resolve({ pr: PR7, branch: "feat/forge" });
    await beat();

    /* The failure view and its button must survive — a scheduled land may
       not swap the subtree out from under a press. Post-fix the read is
       gated before it even calls host.pr. */
    expect(prCalls.length).toBe(1);
    expect(retry.isConnected).toBe(true);
    expect(retryBtn(c.container)).toBe(retry);
    expect(c.container.querySelector("[data-pr='7']")).toBeNull();
    /* `?wbPrSigMark` unset → the reproducer leaves no DOM footprint. */
    expect(c.container.querySelector("[data-pr-sig-mark]")).toBeNull();

    /* The user's own Retry still reads for real and swaps the panel in. */
    fireEvent.click(retry);
    await waitFor(() => expect(prCalls.length).toBe(2));
    callAt(prCalls, 1).resolve({ pr: PR7, branch: "feat/forge" });
    await waitFor(() =>
      expect(c.container.querySelector("[data-pr='7']")).not.toBeNull(),
    );
  });

  test("AC-2 boundary: the no-PR state still self-heals — nothing on it can be pressed", async () => {
    const { host, prCalls } = makeHost();
    const c = render(ui(host, false));
    await waitFor(() => expect(prCalls.length).toBe(1));
    callAt(prCalls, 0).resolve({ pr: null, branch: "feat/forge" });
    await waitFor(() =>
      expect(c.container.textContent).toContain("No pull request on"),
    );

    /* `{pr: null}` (no error) is NOT a failure window — a scheduled
       re-read still runs and a `{pr}` land swaps the panel in. */
    c.rerender(ui(host, true));
    await waitFor(() => expect(prCalls.length).toBe(2));
    callAt(prCalls, 1).resolve({ pr: PR7, branch: "feat/forge" });
    await waitFor(() =>
      expect(c.container.querySelector("[data-pr='7']")).not.toBeNull(),
    );
  });
});
