// @vitest-environment happy-dom
/* AC tests for issue #550: a system note (`from === ""` — how the relay's
   `authorKind: "system"` maps into replies, mapping.ts) renders as a muted
   note line in the Focus frame, never a right-aligned user bubble. The
   panel frame already showed it as an avatar-less left row. */
import { cleanup, render } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { type TurnActs, TurnRow } from "../src/conversation/turn-rows";
import type { EmpFn, HumanFn, Reply } from "../src/types";

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

const emp: EmpFn = () => undefined;
const human: HumanFn = (id) =>
  id === "user" ? { name: "Ada", color: "bg-blue-600" } : undefined;
const acts: MutableRefObject<TurnActs> = { current: {} };

const row = (frame: "panel" | "focus", r: Reply) => (
  <TurnRow
    frame={frame}
    r={r}
    i={0}
    lastTurn={false}
    lastRow
    flashed={false}
    lazy={false}
    scrollTarget={false}
    running={false}
    emp={emp}
    human={human}
    resolved={{}}
    work={null}
    acts={acts}
  />
);

const note: Reply = { id: "n1", from: "", time: "", text: "⚠ Stopped." };

describe("system-note rows (#550)", () => {
  test("AC-3: a `from === \"\"` note is a muted line in Focus, never a user bubble", () => {
    const { container } = render(row("focus", note));
    const sysnote = container.querySelector("[data-sysnote]");
    expect(sysnote).toBeTruthy();
    expect(sysnote?.textContent).toContain("⚠ Stopped.");
    expect(container.querySelector("[data-userturn]")).toBeFalsy();
  });

  test("a real user reply still renders as a user bubble in Focus", () => {
    const { container } = render(
      row("focus", { id: "u1", from: "user", time: "", text: "hi" }),
    );
    expect(container.querySelector("[data-userturn]")).toBeTruthy();
    expect(container.querySelector("[data-sysnote]")).toBeFalsy();
  });

  test("the panel keeps its avatar-less left row for the same note", () => {
    const { container } = render(row("panel", note));
    expect(container.querySelector("[data-userturn]")).toBeFalsy();
    expect(container.textContent).toContain("⚠ Stopped.");
  });
});
