// @vitest-environment happy-dom
/* Workbench review fixes (#770): the Details tab names the model the way the
   header does — resolved model id, catalog display name, effort label, and the
   SAME context window as the header meter (#294) — the Plan tab opens onto
   its empty state instead of a blank panel, and the "nothing to show" line
   speaks of the thread. */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { SessionUsage } from "../src/focus/session-usage";
import type {
  Employee,
  HumanFn,
  ModelOption,
  Thread,
  WbTab,
  Work,
} from "../src/types";
import { DetailsPanel } from "../src/workbench/wb-details";
import { Workbench } from "../src/workbench/workbench";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof Element.prototype.scrollTo === "undefined") {
  Element.prototype.scrollTo = () => {};
}
if (typeof Element.prototype.getAnimations === "undefined") {
  Element.prototype.getAnimations = () => [];
}
if (typeof Element.prototype.scrollIntoView === "undefined") {
  Element.prototype.scrollIntoView = () => {};
}
Object.defineProperty(window, "innerWidth", { value: 1400, writable: true });
afterEach(cleanup);
afterEach(() => localStorage.clear());

const LEAD: Employee = {
  id: "builder",
  name: "Builder",
  role: "Engineer",
  status: "online",
  profile: "p",
  model: "lead-model",
  now: "",
  instructions: "",
  respondTo: "anyone",
};
const human: HumanFn = () => ({ name: "Ada", color: "bg-blue-600" });
const WORK: Work = { ticket: "T-1", title: "Task", path: "/tmp/wb-repo" };

/* The catalog row reports 262k; with no `usage.contextWindow` a reader that
   skips the catalog divides by the 200k fallback and reads 66%, not 50%. */
const CATALOG: ModelOption[] = [
  {
    id: "qwen3.8-flash-next",
    name: "Qwen3.8 Flash Next",
    contextWindow: 262_000,
  },
];
const USAGE = { input: 131_000, output: 0, reasoning: 0, cache: 0 };
const THREAD: Thread = {
  session: "s_details",
  replies: [],
  usage: USAGE,
  effort: "xhigh",
};

/* A Details row's value, by its label. */
const rowValue = (c: HTMLElement, key: string) =>
  [...c.querySelectorAll("[data-wb-details] > div")].find(
    (d) => d.firstElementChild?.textContent === key,
  )?.lastElementChild?.textContent;

describe("Details tab names the model like the header does", () => {
  test("display name + effort label, not the wire ids", () => {
    const c = render(
      <DetailsPanel
        thread={{ ...THREAD, model: "qwen3.8-flash-next" }}
        model="qwen3.8-flash-next"
        models={CATALOG}
      />,
    );
    expect(rowValue(c.container, "Model")).toBe(
      "Qwen3.8 Flash Next · Extra high",
    );
    expect(c.container.textContent).not.toContain("xhigh");
    expect(c.container.textContent).not.toContain("qwen3.8-flash-next");
  });

  test("the Model row shows the resolved model when the thread has no pick of its own", () => {
    const c = render(
      <DetailsPanel
        thread={{ session: "s_nopick", replies: [] }}
        model="qwen3.8-flash-next"
        models={CATALOG}
      />,
    );
    expect(rowValue(c.container, "Model")).toBe("Qwen3.8 Flash Next");
  });

  test("a model the catalog does not list falls back to its id; no model, no row", () => {
    const c = render(
      <DetailsPanel
        thread={{ session: "s_unlisted", replies: [], effort: "high" }}
        model="mystery-1"
        models={CATALOG}
      />,
    );
    expect(rowValue(c.container, "Model")).toBe("mystery-1 · High");
    c.rerender(<DetailsPanel thread={{ session: "s_none", replies: [] }} />);
    expect(rowValue(c.container, "Model")).toBeUndefined();
  });

  test("reads the same context window and percentage as the header meter", () => {
    const meter = render(
      <SessionUsage
        usage={USAGE}
        model="qwen3.8-flash-next"
        models={CATALOG}
      />,
    );
    const title = meter.container
      .querySelector("button")
      ?.getAttribute("title");
    expect(title).toMatch(/^Context used: 50% of 262k$/i);
    cleanup();
    const c = render(
      <DetailsPanel
        thread={THREAD}
        model="qwen3.8-flash-next"
        models={CATALOG}
      />,
    );
    expect(rowValue(c.container, "Context")).toBe("50%");
  });
});

describe("Workbench Plan tab and empty copy", () => {
  function Controlled() {
    const [tab, setTab] = useState<WbTab>("changes");
    return (
      <Workbench
        thread={{ session: "s_plan", replies: [] }}
        work={WORK}
        isDM
        lead={LEAD}
        tab={tab}
        setTab={setTab}
        onClose={() => {}}
        human={human}
        caps={{ plan: true }}
      />
    );
  }

  test("an empty Plan tab opens onto the panel's empty state, not a blank panel", () => {
    const c = render(<Controlled />);
    const tab = c.container.querySelector('[data-wb-tab="plan"]');
    expect(tab?.getAttribute("data-wb-empty")).toBe("true");
    fireEvent.click(tab as Element);
    expect(tab?.getAttribute("aria-selected")).toBe("true");
    expect(c.container.textContent).toContain("No plan in this thread yet.");
  });

  test("a folderless thread with nothing to list says 'thread', never 'session'", () => {
    const c = render(
      <Workbench
        thread={{ session: "s_empty", replies: [] }}
        work={null}
        isDM
        tab="changes"
        setTab={() => {}}
        onClose={() => {}}
        human={human}
      />,
    );
    expect(c.container.textContent).toBe(
      "Nothing to show — a process, helper or plan lists here once the thread has one.",
    );
  });
});
