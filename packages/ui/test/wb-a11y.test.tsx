// @vitest-environment happy-dom
/* #770 review: a control that folds says whether it is open (aria-expanded),
   a fold with nothing to open is inert, and an icon-only button has a name. */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { PlanCard } from "../src/conversation/plan-card";
import { WorkStep } from "../src/conversation/work-step";
import type { GitCommit, HumanFn, Plan, PullRequest, Step } from "../src/types";
import { PlanPanel } from "../src/workbench/plan-panel";
import { PrPanel } from "../src/workbench/pr-panel";
import { PrCommits } from "../src/workbench/pr-tab-bodies";
import { StepRow } from "../src/workbench/step-row";

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

const TRIGGER = '[data-slot="collapsible-trigger"]';
const step = (extra: Partial<Step> = {}): Step => ({
  tool: "terminal",
  input: { command: "bun test" },
  output: "",
  ...extra,
});

describe("WorkStep", () => {
  test("a running step has nothing to open: its trigger is inert and it stays shut once it finishes", () => {
    const r = render(
      <WorkStep s={step({ running: true })} tail={false} waiting={false} />,
    );
    const running = r.container.querySelector(TRIGGER) as HTMLElement;
    expect(running.getAttribute("aria-disabled")).toBe("true");
    act(() => fireEvent.click(running));
    r.rerender(
      <WorkStep s={step({ output: "ok" })} tail={false} waiting={false} />,
    );
    const done = r.container.querySelector(TRIGGER) as HTMLElement;
    expect(done.getAttribute("aria-disabled")).not.toBe("true");
    expect(done.getAttribute("aria-expanded")).toBe("false");
    act(() => fireEvent.click(done));
    expect(done.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("StepRow", () => {
  test("only a step with something to show folds, and says whether it is open", () => {
    const r = render(<StepRow s={step({ output: "ok" })} />);
    const btn = r.getByRole("button");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    r.rerender(<StepRow s={step({ running: true })} />);
    expect(r.getByRole("button").hasAttribute("aria-expanded")).toBe(false);
  });
});

const PLAN: Plan = {
  id: "p1",
  version: 1,
  goal: "Ship it",
  status: "approved",
  steps: [{ text: "Write it", status: "completed" }],
};

describe("PlanCard", () => {
  test("a finished plan is a fold that says whether it is open; a live plan has no fold", () => {
    const r = render(<PlanCard plan={PLAN} />);
    const btn = r.getByRole("button");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    r.rerender(
      <PlanCard
        plan={{ ...PLAN, steps: [{ text: "Write it", status: "in_progress" }] }}
      />,
    );
    expect(r.getByRole("button").hasAttribute("aria-expanded")).toBe(false);
  });
});

describe("PlanPanel", () => {
  test("an earlier version folds and says whether it is open", () => {
    const r = render(
      <PlanPanel
        plans={[
          { ...PLAN, status: "replaced" },
          { ...PLAN, id: "p2", version: 2 },
        ]}
      />,
    );
    const older = r.getByRole("button", { name: /v1/ });
    expect(older.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(older);
    expect(older.getAttribute("aria-expanded")).toBe("true");
  });
});

const human: HumanFn = () => ({ name: "Ada", color: "bg-blue-600" });
const PR: PullRequest = {
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
const COMMITS: GitCommit[] = [
  { hash: "abc1234", message: "feat: forge", files: [] },
];

describe("PR panel", () => {
  test("the merge box folds and says whether it is open", () => {
    const r = render(
      <PrPanel pr={PR} diffs={[]} commits={COMMITS} human={human} />,
    );
    const box = r.getByRole("button", { name: /Ready to merge/ });
    expect(box.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(box);
    expect(box.getAttribute("aria-expanded")).toBe("true");
  });

  test("the icon-only copy buttons are named", () => {
    const r = render(
      <PrPanel pr={PR} diffs={[]} commits={COMMITS} human={human} />,
    );
    expect(r.getByLabelText("Copy PR link")).toBeTruthy();
    cleanup();
    const c = render(<PrCommits commits={COMMITS} author="Builder" />);
    expect(c.getByLabelText("Copy hash")).toBeTruthy();
  });
});
