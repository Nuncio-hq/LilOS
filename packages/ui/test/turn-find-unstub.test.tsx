// @vitest-environment happy-dom
/* AC tests for issue #512: a held (stubbed) turn row carries no text nodes
   (#430), so browser find-in-page can't match inside it. A find chord —
   Cmd/Ctrl+F, Cmd/Ctrl+G, F3 — opens a ~10 s window in which every held row
   mounts its real content; the window re-arms on each chord and rows
   re-stub when it lapses. The chord is only observed, never consumed —
   the browser's own find bar must still open. The window is driven by
   vitest fake timers (the injectable clock — never a real 10 s sleep). */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type TurnActs, TurnRow } from "../src/conversation/turn-rows";
import type { EmpFn, HumanFn, Reply } from "../src/types";

/* The find window per the issue (#512): ~10 s after the last find chord. */
const FIND_WINDOW_MS = 10_000;

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

/* LazyShell only stubs a laid-out row (#537: the stub keeps the row's
   exact `getBoundingClientRect().height`, so it must read non-zero);
   happy-dom reports 0 everywhere, so pin a height. */
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
  /* Observers currently attached — none while the find window is open. */
  static live() {
    return FakeIO.all.filter((io) => io.el);
  }
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
  vi.useFakeTimers();
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

const row = (r: Reply) => (
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
  />
);

const heldStub = (c: HTMLElement) => c.querySelector("[data-held-stub]");

describe("AC-1: a find chord mounts held rows, the window lapse re-stubs them", () => {
  test("Cmd+F un-stubs the held row; ~10 s later it re-stubs", () => {
    const { container } = render(row(agentDone("m1", "findprobe phrase")));
    expect(heldStub(container)).toBeFalsy();
    expect(container.textContent).toContain("findprobe phrase");

    /* The row leaves the viewport → held stub, text gone. */
    act(() => FakeIO.latest().fire(false));
    expect(heldStub(container)).toBeTruthy();
    expect(container.textContent).not.toContain("findprobe phrase");

    /* Cmd+F: the window opens — the held row mounts its real content. */
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(heldStub(container)).toBeFalsy();
    expect(container.textContent).toContain("findprobe phrase");

    /* The window lapses → the observer re-engages and the row re-stubs. */
    act(() => {
      vi.advanceTimersByTime(FIND_WINDOW_MS + 100);
    });
    act(() => FakeIO.latest().fire(false));
    expect(heldStub(container)).toBeTruthy();
    expect(container.textContent).not.toContain("findprobe phrase");
  });

  test("Ctrl+F / Cmd+G / F3 open the window; a chord inside it re-arms (~10 s from the last)", () => {
    const { container } = render(row(agentDone("m2", "findprobe beta")));
    act(() => FakeIO.latest().fire(false));
    expect(heldStub(container)).toBeTruthy();

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(heldStub(container)).toBeFalsy();
    /* While the window is open the row holds no observer. */
    expect(FakeIO.live()).toHaveLength(0);

    /* Re-arm at t=6 s (Cmd+G): the original t=10 s deadline must not
       close the window — at t=11 s there is still no live observer. */
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    fireEvent.keyDown(window, { key: "g", metaKey: true });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(FakeIO.live()).toHaveLength(0);
    expect(heldStub(container)).toBeFalsy();

    /* F3 (find-next) re-arms again at t=11 s → lapse at t=21 s. */
    fireEvent.keyDown(window, { key: "F3" });
    act(() => {
      vi.advanceTimersByTime(FIND_WINDOW_MS + 100);
    });
    expect(FakeIO.live()).not.toHaveLength(0);
    act(() => FakeIO.latest().fire(false));
    expect(heldStub(container)).toBeTruthy();
  });
});

describe("AC-2: the chord is only observed — the browser find bar still opens", () => {
  test("find chords are never consumed; unrelated keys don't open the window", () => {
    const { container } = render(row(agentDone("m3", "findprobe gamma")));
    act(() => FakeIO.latest().fire(false));
    expect(heldStub(container)).toBeTruthy();

    /* fireEvent returns false only when preventDefault ran — the listener
       must leave the chord untouched so the browser find bar opens. */
    expect(fireEvent.keyDown(window, { key: "f", metaKey: true })).toBe(true);
    expect(
      fireEvent.keyDown(window, {
        key: "g",
        metaKey: true,
        shiftKey: true,
      }),
    ).toBe(true);

    act(() => {
      vi.advanceTimersByTime(FIND_WINDOW_MS + 100);
    });
    act(() => FakeIO.latest().fire(false));
    expect(heldStub(container)).toBeTruthy();

    /* Plain typing, other chords and bare F-keys don't mount anything. */
    fireEvent.keyDown(window, { key: "f" });
    fireEvent.keyDown(window, { key: "c", metaKey: true });
    fireEvent.keyDown(window, { key: "Enter" });
    act(() => FakeIO.latest().fire(false));
    expect(heldStub(container)).toBeTruthy();
    expect(container.textContent).not.toContain("findprobe gamma");
  });
});
