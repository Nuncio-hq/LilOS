// @vitest-environment happy-dom
/* Needs you A/D/J do nothing while the key's target is a Workbench terminal
   or a dialog, and A on the page itself still approves. The web stack has
   no live terminal, so this is the coverage for that case. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { V3Ask, V3Data } from "../src/v3/v3-data-types";
import { V3Needs } from "../src/v3/v3-needs";
import type { V3Actions } from "../src/v3/v3-page-types";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const ask = (id: string, title: string, why: string, at: number): V3Ask => ({
  id,
  from: "emp_1",
  kind: "approval",
  title,
  waiting: 1,
  at,
  ask: title,
  why,
});

const mount = () => {
  const approve = vi.fn();
  const deny = vi.fn();
  const data = {
    company: "Co",
    me: "Me",
    today: "Monday",
    agents: [],
    connectors: [],
    projects: [],
    goals: [],
    tickets: [],
    threads: [],
    asks: [
      ask("ship", "Ship the paywall", "Readers liked the hooks", 1),
      ask("banner", "Retire the old banner", "It covers the title", 2),
    ],
    updates: [],
    schedules: [],
    browser: { tabs: [], bookmarks: [] },
    devices: [],
    modelChoices: [],
    agentFields: [],
    settings: {},
    setUp: true,
    features: { tickets: false },
  } as unknown as V3Data;
  const act = {
    approve,
    deny,
    answer: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
    startChat: vi.fn(async () => undefined),
    ask: vi.fn(),
  } as unknown as V3Actions;
  render(<V3Needs data={data} go={vi.fn()} act={act} />);
  return { approve, deny };
};

const press = (el: Element, key: string) =>
  fireEvent.keyDown(el, { key, bubbles: true });

const stillOnFirst = () => {
  expect(screen.getByText("Readers liked the hooks")).toBeTruthy();
  expect(screen.queryByText("It covers the title")).toBeNull();
};

describe("Needs you keys", () => {
  test("a, d and j inside the workbench terminal do not approve, deny or move", () => {
    const { approve, deny } = mount();
    const term = document.createElement("div");
    term.setAttribute("data-lilos-terminal", "");
    term.setAttribute("role", "textbox");
    const inner = document.createElement("span");
    term.append(inner);
    document.body.append(term);

    for (const key of ["a", "d", "j"]) press(inner, key);

    expect(approve).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
    stillOnFirst();
  });

  test("a, d and j inside a dialog do not approve, deny or move", () => {
    const { approve, deny } = mount();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inner = document.createElement("span");
    dialog.append(inner);
    document.body.append(dialog);

    for (const key of ["a", "d", "j"]) press(inner, key);

    expect(approve).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
    stillOnFirst();
  });

  test("a on the page approves the open ask", () => {
    const { approve, deny } = mount();
    const page = document.createElement("div");
    document.body.append(page);

    press(page, "a");

    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith("ship", undefined);
    expect(deny).not.toHaveBeenCalled();
  });
});
