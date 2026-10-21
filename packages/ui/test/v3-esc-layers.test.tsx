// @vitest-environment happy-dom
/* #576 + #770: Esc leaves ONE thing per press. The shell's own Esc work —
   tucking a popped-out sidebar, closing the peek — must not outrun the layer
   stack: a widened thread (a layer) must not take the key from a sidebar that
   floats over it, and a thread's own menu/popover closes on Esc without
   taking the whole peek along. */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useUiLayer } from "../src/chat/ui-layers";
import type { V3Data } from "../src/v3/v3-data-types";
import type { V3Nav } from "../src/v3/v3-page-types";
import { V3Shell } from "../src/v3/v3-shell";
import type { V3Thread } from "../src/v3/v3-types";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

beforeEach(() => localStorage.setItem("lilos-v3-sidebar-hidden", "1"));
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.body.innerHTML = "";
});

const thread: V3Thread = {
  id: "t1",
  agentId: "emp_1",
  title: "A thread",
  status: "working",
  startedAt: "10:00",
  minutes: 3,
  step: 1,
  context: 1,
  folder: "~",
  changes: [],
  turns: [],
};

const data = {
  company: "Co",
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
  threads: [thread],
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

/* What the app's widened thread does: it is a layer whose Esc narrows. */
function WidenedThread({ onEscape }: { onEscape: () => void }) {
  useUiLayer({ onEscape });
  return <div data-testid="thread" />;
}

const esc = () =>
  act(() => {
    fireEvent.keyDown(document.body, { key: "Escape" });
  });

/* `layer: false` is a thread that registers no Esc layer of its own, so the
   shell's own close-the-peek fallback is what answers the key. */
function mount(nav: V3Nav, layer = true, onEscape = vi.fn(), onNav = vi.fn()) {
  const r = render(
    <V3Shell
      data={data}
      actions={{} as never}
      nav={nav}
      onNav={onNav as (u: (n: V3Nav) => V3Nav) => void}
      renderThread={() =>
        layer ? <WidenedThread onEscape={onEscape} /> : <div />
      }
    />,
  );
  return { ...r, onEscape, onNav };
}

const sidebar = (c: HTMLElement) =>
  c.querySelector("[data-sidebar]")?.getAttribute("data-sidebar");

const widened: V3Nav = {
  page: { page: "threads" },
  peek: [{ page: "thread", id: "t1" }],
  full: true,
};

describe("Esc in the shell", () => {
  test("a sidebar floating over a widened thread tucks first; the thread keeps its Esc for the next press", () => {
    const { container, onEscape } = mount(widened);
    fireEvent.pointerEnter(
      container.querySelector("[data-sidebar-hot-zone]") as Element,
    );
    expect(sidebar(container)).toBe("popped");
    esc();
    expect(sidebar(container)).toBe("hidden");
    expect(onEscape).not.toHaveBeenCalled();
    esc();
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  test("the open menu of the thread takes Esc alone — the peek stays", () => {
    const { onNav } = mount(
      { page: { page: "threads" }, peek: [{ page: "thread", id: "t1" }] },
      false,
    );
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);
    esc();
    expect(onNav).not.toHaveBeenCalled();
    menu.remove();
    esc();
    expect(onNav).toHaveBeenCalledTimes(1);
  });
});
