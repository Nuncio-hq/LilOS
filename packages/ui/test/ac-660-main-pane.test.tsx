// @vitest-environment happy-dom
/* Issue #660 — the DM pane's <main> landmark is one DOM node the page owns:
   DmPage mounts <MainPane> itself and renders both views `bare` into it, so
   send → /focus reconciles the SAME element instead of swapping one view's
   own <main> for the other's. The flake this guards: a resolved
   elementHandle went detached mid-measure (boundingBox → null) because the
   old <main> unmounted under it — e2e/dm-layout.spec.ts AC-660 samples the
   real page; this is the fast check of the same invariant.

   The host below mirrors DmPage's two return shapes: a shared
   `div.flex` root whose first child is <MainPane> in both branches. */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { EmployeeHome } from "../src/employee/employee-home";
import { FocusView } from "../src/focus/focus-view";
import { MainPane } from "../src/shell/main-pane";
import type {
  Channel,
  EmpFn,
  Employee,
  HumanFn,
  Msg,
  Thread,
  WsPick,
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
const NO_WS: WsPick = { folder: null, base: "main", mode: "new" };

const CHANNEL: Channel = { id: "dm-e1", name: "Builder", employees: ["e1"], dm: true };
const THREAD: Thread = { session: "s_1", replies: [] };
const ROOT: Extract<Msg, { kind: "msg" }> = {
  kind: "msg",
  id: "m1",
  from: "user",
  time: "10:00",
  text: "hi",
  thread: THREAD,
};

/* The feed↔Focus swap, shaped exactly like DmPage: same `div.flex` root,
   <MainPane> at child index 0 in both branches (the thread panel is the
   sibling after it). `bare` is what keeps the views from mounting a
   second landmark inside the pane. */
const Host = ({ focus }: { focus: boolean }) =>
  focus ? (
    <div className="flex min-h-0 min-w-0 flex-1">
      <MainPane>
        <FocusView
          bare
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
      </MainPane>
    </div>
  ) : (
    <div className="flex min-h-0 min-w-0 flex-1">
      <MainPane>
        <EmployeeHome
          bare
          e={EMP}
          feed={[]}
          threadId={null}
          emp={emp}
          human={human}
          onNav={() => {}}
          onProfile={() => {}}
          onOpen={() => {}}
          onSend={() => {}}
          panelOpen={false}
          onPanel={() => {}}
          folders={[]}
          pick={NO_WS}
          setPick={() => {}}
        />
      </MainPane>
      <div data-thread-panel />
    </div>
  );

describe("issue #660 — the DM pane's single <main>", () => {
  test("AC-660 <main> is the same DOM node across a feed↔Focus swap", () => {
    const { container, rerender } = render(<Host focus={false} />);
    const feedMain = container.querySelector("main");
    expect(feedMain).not.toBeNull();
    /* The feed really rendered — the swap below is a real view change. */
    expect(feedMain!.textContent).toContain("Builder");

    rerender(<Host focus={true} />);
    const focusMain = container.querySelector("main");
    expect(focusMain).toBe(feedMain);
    /* Exactly one landmark: Focus rendered INTO the pane, not a second
       <main> nested inside it. */
    expect(container.querySelectorAll("main")).toHaveLength(1);

    rerender(<Host focus={false} />);
    expect(container.querySelector("main")).toBe(feedMain);
    expect(container.querySelectorAll("main")).toHaveLength(1);
  });

  test("without bare each view mounts its own <main> — the pre-#660 shape that detached the node", () => {
    const { container, rerender } = render(<EmployeeHome
      e={EMP}
      feed={[]}
      threadId={null}
      emp={emp}
      human={human}
      onNav={() => {}}
      onProfile={() => {}}
      onOpen={() => {}}
      onSend={() => {}}
      panelOpen={false}
      onPanel={() => {}}
      folders={[]}
      pick={NO_WS}
      setPick={() => {}}
    />);
    const feedMain = container.querySelector("main");
    expect(feedMain).not.toBeNull();

    rerender(
      <FocusView
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
      />,
    );
    const focusMain = container.querySelector("main");
    /* Different node: the feed's <main> unmounted with the view — the
       detached-handle flake. Documents why the bare contract matters. */
    expect(focusMain).not.toBe(feedMain);
    expect(feedMain!.isConnected).toBe(false);
  });

  test("bare views render no <main> of their own — a dropped bare prop nests a second landmark", () => {
    /* If `bare` is ever lost on either view the pane ends up with TWO
       <main> elements; the count is the tripwire. */
    const { container } = render(
      <MainPane>
        <EmployeeHome
          e={EMP}
          feed={[]}
          threadId={null}
          emp={emp}
          human={human}
          onNav={() => {}}
          onProfile={() => {}}
          onOpen={() => {}}
          onSend={() => {}}
          panelOpen={false}
          onPanel={() => {}}
          folders={[]}
          pick={NO_WS}
          setPick={() => {}}
        />
      </MainPane>,
    );
    expect(container.querySelectorAll("main")).toHaveLength(2);
  });
});
