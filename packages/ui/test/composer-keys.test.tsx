// @vitest-environment happy-dom
/* AC tests for issue #104: Esc in the composer stops the running turn through
   the same onStop the Stop button calls — but an open overlay (the `@` menu,
   a popover, a dialog) eats the Esc first; ↑ in an empty composer recalls the
   last sent message. */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Composer } from "../src/chat/composer";
import { FocusComposer } from "../src/chat/focus-composer";
import type { Employee } from "../src/types";

/* happy-dom does not implement every browser API the vendored components touch. */
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
afterEach(cleanup);

const BUILDER: Employee = {
  id: "builder",
  name: "Builder",
  role: "Engineer",
  status: "online" as const,
  profile: "p",
  model: "gpt-test-1",
  now: "",
  instructions: "",
  respondTo: "anyone" as const,
};

const box = (c: HTMLElement) =>
  c.querySelector("textarea") as HTMLTextAreaElement;

const raf = () => new Promise((r) => requestAnimationFrame(() => r(null)));

describe("issue #104 composer keys", () => {
  test("AC-1 Esc in the composer while a turn runs calls onStop (the Stop button's handler)", () => {
    const onStop = vi.fn();
    const c = render(
      <Composer
        placeholder="Reply…"
        employees={[]}
        hint=""
        status="streaming"
        onStop={onStop}
      />,
    );
    fireEvent.keyDown(box(c.container), { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("AC-2 Esc with no turn running — or no onStop — does nothing", () => {
    const onStop = vi.fn();
    const c = render(
      <Composer
        placeholder="Reply…"
        employees={[]}
        hint=""
        status="ready"
        onStop={onStop}
      />,
    );
    fireEvent.keyDown(box(c.container), { key: "Escape" });
    expect(onStop).not.toHaveBeenCalled();

    // D-#19: no handler → no Esc stop (same rule as the hidden Stop button).
    const d = render(
      <Composer
        placeholder="Reply…"
        employees={[]}
        hint=""
        status="streaming"
      />,
    );
    fireEvent.keyDown(box(d.container), { key: "Escape" });
    expect(onStop).not.toHaveBeenCalled();
  });

  test("AC-3 Esc closes the open `@` menu first and only the next Esc stops the turn", () => {
    const onStop = vi.fn();
    const c = render(
      <Composer
        placeholder="Message…"
        employees={[BUILDER]}
        hint=""
        status="streaming"
        onStop={onStop}
      />,
    );
    const el = box(c.container);
    fireEvent.change(el, { target: { value: "@" } });
    expect(c.container.querySelector('[role="listbox"]')).toBeTruthy();

    fireEvent.keyDown(el, { key: "Escape" });
    expect(c.container.querySelector('[role="listbox"]')).toBeNull();
    expect(onStop).not.toHaveBeenCalled();

    fireEvent.keyDown(el, { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("AC-3b an open popover owns the Esc — the turn keeps running", () => {
    const onStop = vi.fn();
    const c = render(
      <Composer
        placeholder="Reply…"
        employees={[]}
        hint=""
        status="streaming"
        onStop={onStop}
      />,
    );
    const pop = document.createElement("div");
    pop.setAttribute("data-slot", "popover-content");
    pop.setAttribute("data-open", "");
    document.body.appendChild(pop);
    try {
      fireEvent.keyDown(box(c.container), { key: "Escape" });
      expect(onStop).not.toHaveBeenCalled();
    } finally {
      pop.remove();
    }
    fireEvent.keyDown(box(c.container), { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("AC-4 Esc with a draft present still stops the turn and keeps the text", () => {
    const onStop = vi.fn();
    const c = render(
      <Composer
        placeholder="Reply…"
        employees={[]}
        hint=""
        status="streaming"
        onStop={onStop}
      />,
    );
    const el = box(c.container);
    fireEvent.change(el, { target: { value: "also check the retry loop" } });
    fireEvent.keyDown(el, { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(el.value).toBe("also check the retry loop");
  });

  test("AC-5 ↑ in an empty composer recalls the last sent message, caret at the end", async () => {
    const c = render(
      <Composer
        placeholder="Reply…"
        employees={[]}
        hint=""
        lastSent="fix the flaky replay test"
      />,
    );
    const el = box(c.container);
    fireEvent.keyDown(el, { key: "ArrowUp" });
    expect(el.value).toBe("fix the flaky replay test");
    await raf();
    expect(el.selectionStart).toBe(el.value.length);
    expect(el.selectionEnd).toBe(el.value.length);
  });

  test("AC-5b ↑ with text in the composer never replaces it", () => {
    const c = render(
      <Composer
        placeholder="Reply…"
        employees={[]}
        hint=""
        lastSent="earlier message"
      />,
    );
    const el = box(c.container);
    fireEvent.change(el, { target: { value: "draft in progress" } });
    fireEvent.keyDown(el, { key: "ArrowUp" });
    expect(el.value).toBe("draft in progress");
  });

  test("AC-6 the Stop button's label says Esc", () => {
    const c = render(
      <Composer
        placeholder="Reply…"
        employees={[]}
        hint=""
        status="streaming"
        onStop={() => {}}
      />,
    );
    const stop = c.getByRole("button", { name: /stop/i });
    expect(stop.getAttribute("aria-label")).toContain("Esc");
    expect(stop.getAttribute("title")).toContain("Esc");
  });

  test("AC-1 FocusComposer: Esc stops through onStop while running", () => {
    const onStop = vi.fn();
    const c = render(
      <FocusComposer
        running={true}
        status="streaming"
        placeholder="Continue…"
        hint=""
        onSend={() => {}}
        onStop={onStop}
      />,
    );
    fireEvent.keyDown(box(c.container), { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
