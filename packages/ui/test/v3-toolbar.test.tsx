// @vitest-environment happy-dom
/* #797: the window has ONE toolbar row, made of each column's first row. What
   the unit can pin is who owns which item — the layout itself (the row's
   height, the lights centred in it) is measured in e2e/ac-232. */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { V3Data } from "../src/v3/v3-data-types";
import type { V3Nav } from "../src/v3/v3-page-types";
import { V3Shell } from "../src/v3/v3-shell";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.body.innerHTML = "";
});
beforeEach(() => localStorage.clear());

const data = {
  company: "Acme Labs",
  me: "Me",
  today: "Monday",
  agents: [
    {
      id: "emp_1",
      name: "Reviewer",
      tone: "b",
      role: "QA",
      hired: "1 Oct",
      profile: "reviewer",
      model: "Sonnet 5",
      instructions: [],
    },
  ],
  connectors: [],
  projects: [],
  goals: [],
  tickets: [],
  threads: [],
  asks: [],
  updates: [],
  schedules: [],
  browser: { tabs: [], bookmarks: [] },
  devices: [],
  modelChoices: ["Sonnet 5"],
  settings: {
    engine: { state: "ok", name: "Hermes" },
    relay: { state: "ok" },
  },
  setUp: true,
  features: { tickets: false },
} as unknown as V3Data;

const thread = { page: "thread", id: "t1" } as const;
const page: V3Nav = { page: { page: "people" }, peek: [] };
const beside: V3Nav = { page: { page: "people" }, peek: [thread] };
const widened: V3Nav = { ...beside, full: true };

function mount(nav: V3Nav) {
  return render(
    <V3Shell
      data={data}
      actions={{} as never}
      nav={nav}
      onNav={vi.fn()}
      renderThread={() => <div />}
    />,
  );
}

const hide = () => localStorage.setItem("lilos-v3-sidebar-hidden", "1");
const bar = (c: HTMLElement) =>
  c.querySelector("[data-v3-topbar]") as HTMLElement;
const sidebar = (c: HTMLElement) =>
  c.querySelector("[data-sidebar]") as HTMLElement;
const peek = (c: HTMLElement) =>
  c.querySelector('aside[aria-label="Opened record"]') as HTMLElement;
const shortcuts = (c: HTMLElement) =>
  c.querySelectorAll("[data-sidebar-shortcuts]");

describe("the toolbar row", () => {
  test("the company names the sidebar's Company section, not the toolbar", () => {
    const { container } = mount(page);
    expect(
      sidebar(container).querySelector("[data-company-label]")?.textContent,
    ).toBe("Acme Labs");
    for (const seg of container.querySelectorAll("[data-toolbar]"))
      expect(seg.textContent).not.toContain("Acme Labs");
    expect(bar(container).textContent).toBe("");
  });

  test("docked, the toggle is the sidebar segment's only item; the page segment is empty drag space", () => {
    const { container } = mount(page);
    const seg = sidebar(container).querySelector("[data-toolbar]");
    expect(seg?.querySelectorAll("button")).toHaveLength(1);
    expect(seg?.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Hide sidebar",
    );
    expect(seg?.hasAttribute("data-toolbar-lead")).toBe(true);
    expect(bar(container).children).toHaveLength(0);
    expect(bar(container).hasAttribute("data-toolbar-lead")).toBe(false);
    expect(shortcuts(container)).toHaveLength(0);
  });

  test("hidden, the toggle and Search lead the page segment, which then clears the lights", () => {
    hide();
    const { container } = mount(page);
    expect(sidebar(container).getAttribute("data-sidebar")).toBe("hidden");
    expect(bar(container).hasAttribute("data-toolbar-lead")).toBe(true);
    const names = [...bar(container).querySelectorAll("button")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(names).toEqual(["Show sidebar", "Search"]);
    // The toggle comes first: right after the lights.
    expect(bar(container).querySelector("button")).toBe(
      shortcuts(container)[0].querySelector("button"),
    );

    fireEvent.click(
      within(bar(container)).getByRole("button", { name: "Show sidebar" }),
    );
    expect(localStorage.getItem("lilos-v3-sidebar-hidden")).toBeNull();
    expect(sidebar(container).getAttribute("data-sidebar")).toBe("docked");
    expect(shortcuts(container)).toHaveLength(0);
  });

  test("the peek's back, trail, Widen and close are its toolbar segment, inside the one <aside>", () => {
    const { container } = mount(beside);
    const seg = peek(container).firstElementChild as HTMLElement;
    expect(seg.hasAttribute("data-toolbar")).toBe(true);
    expect(seg.querySelector('nav[aria-label="Trail"]')).toBeTruthy();
    for (const title of ["Back one step", "Widen over the page", "Close (Esc)"])
      expect(seg.querySelector(`button[title="${title}"]`)).toBeTruthy();
    // Docked, it clears nothing: the sidebar owns the lights.
    expect(seg.hasAttribute("data-toolbar-lead")).toBe(false);
  });

  test("widened over a hidden sidebar, the peek's segment leads with the toggle and the page's is bare", () => {
    hide();
    const { container } = mount(widened);
    const seg = peek(container).firstElementChild as HTMLElement;
    expect(seg.hasAttribute("data-toolbar-lead")).toBe(true);
    // One set of shortcuts on the screen, never two: the peek's now.
    expect(shortcuts(container)).toHaveLength(1);
    expect(seg.contains(shortcuts(container)[0])).toBe(true);
    expect(bar(container).children).toHaveLength(0);
    expect(
      seg.querySelector('button[title="Narrow, back beside the page"]'),
    ).toBeTruthy();
  });

  test("hidden with the peek beside the page: the page's segment leads, the peek's does not", () => {
    hide();
    const { container } = mount(beside);
    expect(bar(container).contains(shortcuts(container)[0])).toBe(true);
    expect(
      peek(container).firstElementChild?.hasAttribute("data-toolbar-lead"),
    ).toBe(false);
  });
});
