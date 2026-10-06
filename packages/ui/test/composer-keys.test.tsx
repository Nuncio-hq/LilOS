// @vitest-environment happy-dom
/* AC tests for issues #104 + #576: Esc in the composer only ever dismisses
   the composer's own overlay (the `@` menu) — it NEVER stops a running
   turn. Stopping is ■ / ⌘. (#576). ↑ in an empty composer still recalls
   the last sent message (#104). */
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

describe("issue #576 composer keys — Esc never stops", () => {
  test("AC-576-1 Esc in the composer while a turn runs does NOT call onStop", () => {
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
    expect(onStop).not.toHaveBeenCalled();
  });

  test("AC-576-2 ⌘. / Ctrl+. while a turn runs calls onStop (the Stop button's handler)", () => {
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
    fireEvent.keyDown(box(c.container), { key: ".", metaKey: true });
    expect(onStop).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box(c.container), { key: ".", ctrlKey: true });
    expect(onStop).toHaveBeenCalledTimes(2);
    /* `code` covers layouts where the key value isn't ".". */
    fireEvent.keyDown(box(c.container), { key: ">", code: "Period", metaKey: true });
    expect(onStop).toHaveBeenCalledTimes(3);
  });

  test("AC-576-3 ⌘. with no turn running — or no onStop — does nothing", () => {
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
    fireEvent.keyDown(box(c.container), { key: ".", metaKey: true });
    expect(onStop).not.toHaveBeenCalled();

    const d = render(
      <Composer placeholder="Reply…" employees={[]} hint="" status="streaming" />,
    );
    fireEvent.keyDown(box(d.container), { key: ".", metaKey: true });
    expect(onStop).not.toHaveBeenCalled();
  });

  test("AC-576-4 Esc closes the open `@` menu first and still never stops the turn", () => {
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

    /* The next Esc is inert too — closing the panel is the surface layer's
       job (ui-layers), not the composer's. */
    fireEvent.keyDown(el, { key: "Escape" });
    expect(onStop).not.toHaveBeenCalled();
  });

  test("AC-576-5 Esc with a draft present keeps the text and never stops", () => {
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
    expect(onStop).not.toHaveBeenCalled();
    expect(el.value).toBe("also check the retry loop");
  });

  test("AC-576-6 the Stop button's label names ⌘., not Esc", () => {
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
    expect(stop.getAttribute("aria-label")).toContain("⌘.");
    expect(stop.getAttribute("title")).toContain("⌘.");
    expect(stop.getAttribute("title")).not.toContain("Esc");
  });

  test("AC-576-7 FocusComposer: Esc never stops; ⌘. does", () => {
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
    expect(onStop).not.toHaveBeenCalled();
    fireEvent.keyDown(box(c.container), { key: ".", metaKey: true });
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe("issue #104 composer keys", () => {
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
});
