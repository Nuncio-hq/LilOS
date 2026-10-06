// @vitest-environment happy-dom
/* AC tests for issue #570: a lazy thread's first mount renders only an
   estimated-height tail — rows above `openTailStart` start as stubs with
   their `estTurnHeight` px instead of mounting once and stubbing behind
   the observer (#430's measured path). The stub keeps every spec anchor
   (`data-msg`, `data-agentturn`/`data-userturn`, `data-turnsettled`), and
   mounting out of it counts as a remount (`data-remount` — no rise
   replay). The IntersectionObserver is faked so the test drives entries
   by hand, same as turn-find-unstub.test.tsx. */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  estTurnHeight,
  OPEN_TAIL_PX,
  openTailStart,
  type TurnActs,
  TurnRow,
} from "../src/conversation/turn-rows";
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

/* Re-holds measure the laid-out row (#537); happy-dom reports 0
   everywhere, so pin a height for the mount → hold path. */
HTMLElement.prototype.getBoundingClientRect = () =>
  ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 120,
    right: 0,
    width: 0,
    height: 120,
    toJSON: () => ({}),
  }) as DOMRect;

/* Controllable IntersectionObserver — the test drives entries by hand. */
class FakeIO {
  static all: FakeIO[] = [];
  static latest() {
    const io = FakeIO.all[FakeIO.all.length - 1];
    if (!io) throw new Error("no IntersectionObserver created yet");
    return io;
  }
  el?: Element;
  constructor(private cb: IntersectionObserverCallback) {
    FakeIO.all.push(this);
  }
  observe(el: Element) {
    this.el = el;
  }
  unobserve() {}
  disconnect() {
    this.el = undefined;
  }
  fire(isIntersecting: boolean) {
    if (!this.el) throw new Error("observer not observing");
    this.cb(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}
globalThis.IntersectionObserver =
  FakeIO as unknown as typeof IntersectionObserver;

afterEach(cleanup);
beforeEach(() => {
  FakeIO.all = [];
});
afterEach(() => {
  vi.useRealTimers();
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
const acts: MutableRefObject<TurnActs> = { current: {} };

const agentDone = (id: string, text: string): Reply => ({
  id,
  turnId: `t-${id}`,
  from: EMP.id,
  time: "",
  text,
  phase: "done",
});
const userMsg = (id: string, text: string): Reply => ({
  id,
  from: "oscar",
  time: "",
  text,
});

const row = (r: Reply, extra: Partial<Parameters<typeof TurnRow>[0]> = {}) => (
  <TurnRow
    frame="panel"
    r={r}
    i={0}
    lastTurn
    lastRow
    flashed={false}
    lazy
    scrollTarget={false}
    running={false}
    emp={emp}
    human={human}
    resolved={{}}
    work={null}
    acts={acts}
    {...extra}
  />
);

const heldStub = (c: HTMLElement) => c.querySelector("[data-held-stub]");

describe("AC-1: rows above the open tail start as estimated stubs — no mount", () => {
  test("a startHeld lazy row mounts a stub at its estimate, keeping anchors", () => {
    const { container } = render(
      row(agentDone("m1", "never-mounted probe text"), {
        startHeld: true,
        estHeight: 180,
      }),
    );
    /* No observer callback has run — the stub is the FIRST render, not a
       post-mount hold. */
    const stub = heldStub(container);
    expect(stub).toBeTruthy();
    expect((stub as HTMLElement).style.height).toBe("180px");
    /* Anchors a stub always carries: scroll/jump target + turn kind +
       settled marker — the row never mounted to produce them. */
    const wrap = container.querySelector("[data-msg='m1']");
    expect(wrap).toBeTruthy();
    expect(wrap?.getAttribute("data-lazy")).not.toBeNull();
    expect(stub?.querySelector("[data-agentturn]")).toBeTruthy();
    expect(stub?.querySelector("[data-turnsettled]")).toBeTruthy();
    /* …and no row content exists. */
    expect(container.textContent).not.toContain("never-mounted probe text");
  });

  test("keep wins: the scroll target / a live turn never starts held", () => {
    const live = agentDone("m2", "streaming answer");
    live.phase = "streaming";
    const { container } = render(
      row(live, { startHeld: true, estHeight: 180 }),
    );
    expect(heldStub(container)).toBeFalsy();
    expect(container.textContent).toContain("streaming answer");

    const target = render(
      row(agentDone("m3", "hit text"), {
        startHeld: true,
        estHeight: 180,
        scrollTarget: true,
      }),
    );
    expect(heldStub(target.container)).toBeFalsy();
    expect(target.container.textContent).toContain("hit text");
  });

  test("openTailStart covers ≥ the tail estimate; estTurnHeight scales with content", () => {
    const heights = [100, 200, 300, 400, 5000];
    /* Walk back until ≥ px covered: 5000 alone covers 3200 → tail = last
       row only. */
    expect(openTailStart(heights)).toBe(4);
    /* Small tail: all heights needed. */
    expect(openTailStart([10, 10, 10], 25)).toBe(0);
    expect(openTailStart([], OPEN_TAIL_PX)).toBe(0);

    const light = agentDone("a", "ok");
    const heavy = agentDone("b", `${"x".repeat(400)}\n\n${"y".repeat(400)}`);
    expect(estTurnHeight(heavy, true, "panel")).toBeGreaterThan(
      estTurnHeight(light, true, "panel"),
    );
    /* A user row is a compact Row — cheaper than an AgentTurn. */
    expect(estTurnHeight(userMsg("u", "hello"), false, "panel")).toBeLessThan(
      estTurnHeight(agentDone("a", "hello"), true, "panel"),
    );
    /* Wider focus column wraps less → shorter rows. */
    const wrapped = agentDone("w", "word ".repeat(400));
    expect(estTurnHeight(wrapped, true, "focus")).toBeLessThan(
      estTurnHeight(wrapped, true, "panel"),
    );
  });
});

describe("AC-2: held-on-mount rows behave like held rows — mount on view, find un-stubs", () => {
  test("scrolling a born-held row into view mounts it as a remount", () => {
    const { container } = render(
      row(agentDone("m4", "scrolled-in probe"), {
        startHeld: true,
        estHeight: 180,
      }),
    );
    expect(heldStub(container)).toBeTruthy();
    act(() => FakeIO.latest().fire(true));
    expect(heldStub(container)).toBeFalsy();
    expect(container.textContent).toContain("scrolled-in probe");
    /* Born-held counts as held — the mount is a remount: data-remount
       keeps the rise animation from replaying (theme.css). */
    expect(
      container.querySelector("[data-msg='m4']")?.hasAttribute("data-remount"),
    ).toBe(true);
  });

  test("a born-held row leaving the window re-holds at its MEASURED height", () => {
    const { container } = render(
      row(agentDone("m5", "measure me"), {
        startHeld: true,
        estHeight: 180,
      }),
    );
    act(() => FakeIO.latest().fire(true));
    expect(heldStub(container)).toBeFalsy();
    act(() => FakeIO.latest().fire(false));
    const stub = heldStub(container);
    expect(stub).toBeTruthy();
    /* The 120px the row really measured at replaces the 180px estimate. */
    expect((stub as HTMLElement).style.height).toBe("120px");
  });

  test("Cmd+F mounts a born-held row — browser find can match its text", () => {
    const { container } = render(
      row(agentDone("m6", "findprobe born-held"), {
        startHeld: true,
        estHeight: 180,
      }),
    );
    expect(container.textContent).not.toContain("findprobe born-held");
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(heldStub(container)).toBeFalsy();
    expect(container.textContent).toContain("findprobe born-held");
  });

  test("a held-stub row keeps its data-msg anchor for jump-to-message", () => {
    const { container } = render(
      row(agentDone("m7", "anchor probe"), {
        startHeld: true,
        estHeight: 180,
      }),
    );
    /* The data-msg wrapper stays mounted — the view's scrollIntoView can
       land on it and the IO mount makes it real the same frame. */
    const anchor = container.querySelector("[data-msg='m7']");
    expect(anchor).toBeTruthy();
    expect(anchor?.querySelector("[data-held-stub]")).toBeTruthy();
  });
});
