// @vitest-environment happy-dom
/* Issue #685 — a Files pick must survive the turn's relay-answer claim.
   When the client's relay socket lands `message.created` (the turn's
   posted answer) while the feed's `turn.completed` is still in flight,
   mergeTurns claims the row for the still-live turn and rewrites the
   live reply's `id` (live-t1 → the relay row id) — `turnId` is kept.
   The pick-hold keyed on `id` read that rewrite as a new turn, cleared
   itself and re-armed follow; the turn's trailing `terminal` step then
   stole the tab (ac-544 AC-6). */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { FocusView } from "../src/focus/focus-view";
import type {
  Channel,
  EmpFn,
  HumanFn,
  Msg,
  Reply,
  Thread,
  Work,
} from "../src/types";

/* happy-dom does not implement every browser API the vendored components touch. */
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof Element.prototype.scrollTo === "undefined") {
  Element.prototype.scrollTo = () => {};
}
if (typeof Element.prototype.getAnimations === "undefined") {
  Element.prototype.getAnimations = () => [];
}
if (typeof Element.prototype.scrollIntoView === "undefined") {
  Element.prototype.scrollIntoView = () => {};
}
// The workbench opens at >=1024px; force it so the tab strip mounts.
Object.defineProperty(window, "innerWidth", { value: 1400, writable: true });
afterEach(cleanup);

const BUILDER = {
  id: "builder",
  name: "Builder",
  role: "Engineer",
  status: "online" as const,
  profile: "p",
  model: "gpt-test-1",
  now: "",
  instructions: "",
  respondTo: "anyone" as const,
};
const emp: EmpFn = (id) => (id === "builder" ? BUILDER : undefined);
const human: HumanFn = (id) =>
  id === "ada" ? { name: "Ada", color: "bg-blue-600" } : undefined;

const dmChannel: Channel = {
  id: "dm-builder",
  name: "Builder",
  employees: ["builder"],
  dm: true,
};
const WORK: Work = { ticket: "T-685", title: "Pick-hold", path: "/repo-685" };

const root: Extract<Msg, { kind: "msg" }> = {
  kind: "msg",
  id: "m1",
  from: "ada",
  time: "10:00",
  text: "check the folder",
};

/* The live turn row — `live` + `postAttach` mirror what conv-fold hands
   FocusView mid-turn. Its last step is `terminal` (the engine-fake's
   default script ends on `pnpm -r typecheck`), so an armed follow would
   land the Workbench on Terminal — the steal vector. */
const liveReply: Reply = {
  id: "live-t1",
  turnId: "conv_685:t1",
  live: true,
  postAttach: true,
  from: "builder",
  time: "",
  text: "Short answer",
  phase: "streaming",
  steps: [
    {
      tool: "search_files",
      input: { pattern: "check", path: "." },
      output: "4 matches",
    },
    {
      tool: "terminal",
      input: { command: "pnpm -r typecheck" },
      output: "4 projects · 0 errors",
    },
  ],
};

const host = {
  tree: async () => ["a.txt", "b.txt"],
  diff: async () => [],
  read: async () => null,
  pr: async () => ({ pr: null, branch: "trunk" }),
  status: async () => ({ branch: "trunk", clean: true, files: [] }),
  branches: async () => ({
    current: "trunk",
    branches: ["trunk"],
    remote: null,
    default: "trunk",
  }),
  log: async () => [],
};

const ui = (thread: Thread) => (
  <FocusView
    root={root}
    thread={thread}
    channel={dmChannel}
    lead={BUILDER}
    emp={emp}
    human={human}
    running
    work={WORK}
    host={host}
    resolved={{}}
    onSend={() => {}}
  />
);

describe("#685 — the pick-hold rides turnId, not the claimable reply id", () => {
  test("a Files pick survives the relay-answer claim rewriting the live reply's id mid-turn", async () => {
    const r = render(ui({ session: "s_685", replies: [liveReply] }));
    /* Wait for the probe to land the Files tab, then pick it. */
    const filesTab = await r.findByRole("tab", { name: /Files/ });
    fireEvent.click(filesTab);
    await waitFor(() =>
      expect(filesTab.getAttribute("aria-selected")).toBe("true"),
    );

    /* The claim: the same live turn is re-folded carrying the relay row's
       id — `turnId` is untouched (mergeTurns only rewrites `id`). */
    const claimed: Reply = { ...liveReply, id: "m-9" };
    r.rerender(ui({ session: "s_685", replies: [claimed] }));

    /* Follow must still be held — no step may steal the pick. */
    await waitFor(() =>
      expect(
        r.getByRole("tab", { name: /Files/ }).getAttribute("aria-selected"),
      ).toBe("true"),
    );
    /* …and it holds once the turn settles too (live row leaves). */
    r.rerender(
      ui({
        session: "s_685",
        replies: [{ ...claimed, live: false, phase: "done" }],
      }),
    );
    await waitFor(() =>
      expect(
        r.getByRole("tab", { name: /Files/ }).getAttribute("aria-selected"),
      ).toBe("true"),
    );
  });

  test("a pick still releases when the NEXT turn's live row shows up", async () => {
    const r = render(ui({ session: "s_685", replies: [liveReply] }));
    const filesTab = await r.findByRole("tab", { name: /Files/ });
    fireEvent.click(filesTab);
    await waitFor(() =>
      expect(filesTab.getAttribute("aria-selected")).toBe("true"),
    );

    /* A genuinely different turn (new turnId) — the hold is for the
       pick-time turn only (#396): follow may re-arm here. */
    const next: Reply = {
      ...liveReply,
      id: "live-t2",
      turnId: "conv_685:t2",
      steps: [
        {
          tool: "terminal",
          input: { command: "bun test" },
          output: "ok",
        },
      ],
    };
    r.rerender(
      ui({ session: "s_685", replies: [{ ...liveReply, live: false }, next] }),
    );
    await waitFor(() =>
      expect(
        r.getByRole("tab", { name: /Files/ }).getAttribute("aria-selected"),
      ).not.toBe("true"),
    );
  });
});
