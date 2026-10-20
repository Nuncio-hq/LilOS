// @vitest-environment happy-dom
/* Issue #660 — the pane's <main> landmark belongs to the host, not to the
   view: a view rendered `bare` supplies no <main> of its own, so the host's
   one element is not nested inside a second (and does not unmount under a
   measured handle when the view swaps). The DM-feed half of this test went
   with the old DM home; Focus still honours the contract (SessionPane renders
   it `bare`), so the count is the tripwire for a dropped `bare` prop.
   e2e/dm-layout.spec.ts samples the real page. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { FocusView } from "../src/focus/focus-view";
import { MainPane } from "../src/shell/main-pane";
import type {
  Channel,
  EmpFn,
  Employee,
  HumanFn,
  Msg,
  Thread,
} from "../src/types";

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
Object.defineProperty(window, "innerWidth", { value: 1400, writable: true });

afterEach(cleanup);
afterEach(() => localStorage.clear());

const EMP: Employee = {
  id: "e1",
  name: "Builder",
  role: "Engineer",
  status: "online",
  profile: "p",
  model: "gpt-test-1",
  now: "",
  instructions: "",
  respondTo: "anyone",
};
const emp: EmpFn = (id) => (id === "e1" ? EMP : undefined);
const human: HumanFn = () => undefined;

const CHANNEL: Channel = {
  id: "dm-e1",
  name: "Builder",
  employees: ["e1"],
  dm: true,
};
const THREAD: Thread = { session: "s_1", replies: [] };
const ROOT: Extract<Msg, { kind: "msg" }> = {
  kind: "msg",
  id: "m1",
  from: "user",
  time: "10:00",
  text: "hi",
  thread: THREAD,
};

const focus = (bare?: boolean) => (
  <FocusView
    bare={bare}
    root={ROOT}
    thread={THREAD}
    channel={CHANNEL}
    lead={EMP}
    emp={emp}
    human={human}
    resolved={{}}
    work={null}
    running={false}
    onSend={() => {}}
  />
);

describe("issue #660 — the pane's single <main>", () => {
  test("a bare Focus renders no <main> of its own — the host's pane is the only landmark", () => {
    const { container } = render(<MainPane>{focus(true)}</MainPane>);
    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(container.querySelector("main")?.textContent).toContain("Builder");
  });

  test("a bare Focus alone is landmark-free; without bare it mounts its own <main>", () => {
    const bare = render(focus(true));
    expect(bare.container.querySelector("main")).toBeNull();
    cleanup();
    const own = render(focus(false));
    expect(own.container.querySelectorAll("main")).toHaveLength(1);
  });
});
