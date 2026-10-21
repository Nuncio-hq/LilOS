// @vitest-environment happy-dom
/* #770: the thread header's title scrolls away with the conversation, but the
   work strip, the context meter and the ⋯ menu must stay reachable — a slim
   bar takes them once the header is out of view. Each control exists ONCE:
   the header holds it while it shows, the bar after, so there is never a
   second copy to hover, click or find. */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ThreadHeader } from "../src/thread/thread-header";

type Entry = {
  isIntersecting: boolean;
  boundingClientRect: { height: number; bottom: number };
  rootBounds: { top: number };
};
let fire: (entries: Entry[]) => void = () => {};

beforeEach(() => {
  globalThis.IntersectionObserver = class {
    constructor(cb: (entries: Entry[]) => void) {
      fire = (entries) => act(() => cb(entries));
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
});
afterEach(cleanup);

const IN_VIEW: Entry = {
  isIntersecting: true,
  boundingClientRect: { height: 120, bottom: 150 },
  rootBounds: { top: 0 },
};
const SCROLLED_AWAY: Entry = {
  isIntersecting: false,
  boundingClientRect: { height: 120, bottom: -40 },
  rootBounds: { top: 0 },
};

function setup() {
  const onOpen = vi.fn();
  const r = render(
    <ThreadHeader
      session={false}
      title="Fix the flaky test"
      meter={<button type="button">Meter</button>}
      start={<button type="button">Start work</button>}
      menu={<button type="button">Menu</button>}
      close={<button type="button">Close</button>}
      strip={{ tabs: [{ id: "details", label: "Details" }], onOpen }}
    />,
  );
  const header = () => r.container.querySelector("[data-thread-header]");
  const bar = () => r.container.querySelector("[data-thread-bar]");
  const count = (sel: string) => r.container.querySelectorAll(sel).length;
  const buttons = (root: Element | null) =>
    [...(root?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
  return { r, onOpen, header, bar, count, buttons };
}

describe("thread bar", () => {
  test("while the header shows, it holds every control and there is no bar", () => {
    const { header, bar, buttons } = setup();
    fire([IN_VIEW]);
    expect(bar()).toBeNull();
    expect(buttons(header())).toEqual([
      "Details",
      "Meter",
      "Start work",
      "Menu",
      "Close",
    ]);
  });

  test("scrolled away, the bar carries the title, strip, meter and menu — each exactly once", () => {
    const { r, header, bar, count, buttons, onOpen } = setup();
    fire([SCROLLED_AWAY]);
    expect(bar()).not.toBeNull();
    expect(bar()?.textContent).toContain("Fix the flaky test");
    expect(buttons(bar())).toEqual(["Details", "Meter", "Menu"]);
    // The header keeps only what is its own: Start work and the close ✕.
    expect(buttons(header())).toEqual(["Start work", "Close"]);
    expect(count("[data-work-strip]")).toBe(1);
    // The bar's strip still opens work.
    r.getByRole("button", { name: "Details" }).click();
    expect(onOpen).toHaveBeenCalledWith("details");
  });

  test("the bar's strip names its buttons even where labels step aside to icons", () => {
    const { bar } = setup();
    fire([SCROLLED_AWAY]);
    const tab = bar()?.querySelector('[data-work-tab="details"]');
    expect(tab?.textContent).toBe("Details");
    expect(tab?.querySelector(".sr-only")).not.toBeNull();
  });

  test("scrolling back up hands the controls back to the header", () => {
    const { header, bar, buttons } = setup();
    fire([SCROLLED_AWAY]);
    expect(bar()).not.toBeNull();
    fire([IN_VIEW]);
    expect(bar()).toBeNull();
    expect(buttons(header())).toContain("Meter");
    expect(buttons(header())).toContain("Details");
  });

  test("of several queued records only the newest says where the header is", () => {
    const { bar } = setup();
    // Observed in view, then scrolled out before the callback ran.
    fire([IN_VIEW, SCROLLED_AWAY]);
    expect(bar()).not.toBeNull();
    fire([SCROLLED_AWAY, IN_VIEW]);
    expect(bar()).toBeNull();
  });

  test("a header with no box (a hidden panel) is not scrolled away", () => {
    const { bar } = setup();
    fire([
      {
        isIntersecting: false,
        boundingClientRect: { height: 0, bottom: 0 },
        rootBounds: { top: 0 },
      },
    ]);
    expect(bar()).toBeNull();
  });

  test("no strip means a bar of title, meter and menu only (D-#19)", () => {
    const r = render(
      <ThreadHeader
        session
        title="T"
        meter={<button type="button">Meter</button>}
        menu={<button type="button">Menu</button>}
      />,
    );
    fire([SCROLLED_AWAY]);
    expect(r.container.querySelector("[data-work-strip]")).toBeNull();
    expect(
      [...(r.container.querySelectorAll("[data-thread-bar] button") ?? [])].map(
        (b) => b.textContent,
      ),
    ).toEqual(["Meter", "Menu"]);
  });
});

/* #797: the header is the title and ONE line — status · started · turns on
   the left, the work strip and the meter and ⋯ on the right — not a stack of
   rows. (Wide or narrow, which row the strip takes is a container query the
   test DOM does not run; what it can pin is who shares the line.) */
describe("header line", () => {
  function line() {
    const r = render(
      <ThreadHeader
        session={false}
        title="Fix the flaky test"
        status="working"
        started="11:02"
        turns={3}
        meter={<button type="button">Meter</button>}
        menu={<button type="button">Menu</button>}
        strip={{
          tabs: [
            { id: "changes", label: "Changes", meta: "2" },
            { id: "pr", label: "PR", meta: "#12 · merged" },
            { id: "details", label: "Details" },
          ],
          onOpen: () => {},
        }}
      />,
    );
    fire([IN_VIEW]);
    return r;
  }

  test("the facts, the strip, the meter and ⋯ share one row under the title", () => {
    const r = line();
    const strip = r.container.querySelector("[data-work-strip]");
    const row = strip?.parentElement;
    expect(row?.textContent).toContain("Started 11:02 · 3 turns");
    expect(row?.textContent).toContain("Meter");
    expect(row?.textContent).toContain("Menu");
    // The title is above that row, not in it.
    expect(row?.textContent).not.toContain("Fix the flaky test");
    expect(r.container.querySelector("[data-session-title]")).not.toBeNull();
  });

  test("where labels step aside to icons a count stays, a label-long meta goes", () => {
    const r = line();
    const tab = (id: string) =>
      r.container.querySelector(`[data-work-tab="${id}"]`);
    const quiet = (el: Element | null | undefined) =>
      el?.className.includes("sr-only");
    // Every button keeps its name (the label is still in the DOM)…
    expect(quiet(tab("changes")?.children[1])).toBe(true);
    expect(tab("changes")?.textContent).toBe("Changes2");
    // …a bare number is a count and stays beside the icon…
    expect(quiet(tab("changes")?.children[2])).toBe(false);
    // …"#12 · merged" is as long as a label and steps aside with it.
    expect(quiet(tab("pr")?.children[2])).toBe(true);
  });
});
