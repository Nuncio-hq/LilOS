// @vitest-environment happy-dom
/* AC tests for issue #130: a send the host reports as failed (the onSend
   promise rejects) keeps the draft — typed text and image chips stay in the
   composer so a retry is one keypress away. A successful send still clears
   immediately, Enter-Enter sends once, and a synchronous onSend (the
   prototype's fake send) clears exactly as before. */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Composer } from "../src/chat/composer";

/* happy-dom does not implement every browser API the vendored components touch. */
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof URL.createObjectURL === "undefined") {
  URL.createObjectURL = () => "blob:fake";
  URL.revokeObjectURL = () => {};
}
afterEach(cleanup);

const c = (onSend?: (t: string, files?: unknown[]) => unknown) =>
  render(
    <Composer
      placeholder="Reply…"
      employees={[]}
      hint=""
      onSend={onSend}
      accept="image/*"
    />,
  );

const box = (r: HTMLElement) =>
  r.querySelector("textarea") as HTMLTextAreaElement;
const formOf = (r: HTMLElement) => r.querySelector("form") as HTMLFormElement;
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const attach = (r: HTMLElement, name = "pic.png") => {
  const input = r.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(["png"], name, { type: "image/png" })] },
  });
};

describe("issue #130 refused send keeps the draft", () => {
  test("AC-1 a rejected onSend keeps the typed text and the image chips", async () => {
    const onSend = vi.fn(() => Promise.reject(new Error("refused")));
    const r = c(onSend);
    fireEvent.change(box(r.container), { target: { value: "still here" } });
    attach(r.container);
    fireEvent.submit(formOf(r.container));
    await settle();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(box(r.container).value).toBe("still here");
    expect(r.container.textContent).toContain("pic.png");
  });

  test("AC-1b after a refused send, pressing send again retries the same draft", async () => {
    let fail = true;
    const onSend = vi.fn((_t: string) =>
      fail ? Promise.reject(new Error("refused")) : Promise.resolve(),
    );
    const r = c(onSend);
    fireEvent.change(box(r.container), { target: { value: "retry me" } });
    fireEvent.submit(formOf(r.container));
    await settle();
    expect(box(r.container).value).toBe("retry me");

    fail = false;
    fireEvent.submit(formOf(r.container));
    await settle();
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith("retry me", []);
    expect(box(r.container).value).toBe("");
  });

  test("AC-3 a successful send still clears the draft", async () => {
    const onSend = vi.fn(() => Promise.resolve());
    const r = c(onSend);
    fireEvent.change(box(r.container), { target: { value: "go" } });
    attach(r.container, "gone.png");
    fireEvent.submit(formOf(r.container));
    await settle();
    expect(box(r.container).value).toBe("");
    expect(r.container.textContent).not.toContain("gone.png");
  });

  test("AC-3b Enter-Enter while the send is in flight sends once", async () => {
    let release: () => void = () => {};
    const onSend = vi.fn(() => new Promise<void>((res) => (release = res)));
    const r = c(onSend);
    fireEvent.change(box(r.container), { target: { value: "once" } });
    fireEvent.submit(formOf(r.container));
    fireEvent.submit(formOf(r.container));
    await settle();
    release();
    await settle();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(box(r.container).value).toBe("");
  });

  test("AC-4 a synchronous onSend clears the draft like before", async () => {
    const onSend = vi.fn();
    const r = c(onSend);
    fireEvent.change(box(r.container), { target: { value: "fake send" } });
    fireEvent.submit(formOf(r.container));
    await settle();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(box(r.container).value).toBe("");
  });
});
