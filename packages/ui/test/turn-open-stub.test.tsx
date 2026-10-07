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
import type { StickToBottomState } from "use-stick-to-bottom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  Conversation,
  ConversationContent,
  ConversationPin,
} from "../src/components/ai-elements/conversation";
import { landJump } from "../src/conversation/jump-to-hit";
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
    live.phase = "typing";
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

/* The CI failures this guards: a stub→real swap changes the bottom the
   pin is glued to; without the re-pin the port strands above the real
   bottom (ac-570's `extent.top` miss), and the pin's own spring can
   overwrite a jump's native write before its escape event lands. */
describe("the pin tracks stub→real height swaps (#570 CI races)", () => {
  const pinState = (
    over: Record<string, unknown> = {},
    pinOver: Partial<ConversationPin> = {},
  ): ConversationPin => ({
    state: {
      isAtBottom: true,
      escapedFromLock: false,
      calculatedTargetScrollTop: 4321,
      scrollTop: 4000,
      ...over,
    } as unknown as StickToBottomState,
    hydratedAt: { v: 0 },
    escaped: { v: false },
    jumping: { v: 0 },
    repin: vi.fn(),
    ...pinOver,
  });

  test("a born-held row hydrating re-pins to the measured bottom", () => {
    const pin = pinState();
    render(
      <ConversationPin.Provider value={pin}>
        {row(agentDone("m8", "repin probe"), {
          startHeld: true,
          estHeight: 180,
        })}
      </ConversationPin.Provider>,
    );
    /* The mount commit marks the wake AND re-pins — materializing rows
       are the mount wave the open pin's measured-bottom chase rides. */
    expect(pin.repin).toHaveBeenCalledTimes(1);
    expect(pin.hydratedAt.v).toBeGreaterThan(0);
    act(() => FakeIO.latest().fire(true));
    expect(pin.repin).toHaveBeenCalledTimes(2);
  });

  test("the swap leaves an escaped reader alone — the scroll is theirs", () => {
    const pin = pinState({}, { escaped: { v: true } });
    render(
      <ConversationPin.Provider value={pin}>
        {row(agentDone("m9-escaped", "x"), {
          startHeld: true,
          estHeight: 180,
        })}
      </ConversationPin.Provider>,
    );
    act(() => FakeIO.latest().fire(true));
    expect(pin.repin).not.toHaveBeenCalled();
    /* The hydration mark still lands — the guard needs the wave's clock
       even when this row's own re-pin stands down. */
    expect(pin.hydratedAt.v).toBeGreaterThan(0);
  });

  test("a clamp-dead pin on a clamp landing is revived; a reader's scroll position is not", () => {
    /* The library's deferred escape killed the pin (isAtBottom false)
       but the port still sits where a clamp left it — revive it. */
    const clamped = pinState(
      { isAtBottom: false, escapedFromLock: true },
      { isClampTop: () => true },
    );
    const v1 = render(
      <ConversationPin.Provider value={clamped}>
        {row(agentDone("m9-clamp", "x"), { startHeld: true, estHeight: 180 })}
      </ConversationPin.Provider>,
    );
    act(() => FakeIO.latest().fire(true));
    /* The clamp landing revives on the mount commit AND the swap. */
    expect(clamped.repin).toHaveBeenCalledTimes(2);
    v1.unmount();
    /* Dead mid-document — a scrollbar drag the fingerprint can't claim
       — stays dead across commits. */
    const dragged = pinState(
      { isAtBottom: false, escapedFromLock: true },
      { isClampTop: () => false },
    );
    render(
      <ConversationPin.Provider value={dragged}>
        {row(agentDone("m9-drag", "x"), { startHeld: true, estHeight: 180 })}
      </ConversationPin.Provider>,
    );
    act(() => FakeIO.latest().fire(true));
    expect(dragged.repin).not.toHaveBeenCalled();
  });

  /* jump-to-hit: landJump must release the pin BEFORE the native
     scrollIntoView write — the in-flight spring can overwrite it before
     its scroll event dispatches — and re-land the row while hydration
     drift keeps moving it. */
  const rect = (top: number, bottom: number) =>
    ({
      x: 0,
      y: top,
      top,
      left: 0,
      bottom,
      right: 0,
      width: 0,
      height: bottom - top,
      toJSON: () => ({}),
    }) as DOMRect;

  const portOf = (el: Element) => {
    const port = document.createElement("div");
    port.setAttribute("role", "log");
    port.appendChild(el);
    document.body.appendChild(port);
    vi.spyOn(port, "getBoundingClientRect").mockImplementation(() =>
      rect(0, 600),
    );
    return port;
  };

  test("an upward jump escapes the pin synchronously", () => {
    const el = document.createElement("div");
    const port = portOf(el);
    vi.spyOn(el, "getBoundingClientRect").mockImplementation(() =>
      rect(-500, -380),
    );
    const pin = pinState();
    landJump(el, pin);
    expect(pin.state.isAtBottom).toBe(false);
    expect(pin.state.escapedFromLock).toBe(true);
    expect(pin.escaped.v).toBe(true);
    port.remove();
  });

  test("an in-view jump escapes too — the mount race can push it out", () => {
    /* #570: a hit that streams in early sits "in view" at top=0 while the
       doc is still growing — skipping the escape left the pin engaged,
       and the finished doc dragged the port to the bottom over the jump
       (the held-stub target CI failure). The guard's near-bottom reset
       re-engages the pin when a landing really is the bottom edge. */
    const el = document.createElement("div");
    const port = portOf(el);
    vi.spyOn(el, "getBoundingClientRect").mockImplementation(() =>
      rect(300, 420),
    );
    const pin = pinState();
    landJump(el, pin);
    expect(pin.state.isAtBottom).toBe(false);
    expect(pin.state.escapedFromLock).toBe(true);
    expect(pin.escaped.v).toBe(true);
    port.remove();
  });

  test("hydration drift re-lands the row until its offset goes quiet", () => {
    const rafs: FrameRequestCallback[] = [];
    const rafSpy = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((cb) => {
        rafs.push(cb);
        return rafs.length;
      });
    const flush = () => {
      for (const cb of rafs.splice(0)) cb(0);
    };
    let elTop = -500;
    const el = document.createElement("div");
    const port = portOf(el);
    vi.spyOn(el, "getBoundingClientRect").mockImplementation(() =>
      rect(elTop, elTop + 120),
    );
    const siv = vi.fn();
    const sivSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(siv);
    landJump(el, null);
    expect(siv).toHaveBeenCalledTimes(1);
    /* A stub hydration pushed the row below the port — next frame
       re-lands it. */
    elTop = 1000;
    flush();
    expect(siv).toHaveBeenCalledTimes(2);
    /* Re-landed and quiet — the loop retires, later drift can't pull it. */
    elTop = 200;
    for (let i = 0; i < 12; i++) flush();
    elTop = 1000;
    flush();
    expect(siv).toHaveBeenCalledTimes(2);
    sivSpy.mockRestore();
    rafSpy.mockRestore();
    port.remove();
  });
});

