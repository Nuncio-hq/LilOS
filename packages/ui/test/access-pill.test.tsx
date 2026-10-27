// @vitest-environment happy-dom
/* Access pill (#886): Ask/Full menu with a Full confirm every time — plus
   the folded #884 state: when the engine's global policy reports `off`,
   the same menu carries the warning + Fix above the Ask/Full rows and the
   pill reads "Never asks". One access control, not two. */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AccessPill } from "../src/chat/access-pill";

/* happy-dom does not implement every browser API the vendored components touch. */
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
    onchange: null,
  })) as typeof window.matchMedia;
}

afterEach(cleanup);

const body = () => document.body as HTMLElement;
const menu = () => body().querySelector('[role="menu"]') as HTMLElement;
const open = () => {
  fireEvent.click(
    body().querySelector('[data-slot="access-pill"]') as HTMLElement,
  );
};

describe("access pill — engine never asks (#884 folded into #886's menu)", () => {
  test("the pill reads Never asks and the menu carries the warning + Fix", () => {
    const onAccess = vi.fn();
    const onFix = vi.fn();
    render(
      <AccessPill
        access="ask"
        onAccess={onAccess}
        engineNeverAsks
        engineName="Hermes"
        onFixPolicy={onFix}
      />,
    );
    const pill = body().querySelector('[data-slot="access-pill"]');
    expect(pill?.getAttribute("data-engine-never-asks")).toBe("true");
    expect(pill?.textContent).toContain("Never asks");

    open();
    expect(menu().textContent).toContain(
      "Hermes is set to never ask, so Ask won't stop risky commands.",
    );
    /* One control: the Ask/Full rows are still there under the warning. */
    expect(
      within(menu()).getByRole("menuitemradio", { name: /Ask/ }),
    ).toBeTruthy();
    expect(
      within(menu()).getByRole("menuitemradio", { name: /Full access/ }),
    ).toBeTruthy();

    fireEvent.click(within(menu()).getByRole("menuitem", { name: /Fix/ }));
    expect(onFix).toHaveBeenCalledTimes(1);
    expect(onAccess).not.toHaveBeenCalled();
  });

  test("without a fix handler the warning still shows, just no Fix row", () => {
    render(<AccessPill access="ask" onAccess={vi.fn()} engineNeverAsks />);
    open();
    expect(menu().textContent).toContain(
      "The engine is set to never ask, so Ask won't stop risky commands.",
    );
    expect(within(menu()).queryByRole("menuitem", { name: /Fix/ })).toBeNull();
  });

  test("a normal engine shows no warning and no Never asks", () => {
    render(<AccessPill access="ask" onAccess={vi.fn()} />);
    const pill = body().querySelector('[data-slot="access-pill"]');
    expect(pill?.getAttribute("data-engine-never-asks")).toBeNull();
    expect(pill?.textContent).toContain("Ask");
    open();
    expect(menu().textContent).not.toContain("never ask");
  });

  test("Full still confirms under the engine warning", () => {
    const onAccess = vi.fn();
    render(
      <AccessPill
        access="ask"
        onAccess={onAccess}
        engineNeverAsks
        engineName="Hermes"
        onFixPolicy={vi.fn()}
      />,
    );
    open();
    fireEvent.click(
      within(menu()).getByRole("menuitemradio", { name: /Full access/ }),
    );
    expect(
      within(body()).getByText(
        "Agents run tools without asking in this thread",
      ),
    ).toBeTruthy();
    fireEvent.click(within(body()).getByText("Use Full access"));
    expect(onAccess).toHaveBeenCalledWith("full");
  });
});

describe("access pill — Full confirms every time, per thread (#886)", () => {
  const pickFull = () => {
    open();
    fireEvent.click(
      within(menu()).getByRole("menuitemradio", { name: /Full access/ }),
    );
  };

  test("a yes never carries over: the next Full asks again, nothing is stored", () => {
    localStorage.clear();
    const onAccess = vi.fn();
    const { rerender } = render(
      <AccessPill access="ask" onAccess={onAccess} />,
    );
    pickFull();
    fireEvent.click(within(body()).getByText("Use Full access"));
    expect(onAccess).toHaveBeenCalledWith("full");
    expect(localStorage.length).toBe(0);

    // Another thread (or this one, back on Ask) — the confirm is back.
    rerender(<AccessPill access="ask" onAccess={onAccess} />);
    onAccess.mockClear();
    pickFull();
    expect(onAccess).not.toHaveBeenCalled();
    expect(
      within(body()).getByText(
        "Agents run tools without asking in this thread",
      ),
    ).toBeTruthy();
  });

  test("Back leaves Ask — no write until the yes", () => {
    const onAccess = vi.fn();
    render(<AccessPill access="ask" onAccess={onAccess} />);
    pickFull();
    fireEvent.click(within(body()).getByText("Back"));
    expect(onAccess).not.toHaveBeenCalled();
    expect(
      body()
        .querySelector('[data-slot="access-pill"]')
        ?.getAttribute("data-access"),
    ).toBe("ask");
  });
});
