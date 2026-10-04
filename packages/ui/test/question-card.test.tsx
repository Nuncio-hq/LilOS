// @vitest-environment happy-dom
/* FIX #515 r5 — Hermes: a pending question card always arrives usable:
   the options cap keeps the whole card ≤ its scrollport ("a card taller
   than the port should never be possible"), and when a question arrives
   after an answer the arrival-align lifts it until [data-question-actions]
   (the input + Skip row) sits inside the port. happy-dom has no layout,
   so geometry is mocked: element rects derive from port.scrollTop, which
   makes the align's scrollTop writes move the mocked card. */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  QuestionCard,
  questionOptionCap,
} from "../src/conversation/question-card";
import type { QuestionAsk } from "../src/types";

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

const Q5: QuestionAsk = {
  id: "q-test",
  question: "Where should it land?",
  freeText: true,
  options: [0, 1, 2, 3, 4].map((i) => ({
    id: `o${i}`,
    label: `Option ${i}`,
    description: "desc",
  })),
};

const rect = (top: number, height: number): DOMRect =>
  ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 320,
    width: 320,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

/* box whose top tracks `topFn()` at call time — wire topFn to
   `base - port.scrollTop` so align scrolls move it like real content. */
const mockBox = (el: Element, topFn: () => number, height: number) => {
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => rect(topFn(), height),
    configurable: true,
  });
};
const mockDim = (el: Element, props: Record<string, number>) => {
  for (const [k, v] of Object.entries(props))
    Object.defineProperty(el, k, { value: v, configurable: true });
};

const PORT_H = 441; // the 1288x700 thread port Hermes shot
const CHROME = 210; // header + question + actions, everything but the list
const LIST_NATURAL = 360; // five ~72px option tiles
const CARD_H = 384; // post-cap card height (210 + capped list)

/* Mounts an interactive card inside a fake scrollport, mocks the metrics
   the cap + align effects read, then re-fires measurement via resize. */
const mountCard = (cardTop0: number, portScroll0: number) => {
  render(
    <div data-testid="port" style={{ overflowY: "auto" }}>
      <QuestionCard
        q={Q5}
        viewer="You"
        agent="Reviewer"
        resolved={{}}
        setResolved={() => {}}
      />
    </div>,
  );
  const port = document.querySelector<HTMLElement>('[data-testid="port"]')!;
  const card = document.querySelector<HTMLElement>("[data-ask-id]")!;
  const list = document.querySelector<HTMLElement>("[data-question-options]")!;
  const actions = document.querySelector<HTMLElement>(
    "[data-question-actions]",
  )!;
  port.scrollTop = portScroll0;
  mockDim(port, { clientHeight: PORT_H });
  mockBox(port, () => 0, PORT_H);
  mockBox(card, () => cardTop0 - port.scrollTop, CARD_H);
  mockDim(card, { scrollHeight: CHROME + LIST_NATURAL });
  const listTop = () => cardTop0 - port.scrollTop + CHROME;
  mockBox(list, listTop, LIST_NATURAL);
  mockDim(list, {
    clientHeight: LIST_NATURAL,
    scrollHeight: LIST_NATURAL,
  });
  [...list.children].forEach((row, i) => {
    mockBox(row, () => listTop() + i * 72, 72);
  });
  mockBox(actions, () => cardTop0 - port.scrollTop + 330, 54);
  act(() => window.dispatchEvent(new Event("resize")));
  return { port, card, list, actions };
};

const inPort = (actions: Element, port: Element) => {
  const a = actions.getBoundingClientRect();
  const p = port.getBoundingClientRect();
  return a.top >= p.top && a.bottom <= p.bottom;
};

describe("question-card port fit (FIX #515 r5)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("the cap keeps card ≤ port: chrome + cap ≤ portH − margins", () => {
    const { list } = mountCard(0, 0);
    const cap = Number.parseFloat(list.style.maxHeight);
    expect(Number.isFinite(cap)).toBe(true);
    /* Cap can only give the list what the port leaves the card's chrome —
       whole card ≤ port is the invariant (the 96px floor aside). */
    expect(cap).toBeLessThanOrEqual(PORT_H - 16 - CHROME);
    expect(CHROME + cap).toBeLessThanOrEqual(PORT_H - 16);
  });

  test("the question arriving after an answer lifts actions into the port", () => {
    /* Answering scrolls you to the receipt; the next question lands below
       the fold — the arrival-align must raise it until input+Skip are
       usable, exactly like a fresh arrival (r5). */
    const { port, actions } = mountCard(700, 0);
    expect(inPort(actions, port)).toBe(false); // starts below the fold
    act(() => vi.advanceTimersByTime(4000));
    expect(inPort(actions, port)).toBe(true);
    const top = document
      .querySelector("[data-ask-id]")!
      .getBoundingClientRect().top;
    expect(top).toBeGreaterThanOrEqual(8 - 1);
  });

  test("a card clipped under the header lifts actions into the port", () => {
    const { port, actions } = mountCard(-100, 200);
    act(() => vi.advanceTimersByTime(4000));
    expect(inPort(actions, port)).toBe(true);
  });

  test("a tail-cut card reveals its actions, head staying under the header", () => {
    const { port, actions } = mountCard(300, 0);
    act(() => vi.advanceTimersByTime(4000));
    expect(inPort(actions, port)).toBe(true);
  });

  test("+N more counts the options the cap hid", () => {
    mountCard(0, 0);
    expect(document.body.textContent).toContain("+3 more");
  });

  test("questionOptionCap: cap = port minus chrome, over only on overflow", () => {
    expect(questionOptionCap(360, 210, 441)).toEqual({
      cap: 215,
      over: true,
    });
    /* Fits already → no cap needed (over=false lets the list go uncapped). */
    expect(questionOptionCap(180, 210, 441).over).toBe(false);
    /* Floor: chrome alone nearly fills the port → still ≥ one row + peek. */
    expect(questionOptionCap(360, 600, 441).cap).toBe(96);
  });
});