/* The CI strand this guards: a stub hydrating shorter clamps scrollTop;
   the browser's coalesced scroll event can dispatch after LATER commits
   already grew scrollHeight — the event reads mid-document, and on the
   old code the guard counted it as a reader escape and let the pin die
   (ac-570 AC-1 on CI: top=3363 with h=22898). Now: scroll deltas alone
   never set `escaped` — the pin's own reader-intent flag — and the
   reinstate chain re-pins while the hydration wake is open. Only input
   (wheel-up here) or a decreasing scrollTop write proves the reader. */
describe("the escape guard quarantines hydration scroll noise (#570)", () => {
  const rafs: FrameRequestCallback[] = [];
  /* Instant re-pins re-queue a frame, and the scroll write rides a
     promise `.then` — drain rAFs and microtasks until both go quiet. */
  const flush = async () => {
    for (let i = 0; i < 40 && rafs.length; i++) {
      for (const cb of rafs.splice(0)) cb(0);
      await Promise.resolve();
    }
  };

  /* Write scrollTop the way a browser layout clamp does — through the
     prototype accessor, bypassing the guard's own-property patch. */
  const rawSet = (el: Element, v: number) => {
    let p: object | null = Object.getPrototypeOf(el);
    let d: PropertyDescriptor | undefined;
    while (p && !d) {
      d = Object.getOwnPropertyDescriptor(p, "scrollTop");
      if (!d) p = Object.getPrototypeOf(p);
    }
    if (d?.set) d.set.call(el, v);
    else (el as HTMLElement).scrollTop = v;
  };

  const mount = () => {
    const pinRef: MutableRefObject<ConversationPin | null> = {
      current: null,
    };
    const rafSpy = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((cb) => {
        rafs.push(cb);
        return rafs.length;
      });
    render(
      <Conversation pinRef={pinRef}>
        <ConversationContent>
          <div>row</div>
        </ConversationContent>
      </Conversation>,
    );
    const wrap = document.querySelector('[role="log"]');
    const sc = wrap?.querySelector("div");
    if (!wrap || !sc || !pinRef.current)
      throw new Error("no pin/scroller mounted");
    /* happy-dom has no layout — pin the geometry the guard reads;
       `h` is the live scrollHeight so commits can shrink/grow it. */
    const geo = { h: 10000 };
    Object.defineProperty(sc, "scrollHeight", {
      get: () => geo.h,
      configurable: true,
    });
    Object.defineProperty(sc, "clientHeight", {
      get: () => 500,
      configurable: true,
    });
    return { sc, pin: pinRef.current, rafSpy, geo };
  };

  test("a stale clamp event during hydration is noise — the chain re-pins", async () => {
    const { sc, pin, rafSpy, geo } = mount();
    const pinState = pin.state;
    pinState.isAtBottom = true;
    pin.hydratedAt.v = performance.now();
    /* Pinned on the edge of the estimated extent. */
    rawSet(sc, 9499);
    sc.dispatchEvent(new Event("scroll"));
    /* The CI strand, step by step: a stub hydrates SHORTER (h 10000→
       8000), the browser clamps scrollTop to the new max 7500 — and the
       scroll event is coalesced behind a GROWTH commit (h→30000) plus
       the library's deferred escape, so it dispatches mid-document. */
    geo.h = 8000;
    pin.noteMax?.();
    rawSet(sc, 7500);
    geo.h = 30000;
    pin.noteMax?.();
    pinState.isAtBottom = false;
    pinState.escapedFromLock = true;
    sc.dispatchEvent(new Event("scroll"));
    expect(pin.escaped.v).toBe(false);
    /* The armed chain re-pins: escapedFromLock cleared, isAtBottom back,
       port written to the measured bottom (scrollTop = h − 1 − ch). */
    await flush();
    expect(pinState.escapedFromLock).toBe(false);
    expect(pinState.isAtBottom).toBe(true);
    expect(sc.scrollTop).toBe(29499);
    rafSpy.mockRestore();
  });

  test("a wheel-up during hydration is the reader — no re-pin", async () => {
    const { sc, pin, rafSpy } = mount();
    pin.state.isAtBottom = true;
    pin.hydratedAt.v = performance.now();
    rawSet(sc, 9499);
    sc.dispatchEvent(new Event("scroll"));
    const wheel = new Event("wheel") as WheelEvent;
    Object.defineProperty(wheel, "deltaY", { value: -120 });
    sc.dispatchEvent(wheel);
    rawSet(sc, 3000);
    sc.dispatchEvent(new Event("scroll"));
    expect(pin.escaped.v).toBe(true);
    await flush();
    expect(pin.state.isAtBottom).toBe(false);
    expect(sc.scrollTop).toBe(3000);
    rafSpy.mockRestore();
  });

  test("a quiet-window up-scroll kills the spring but not the pin's comeback", async () => {
    const { sc, pin, rafSpy } = mount();
    pin.state.isAtBottom = true;
    /* The wave ended long ago — a scrollbar-drag-like up-scroll escapes
       synchronously (#626) yet stays recoverable: `escaped` is input
       territory, the scroll path never sets it. */
    pin.hydratedAt.v = performance.now() - 60_000;
    rawSet(sc, 9499);
    sc.dispatchEvent(new Event("scroll"));
    rawSet(sc, 3000);
    sc.dispatchEvent(new Event("scroll"));
    expect(pin.state.isAtBottom).toBe(false);
    expect(pin.state.escapedFromLock).toBe(true);
    expect(pin.escaped.v).toBe(false);
    rafSpy.mockRestore();
  });

  test("a flag lying off the bottom is re-pinned — the swallowed-escape strand", async () => {
    const { sc, pin, rafSpy } = mount();
    /* The #626/CI shape, deterministically: resizeDifference swallows
       the deferred escape, so the flags still claim a healthy pin while
       the port sits mid-document. No fingerprint can claim the landing
       — the lie itself is the proof: a real scroll would have landed an
       escape, a healthy chase would carry an animation. */
    pin.state.isAtBottom = true;
    pin.state.resizeDifference = 1;
    pin.hydratedAt.v = performance.now();
    rawSet(sc, 9499);
    sc.dispatchEvent(new Event("scroll"));
    rawSet(sc, 3183);
    sc.dispatchEvent(new Event("scroll"));
    expect(pin.escaped.v).toBe(false);
    expect(pin.state.isAtBottom).toBe(true);
    await flush();
    expect(pin.state.isAtBottom).toBe(true);
    expect(pin.state.escapedFromLock).toBe(false);
    expect(sc.scrollTop).toBe(9499);
    rafSpy.mockRestore();
  });

  test("a noise-dead pin mid-document is revived; an escape-path position stands", async () => {
    /* First the noise death: the pin was alive (a bottom scroll event
       proves it), then the flags died without an escape-path event —
       the library's own swallowed/deferred escape — so the armed chain
       revives it wherever it fell. */
    const first = mount();
    first.pin.state.isAtBottom = true;
    first.pin.hydratedAt.v = performance.now();
    rawSet(first.sc, 9499);
    first.sc.dispatchEvent(new Event("scroll"));
    first.pin.state.isAtBottom = false;
    first.pin.state.escapedFromLock = true;
    rawSet(first.sc, 3183);
    first.sc.dispatchEvent(new Event("scroll"));
    await flush();
    expect(first.pin.state.isAtBottom).toBe(true);
    expect(first.sc.scrollTop).toBe(9499);
    first.rafSpy.mockRestore();
    cleanup();

    /* Then the reader's: an off-fingerprint up-scroll OUTSIDE the wake
       escaped through the cold path — its landing is event-attributed
       and a later wave must not pull it. */
    const second = mount();
    second.pin.state.isAtBottom = true;
    second.pin.hydratedAt.v = performance.now() - 60_000;
    rawSet(second.sc, 9499);
    second.sc.dispatchEvent(new Event("scroll"));
    rawSet(second.sc, 3000);
    second.sc.dispatchEvent(new Event("scroll"));
    expect(second.pin.state.isAtBottom).toBe(false);
    /* A new wave opens — the dead pin's position was the reader's. */
    second.pin.hydratedAt.v = performance.now();
    rawSet(second.sc, 2000);
    second.sc.dispatchEvent(new Event("scroll"));
    await flush();
    expect(second.pin.state.isAtBottom).toBe(false);
    expect(second.sc.scrollTop).toBe(2000);
    second.rafSpy.mockRestore();
  });

  test("the top edge never revives — a dead pin at scrollTop 0 stands", async () => {
    const { sc, pin, rafSpy } = mount();
    /* `initial={false}` jump mounts and the reader's own scroll-to-top
       both sit at 0 with a dead pin — a noise revive must never pull
       the port to the bottom from it. */
    pin.state.isAtBottom = false;
    pin.state.escapedFromLock = true;
    pin.hydratedAt.v = performance.now();
    rawSet(sc, 9499);
    sc.dispatchEvent(new Event("scroll"));
    rawSet(sc, 0);
    sc.dispatchEvent(new Event("scroll"));
    await flush();
    expect(sc.scrollTop).toBe(0);
    expect(pin.state.isAtBottom).toBe(false);
    rafSpy.mockRestore();
  });
});
