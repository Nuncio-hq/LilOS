// @vitest-environment happy-dom
/* #770: the thread header's title scrolls away with the conversation, but
   Changes and the ⋯ menu must stay reachable — a slim bar takes them once
   the header is out of view. Each control exists ONCE: the header holds it
   while it shows, the bar after, so there is never a second copy to hover,
   click or find. #886: the header's only named work surface is Changes
   (while files changed); every other tab and the % meter live inside ⋯. */
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
      start={<button type="button">Start work</button>}
      menu={<button type="button">Menu</button>}
      close={<button type="button">Close</button>}
      changes={{ n: "2", onOpen }}
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
      "Changes2",
      "Start work",
      "Menu",
      "Close",
    ]);
  });

  test("scrolled away, the bar carries the title, Changes and ⋯ — each exactly once", () => {
    const { r, header, bar, count, buttons, onOpen } = setup();
    fire([SCROLLED_AWAY]);
    expect(bar()).not.toBeNull();
    expect(bar()?.textContent).toContain("Fix the flaky test");
    expect(buttons(bar())).toEqual(["Changes2", "Menu"]);
    // The header keeps only what is its own: Start work and the close ✕.
    expect(buttons(header())).toEqual(["Start work", "Close"]);
    expect(count('[data-work-tab="changes"]')).toBe(1);
    // The bar's Changes still opens work.
    r.getByRole("button", { name: /Changes/ }).click();
    expect(onOpen).toHaveBeenCalled();
  });

  test("scrolling back up hands the controls back to the header", () => {
    const { header, bar, buttons } = setup();
    fire([SCROLLED_AWAY]);
    expect(bar()).not.toBeNull();
    fire([IN_VIEW]);
    expect(bar()).toBeNull();
    expect(buttons(header())).toContain("Menu");
    expect(buttons(header())).toContain("Changes2");
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

  test("no changes means a bar of title and ⋯ only (D-#19)", () => {
    const r = render(
      <ThreadHeader
        session
        title="T"
        menu={<button type="button">Menu</button>}
      />,
    );
    fire([SCROLLED_AWAY]);
    expect(r.container.querySelector('[data-work-tab="changes"]')).toBeNull();
    expect(
      [...(r.container.querySelectorAll("[data-thread-bar] button") ?? [])].map(
        (b) => b.textContent,
      ),
    ).toEqual(["Menu"]);
  });
});

/* #797: the header is the title and ONE line — status · started · turns on
   the left, Changes and ⋯ on the right — not a stack of rows. #886: the
   rest of the strip's icons moved inside ⋯, so only Changes is named, and
   only while its count is real. */
describe("header line", () => {
  function line() {
    const r = render(
      <ThreadHeader
        session={false}
        title="Fix the flaky test"
        status="working"
        started="11:02"
        turns={3}
        menu={<button type="button">Menu</button>}
        changes={{ n: "2", onOpen: () => {} }}
      />,
    );
    fire([IN_VIEW]);
    return r;
  }

  test("the facts, Changes and ⋯ share one row under the title", () => {
    const r = line();
    const tab = r.container.querySelector('[data-work-tab="changes"]');
    const row = tab?.parentElement?.parentElement;
    expect(row?.textContent).toContain("Started 11:02 · 3 turns");
    expect(row?.textContent).toContain("Menu");
    expect(row?.textContent).toContain("Changes2");
    // The title is above that row, not in it.
    expect(row?.textContent).not.toContain("Fix the flaky test");
    expect(r.container.querySelector("[data-session-title]")).not.toBeNull();
  });
});
