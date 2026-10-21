// @vitest-environment happy-dom
/* D-#19 (capability by presence): the PR card under a turn is a button with
   a hover wash and a chevron only when its host can open the PR tab. With no
   `onOpen` — a frame without the workbench — it is the same card, plain: no
   control that does nothing. */
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PrCard } from "../src/conversation/pr-card";
import { type TurnActs, TurnRow } from "../src/conversation/turn-rows";
import type { EmpFn, HumanFn, PullRequest, Reply } from "../src/types";

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

describe("PrCard", () => {
  /* lucide-react 1.x stamps no per-icon class, so the chevron is counted:
     the open card carries exactly one more icon than the plain one. */
  const icons = (el: HTMLElement) => el.querySelectorAll("svg").length;

  test("without onOpen it is a plain card — no button, no chevron", () => {
    const plain = render(<PrCard pr={PR} author="Builder" />);
    const card = plain.container.querySelector("[data-prcard]");
    expect(card).toBeTruthy();
    expect(card?.tagName).toBe("DIV");
    expect(plain.container.querySelector("button")).toBeNull();
    expect(card?.className).not.toContain("hover:");
    expect(card?.textContent).toContain("Add the forge tab");
    const plainIcons = icons(plain.container);
    cleanup();
    const open = render(
      <PrCard pr={PR} author="Builder" onOpen={() => undefined} />,
    );
    expect(icons(open.container)).toBe(plainIcons + 1);
  });

  test("with onOpen it is a button and a click opens the PR tab", () => {
    const onOpen = vi.fn();
    const { container } = render(
      <PrCard pr={PR} author="Builder" onOpen={onOpen} />,
    );
    const button = container.querySelector("button[data-prcard]");
    expect(button).toBeTruthy();
    fireEvent.click(button as Element);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

const EMP = {
  id: "builder",
  name: "Builder",
  role: "Engineer",
  status: "online" as const,
  profile: "p",
  model: "m",
  now: "",
  instructions: "",
  respondTo: "anyone" as const,
};
const emp: EmpFn = (id) => (id === EMP.id ? EMP : undefined);
const human: HumanFn = () => undefined;

const prReply: Reply = {
  id: "a1",
  turnId: "t-a1",
  from: EMP.id,
  time: "",
  text: "Opened the PR.",
  phase: "done",
  steps: [
    {
      tool: "terminal",
      input: { command: "gh pr create --fill" },
      output: "https://github.com/acme/widgets/pull/7",
    },
  ],
};

const row = (acts: MutableRefObject<TurnActs>) => (
  <TurnRow
    frame="focus"
    r={prReply}
    i={0}
    lastTurn
    lastRow
    flashed={false}
    lazy={false}
    scrollTarget={false}
    running={false}
    emp={emp}
    human={human}
    resolved={{}}
    work={null}
    pr={PR}
    prAuthor="Builder"
    acts={acts}
  />
);

describe("TurnRow wires the PR card by capability", () => {
  test("a row whose view has no onOpen renders the card without a button", () => {
    const { container } = render(row({ current: {} }));
    expect(container.querySelector("[data-prcard]")).toBeTruthy();
    expect(container.querySelector("button[data-prcard]")).toBeNull();
  });

  test('a row whose view has onOpen opens the "pr" tab on click', () => {
    const onOpen = vi.fn();
    const { container } = render(row({ current: { onOpen } }));
    fireEvent.click(
      container.querySelector("button[data-prcard]") as HTMLElement,
    );
    expect(onOpen).toHaveBeenCalledWith("pr");
  });
});
