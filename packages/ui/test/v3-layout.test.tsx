// @vitest-environment happy-dom
/* The shell's layout rules (#793): limits that keep the page readable when the
   window shrinks, widths remembered per device, and a divider that is a real
   keyboard-operable separator. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  PAGE_MIN,
  peekLimits,
  SIDEBAR_W,
  shellSizes,
  useLayoutPrefs,
} from "../src/v3/v3-layout-prefs";
import { ResizeHandle } from "../src/v3/v3-resize";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("shellSizes", () => {
  const roomy = { sidebarW: 236, peekW: undefined, hidden: false };

  test("a roomy window: the default sidebar, a peek of 58% up to 760", () => {
    const s = shellSizes(1440, roomy);
    expect(s.side.w).toBe(236);
    expect(s.peek.w).toBeCloseTo((1440 - 236) * 0.58, 5);
    expect(s.peek.min).toBe(360);
    expect(s.peek.max).toBe(Math.round((1440 - 236) * 0.7));
    expect(shellSizes(2400, roomy).peek.w).toBe(760);
  });

  test("a chosen width is kept within the limits", () => {
    const s = shellSizes(1440, { ...roomy, sidebarW: 300, peekW: 500 });
    expect(s.side.w).toBe(300);
    expect(s.peek.w).toBe(500);
    // Too wide a peek is held at 70% of what the sidebar leaves.
    expect(shellSizes(1440, { ...roomy, peekW: 2000 }).peek.w).toBe(
      shellSizes(1440, roomy).peek.max,
    );
    // Too narrow is held at the 360 floor.
    expect(shellSizes(1440, { ...roomy, peekW: 100 }).peek.w).toBe(360);
  });

  test("a hidden sidebar hands its room to the page and peek", () => {
    const docked = shellSizes(1440, roomy).peek.max;
    const hidden = shellSizes(1440, { ...roomy, hidden: true }).peek.max;
    expect(hidden).toBeGreaterThan(docked);
    expect(hidden).toBe(Math.round(1440 * 0.7));
  });

  test("the page keeps its minimum: the peek gives way first, then the sidebar", () => {
    const small = shellSizes(900, { ...roomy, peekW: 800 });
    const page = 900 - small.side.w - small.peek.w;
    expect(page).toBeGreaterThanOrEqual(PAGE_MIN);
    expect(small.peek.w).toBeLessThan(360);
    // A tiny window shrinks the sidebar's own ceiling, never below 200.
    expect(shellSizes(500, { ...roomy, sidebarW: 360 }).side.max).toBe(
      SIDEBAR_W.min,
    );
    expect(shellSizes(500, { ...roomy, sidebarW: 360 }).side.w).toBe(
      SIDEBAR_W.min,
    );
  });

  test("before the window is measured only the hard limits apply", () => {
    const s = shellSizes(0, { ...roomy, sidebarW: 999, peekW: 5000 });
    expect(s.side.w).toBe(SIDEBAR_W.max);
    expect(s.peek.w).toBe(760);
  });
});

describe("peekLimits", () => {
  test("never asks the page for less than its minimum while it can help it", () => {
    for (const area of [700, 800, 1000, 1400, 2000]) {
      const { min, max } = peekLimits(area);
      expect(min).toBeLessThanOrEqual(max);
      expect(area - max).toBeGreaterThanOrEqual(PAGE_MIN);
    }
  });
});

describe("useLayoutPrefs", () => {
  test("starts at the defaults and remembers each choice", () => {
    const { result, unmount } = renderHook(() => useLayoutPrefs());
    expect(result.current.sidebarW).toBe(236);
    expect(result.current.peekW).toBeUndefined();
    expect(result.current.hidden).toBe(false);

    act(() => {
      result.current.setSidebarW(300);
      result.current.setPeekW(520);
      result.current.setHidden(true);
    });
    expect(localStorage.getItem("lilos-v3-sidebar-w")).toBe("300");
    expect(localStorage.getItem("lilos-v3-peek-w")).toBe("520");
    expect(localStorage.getItem("lilos-v3-sidebar-hidden")).toBe("1");
    unmount();

    // Another visit to the same device.
    const again = renderHook(() => useLayoutPrefs()).result.current;
    expect(again.sidebarW).toBe(300);
    expect(again.peekW).toBe(520);
    expect(again.hidden).toBe(true);
  });

  test("resetting forgets the width, so the default can change later", () => {
    const { result } = renderHook(() => useLayoutPrefs());
    act(() => {
      result.current.setSidebarW(300);
      result.current.setPeekW(520);
      result.current.setHidden(true);
    });
    act(() => {
      result.current.setSidebarW(undefined);
      result.current.setPeekW(undefined);
      result.current.setHidden(false);
    });
    expect(result.current.sidebarW).toBe(236);
    expect(result.current.peekW).toBeUndefined();
    expect(localStorage.getItem("lilos-v3-sidebar-w")).toBeNull();
    expect(localStorage.getItem("lilos-v3-peek-w")).toBeNull();
    expect(localStorage.getItem("lilos-v3-sidebar-hidden")).toBeNull();
  });

  test("a stored width outside the limits, or garbage, is not trusted", () => {
    localStorage.setItem("lilos-v3-sidebar-w", "9999");
    localStorage.setItem("lilos-v3-peek-w", "not a number");
    const { result } = renderHook(() => useLayoutPrefs());
    expect(result.current.sidebarW).toBe(SIDEBAR_W.max);
    expect(result.current.peekW).toBeUndefined();
  });

  test("blocked storage leaves the layout working, just not remembered", () => {
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    const { result } = renderHook(() => useLayoutPrefs());
    expect(result.current.sidebarW).toBe(236);
    spy.mockRestore();
  });
});

describe("ResizeHandle", () => {
  function setup(grows: "right" | "left", value = 300) {
    const onChange = vi.fn();
    const onReset = vi.fn();
    render(
      <ResizeHandle
        label="Resize panel"
        value={value}
        min={200}
        max={360}
        grows={grows}
        edge="before"
        onChange={onChange}
        onReset={onReset}
      />,
    );
    return {
      sep: screen.getByRole("separator", { name: "Resize panel" }),
      onChange,
      onReset,
    };
  }

  test("is a vertical separator that reports its value and limits", () => {
    const { sep } = setup("right");
    expect(sep.getAttribute("aria-orientation")).toBe("vertical");
    expect(sep.getAttribute("aria-valuenow")).toBe("300");
    expect(sep.getAttribute("aria-valuemin")).toBe("200");
    expect(sep.getAttribute("aria-valuemax")).toBe("360");
    expect(sep.tabIndex).toBe(0);
  });

  test("arrows move the divider where they point; Shift leaps; Home/End jump", () => {
    const side = setup("right");
    fireEvent.keyDown(side.sep, { key: "ArrowRight" });
    expect(side.onChange).toHaveBeenLastCalledWith(316);
    fireEvent.keyDown(side.sep, { key: "ArrowLeft", shiftKey: true });
    expect(side.onChange).toHaveBeenLastCalledWith(236);
    fireEvent.keyDown(side.sep, { key: "End" });
    expect(side.onChange).toHaveBeenLastCalledWith(360);
    fireEvent.keyDown(side.sep, { key: "Home" });
    expect(side.onChange).toHaveBeenLastCalledWith(200);
    cleanup();

    // The peek is on the divider's right: moving the divider left widens it.
    const peek = setup("left");
    fireEvent.keyDown(peek.sep, { key: "ArrowLeft" });
    expect(peek.onChange).toHaveBeenLastCalledWith(316);
    fireEvent.keyDown(peek.sep, { key: "ArrowRight" });
    expect(peek.onChange).toHaveBeenLastCalledWith(284);
  });

  test("the limits clamp a nudge", () => {
    const { sep, onChange } = setup("right", 355);
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(360);
  });

  test("other keys are left alone; double-click resets", () => {
    const { sep, onChange, onReset } = setup("right");
    expect(fireEvent.keyDown(sep, { key: "a" })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.doubleClick(sep);
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
