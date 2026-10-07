// @vitest-environment happy-dom
/* Issue #713 — the ⌘F MutationObserver lives only for the open find
   session and watches only the conversation surface the bar sits in —
   never document.body. AC-1: the observer is created when the bar opens,
   disconnected when it closes, observes the surface the bar is attached
   to, and re-attaches when a surface swap re-seats the bar's host.
   AC-2: with the bar closed, mutations under the thread schedule no find
   work (no observer, no collect); with the bar open, the match count
   tracks rows that stream in mid-session. */

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { DesktopBridge, DesktopFindAction } from "@lilos/contracts/app";
import { setFindSessionOpen } from "@lilos/ui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DesktopFindBar } from "../src/lib/desktop-find";

/* happy-dom reports no layout and no CSS Custom Highlight registry — the
   paint path no-ops on the missing registry, so the count readout (the
   observable contract) is still exercised end to end. */

let findListener: ((action: DesktopFindAction) => void) | undefined;

const installBridge = () => {
  window.lilos = {
    isDesktop: true,
    onFind: (cb) => {
      findListener = cb;
      return () => {
        findListener = undefined;
      };
    },
  } satisfies DesktopBridge;
};

const addRow = (surface: Element, text: string) => {
  const row = document.createElement("div");
  row.setAttribute("data-row", "");
  row.textContent = text;
  act(() => {
    surface.appendChild(row);
  });
  return row;
};

/* MutationObserver batches deliver on a microtask. */
const flushMutations = async () => {
  await act(async () => {});
};

/* The 150 ms re-collect debounce rides vitest's fake timers. */
const runDebounce = () => {
  act(() => {
    vi.advanceTimersByTime(200);
  });
};

const bar = () => document.querySelector("[data-find-bar]");
const input = () =>
  document.querySelector<HTMLInputElement>("[data-find-input]")!;
const count = () => document.querySelector("[data-find-count]")!.textContent;
const openBar = () => act(() => findListener?.("open"));
const typeQuery = (v: string) =>
  fireEvent.change(input(), { target: { value: v } });

const mount = () =>
  render(
    <div data-surface>
      <div data-row>alpha findprobe omega</div>
      <DesktopFindBar />
    </div>,
  );

beforeEach(() => {
  vi.useFakeTimers();
  installBridge();
});

afterEach(() => {
  cleanup();
  findListener = undefined;
  setFindSessionOpen(false);
  delete window.lilos;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("AC-1: the observer is scoped to the open session's own surface", () => {
  test("opening the bar creates one observer on the conversation surface — never document.body", async () => {
    const observeSpy = vi.spyOn(MutationObserver.prototype, "observe");
    const { container } = mount();
    const surface = container.querySelector("[data-surface]")!;

    /* While closed: nothing is observed at all. */
    expect(observeSpy).not.toHaveBeenCalled();

    openBar();
    expect(bar()).not.toBeNull();
    expect(observeSpy).toHaveBeenCalledTimes(1);
    expect(observeSpy).toHaveBeenCalledWith(
      surface,
      expect.objectContaining({
        childList: true,
        characterData: true,
        subtree: true,
      }),
    );
    expect(observeSpy).not.toHaveBeenCalledWith(
      document.body,
      expect.anything(),
    );
  });

  test("closing the bar disconnects the observer — later mutations do no find work", async () => {
    const observeSpy = vi.spyOn(MutationObserver.prototype, "observe");
    const disconnectSpy = vi.spyOn(MutationObserver.prototype, "disconnect");
    const walkerSpy = vi.spyOn(document, "createTreeWalker");
    const { container } = mount();
    const surface = container.querySelector("[data-surface]")!;

    openBar();
    typeQuery("findprobe");
    expect(count()).toBe("1 of 1");
    const walkersAfterOpen = walkerSpy.mock.calls.length;
    expect(walkersAfterOpen).toBeGreaterThan(0);

    fireEvent.click(document.querySelector("[data-find-close]")!);
    expect(bar()).toBeNull();
    expect(disconnectSpy).toHaveBeenCalled();
    expect(observeSpy).toHaveBeenCalledTimes(1); // never re-created

    /* Mutations after close schedule nothing — no debounce, no collect. */
    addRow(surface, "findprobe after close");
    await flushMutations();
    runDebounce();
    expect(walkerSpy.mock.calls.length).toBe(walkersAfterOpen);
  });

  test("a surface swap while the bar is open re-attaches the observer to the new surface", async () => {
    const { container } = mount();
    const oldSurface = container.querySelector("[data-surface]")!;
    openBar();
    typeQuery("findprobe");
    expect(count()).toBe("1 of 1");

    /* The bar's host div is re-seated on a different surface mid-session
       (a Thread ↔ Focus swap that keeps the bar mounted re-parents it):
       the old surface records the removal and the observer follows. */
    const hostEl = bar()!.parentElement!;
    const newSurface = document.createElement("div");
    container.appendChild(newSurface);
    act(() => {
      newSurface.appendChild(hostEl);
    });
    await flushMutations();
    runDebounce();
    /* The find now walks the NEW surface — the probe row stayed behind. */
    expect(count()).toBe("No results");

    /* Mutations on the old surface are no longer watched. */
    addRow(oldSurface, "stale findprobe must not count");
    await flushMutations();
    runDebounce();
    expect(count()).toBe("No results");

    /* A row streaming into the new surface counts again. */
    addRow(newSurface, "new findprobe here");
    await flushMutations();
    runDebounce();
    expect(count()).toBe("1 of 1");
  });
});

describe("AC-2: no find work while closed; the count tracks streams while open", () => {
  test("with the bar closed, mutations under the thread schedule no find work", async () => {
    const observeSpy = vi.spyOn(MutationObserver.prototype, "observe");
    const walkerSpy = vi.spyOn(document, "createTreeWalker");
    const { container } = mount();
    const surface = container.querySelector("[data-surface]")!;

    /* Stream a turn's worth of DOM churn into the surface. */
    addRow(surface, "streamed findprobe token one");
    const row = addRow(surface, "token two");
    act(() => {
      row.textContent = "token two findprobe edited";
    });
    await flushMutations();
    runDebounce();

    /* No observer was ever created and the matcher never ran. */
    expect(observeSpy).not.toHaveBeenCalled();
    expect(walkerSpy).not.toHaveBeenCalled();
  });

  test("with the bar open, the count tracks rows streaming into the surface", async () => {
    const { container } = mount();
    const surface = container.querySelector("[data-surface]")!;
    openBar();
    typeQuery("findprobe");
    expect(count()).toBe("1 of 1");

    addRow(surface, "streamed findprobe lands");
    await flushMutations();
    runDebounce();
    expect(count()).toBe("1 of 2");

    addRow(surface, "another findprobe lands");
    await flushMutations();
    runDebounce();
    expect(count()).toBe("1 of 3");
  });
});
