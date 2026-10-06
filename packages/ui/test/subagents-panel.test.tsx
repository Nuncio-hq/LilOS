// @vitest-environment happy-dom
/* #319 verify-plan unit: sessionSubagents flattens the thread's helpers
   oldest-first (a reload rebuilds the same rows — AC-3), and the panel
   groups them Running first, Finished newest-first. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { EmpFn, Reply, Step, Subagent, Thread } from "../src/types";
import {
  SubagentsPanel,
  sessionSubagents,
} from "../src/workbench/subagents-panel";

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
afterEach(cleanup);

const EMP = {
  id: "reviewer",
  name: "Reviewer",
  role: "QA",
  status: "online" as const,
  profile: "p",
  model: "m",
  now: "",
  instructions: "",
  respondTo: "anyone" as const,
};
const emp: EmpFn = (id) => (id === EMP.id ? EMP : undefined);

const step: Step = { tool: "read_file", input: { path: "a.ts" }, output: "x" };
const agent = (id: string, status: Subagent["status"]): Subagent => ({
  id,
  name: `Agent ${id}`,
  task: `task-${id}`,
  status,
  steps: [step],
  result: status === "done" || status === "failed" ? `result-${id}` : undefined,
});
const turn = (id: string, time: string, subagents: Subagent[]): Reply => ({
  id,
  turnId: `t-${id}`,
  from: "builder",
  time,
  text: "",
  subagents,
});

const thread: Thread = {
  session: "s_1",
  replies: [
    turn("r1", "10:00", [agent("a1", "done"), agent("a2", "failed")]),
    turn("r2", "10:10", [agent("a3", "done")]),
    turn("r3", "10:20", [agent("a4", "running"), agent("a5", "stopped")]),
  ],
};

test("sessionSubagents flattens replies oldest-first with each turn's time", () => {
  const all = sessionSubagents(thread);
  expect(all.map((p) => p.a.id)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  expect(all.map((p) => p.from)).toEqual([
    "10:00",
    "10:00",
    "10:10",
    "10:20",
    "10:20",
  ]);
});

describe("SubagentsPanel grouping (#319 AC-3)", () => {
  test("Running first, then Finished newest-first — a rebuild shows the same rows once", () => {
    const { container } = render(<SubagentsPanel thread={thread} emp={emp} />);
    const groups = container.querySelectorAll("[data-subagents-group]");
    expect(
      [...groups].map((g) => g.getAttribute("data-subagents-group")),
    ).toEqual(["running", "finished"]);
    const rows = groups[1].querySelectorAll("[data-subagent]");
    /* a5 (stopped, newest turn) leads; a1 finishes the list — turn order
       reversed within Finished. */
    expect([...rows].map((r) => r.getAttribute("data-subagent"))).toEqual([
      "a5",
      "a3",
      "a2",
      "a1",
    ]);
    /* One row per helper — a replay/rebuild never duplicates them. */
    expect(container.querySelectorAll("[data-subagent]")).toHaveLength(5);
    expect(
      groups[0].querySelector("[data-subagent]")?.getAttribute("data-status"),
    ).toBe("running");
  });

  test("an employee helper row offers Open session, never an expander", () => {
    const withHelper: Thread = {
      session: "s_2",
      replies: [
        turn("r1", "09:00", [
          {
            ...agent("a9", "done"),
            employee: { id: "reviewer", session: "s_r" },
          },
        ]),
      ],
    };
    const { container, getByRole } = render(
      <SubagentsPanel thread={withHelper} emp={emp} onOpenSession={() => {}} />,
    );
    const btn = getByRole("button", { name: /Open thread/ });
    expect(btn).toBeTruthy();
    expect(container.textContent).toContain("Reviewer · Agent a9");
  });
});
