// @vitest-environment happy-dom
/* #872 — the new-chat model chip follows the SELECTED agent: a runtime
   agent's picker lists its OWN engine's catalog (Devin → SWE-2), never
   the default engine's list; switching agents switches the list and
   pre-selects that agent's model; a pick made on one agent never stays
   selected on another's chip. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { V3Data } from "../src/v3/v3-data-types";
import { V3DraftChat } from "../src/v3/v3-draft-chat";
import type { V3Actions } from "../src/v3/v3-page-types";
import type { V3Agent } from "../src/v3/v3-types";

afterEach(cleanup);

const HERMES: V3Agent = {
  id: "hermes",
  name: "Hermes",
  tone: "c",
  role: "Assistant",
  hired: "1 Oct",
  model: "Opus 5.5",
  modelId: "opus-5-5",
  instructions: [],
};
const DEVIN: V3Agent = {
  id: "devin",
  name: "Devin",
  tone: "b",
  role: "Coder",
  hired: "1 Oct",
  model: "SWE-2",
  modelId: "swe-2",
  runtime: "acp:devin",
  instructions: [],
};

function data(over: Partial<V3Data> = {}): V3Data {
  return {
    company: "Co",
    me: "Ada",
    today: "Wednesday",
    agents: [HERMES, DEVIN],
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
    runtimes: [
      { id: "hermes", label: "Hermes", isDefault: true },
      { id: "acp:devin", label: "Devin", models: ["SWE-2"] },
    ],
    modelChoices: ["Opus 5.5"],
    modelCatalog: {
      options: [
        { id: "opus-5-5", name: "Opus 5.5", provider: "anthropic" },
        { id: "sonnet-5", name: "Sonnet 5", provider: "anthropic" },
      ],
      defaultModel: "opus-5-5",
      defaultProvider: "anthropic",
    },
    modelCatalogs: {
      "acp:devin": {
        options: [
          {
            id: "swe-2",
            name: "SWE-2",
            provider: "cognition",
            efforts: ["low", "high"],
            defaultEffort: "high",
          },
          { id: "swe-2-high", name: "SWE-2 high", provider: "cognition" },
        ],
        defaultModel: "swe-2",
        defaultProvider: "cognition",
      },
    },
    settings: {
      approvals: "ask",
      models: [],
      engine: { name: "Engine", state: "ok" },
      relay: { state: "ok" },
    },
    setUp: true,
    features: { tickets: false },
    ...over,
  } as V3Data;
}

const actions = (): V3Actions =>
  ({ startChat: vi.fn(async () => "conv_new") }) as unknown as V3Actions;

/** The picker's closed label. */
const trigger = () =>
  document.querySelector<HTMLElement>('[data-slot="model-picker-trigger"]');

/** The Agent chip's menu button. */
const agentChip = () => screen.getByTitle(/^Agent/);

const effortTrigger = () =>
  document.querySelector<HTMLElement>('[data-slot="effort-picker-trigger"]');

describe("the composer's Model and Effort dropdowns follow the selected agent's catalog (#886 on #890)", () => {
  const rows = (pop: HTMLElement) =>
    [...pop.querySelectorAll("[cmdk-item]")].map((e) => e.textContent);

  test("Devin selected: the model list is SWE-2's, pre-selected with its default effort", async () => {
    render(
      <V3DraftChat data={data()} go={vi.fn()} act={actions()} id="devin" />,
    );
    expect(trigger()?.textContent).toContain("SWE-2");
    // The agent's default model's own effort ladder, default pre-selected.
    expect(effortTrigger()?.getAttribute("aria-label")).toBe(
      "Reasoning effort: High",
    );
    await act(async () => {
      fireEvent.click(trigger()!);
    });
    const pop = await screen.findByLabelText("Model", {
      selector: "[data-slot=popover-content]",
    });
    expect(rows(pop)).toEqual(["SWE-2", "SWE-2 high"]);
  });

  test("Hermes selected: the model list is Hermes's, and a no-effort model has no effort dropdown", async () => {
    render(
      <V3DraftChat data={data()} go={vi.fn()} act={actions()} id="hermes" />,
    );
    expect(trigger()?.textContent).toContain("Opus 5.5");
    expect(effortTrigger()).toBeNull();
    await act(async () => {
      fireEvent.click(trigger()!);
    });
    const pop = await screen.findByLabelText("Model", {
      selector: "[data-slot=popover-content]",
    });
    expect(rows(pop)).toEqual(["Opus 5.5", "Sonnet 5"]);
  });
});

describe("the new chat's Model chip follows the selected agent (#872)", () => {
  test("a Devin agent's picker lists Devin's catalog, never Hermes's", async () => {
    render(
      <V3DraftChat data={data()} go={vi.fn()} act={actions()} id="devin" />,
    );
    // Pre-selected: the agent's own model, in its own runtime's words.
    expect(trigger()?.textContent).toContain("SWE-2");
    expect(trigger()?.textContent).not.toContain("Opus");

    await act(async () => {
      fireEvent.click(trigger()!);
    });
    const pop = await screen.findByLabelText("Model", {
      selector: "[data-slot=popover-content]",
    });
    expect(within(pop).queryByText("Opus 5.5")).toBeNull();
    expect(within(pop).queryByText("Sonnet 5")).toBeNull();
  });

  test("a Devin agent's picker has no Edit models (Hermes's list) and refreshes Devin's own catalog (#895)", async () => {
    const refreshRuntimeModels = vi.fn(async () => {});
    const act0 = {
      ...actions(),
      setModelVisibility: vi.fn(),
      refreshModels: vi.fn(async () => {}),
      refreshRuntimeModels,
    } as unknown as V3Actions;
    render(<V3DraftChat data={data()} go={vi.fn()} act={act0} id="devin" />);
    await act(async () => {
      fireEvent.click(trigger()!);
    });
    const pop = await screen.findByLabelText("Model", {
      selector: "[data-slot=popover-content]",
    });
    expect(within(pop).queryByText("Edit models…")).toBeNull();
    await act(async () => {
      fireEvent.click(within(pop).getByText("Refresh models"));
    });
    const devinRt = data().runtimes?.find((r) => !r.isDefault)?.id;
    expect(refreshRuntimeModels).toHaveBeenCalledWith(devinRt);
    expect(act0.refreshModels).not.toHaveBeenCalled();
  });

  test("switching the agent switches the catalog and the start model", async () => {
    render(
      <V3DraftChat data={data()} go={vi.fn()} act={actions()} id="devin" />,
    );
    expect(trigger()?.textContent).toContain("SWE-2");
    await act(async () => {
      fireEvent.click(agentChip());
    });
    const menu = screen.getByRole("menu");
    fireEvent.click(
      within(menu).getByRole("menuitemradio", { name: /Hermes/ }),
    );
    // The Hermes agent's chip now reads the default engine's catalog.
    expect(trigger()?.textContent).toContain("Opus 5.5");
    expect(trigger()?.textContent).not.toContain("SWE-2");
    await act(async () => {
      fireEvent.click(trigger()!);
    });
    const pop = await screen.findByLabelText("Model", {
      selector: "[data-slot=popover-content]",
    });
    expect(within(pop).queryByText("SWE-2 high")).toBeNull();
  });

  test("a runtime agent with no landed catalog menus its own labels only", async () => {
    const d = data({ modelCatalogs: {} });
    render(<V3DraftChat data={d} go={vi.fn()} act={actions()} id="devin" />);
    const chip = screen.getByTitle("Model");
    await act(async () => {
      fireEvent.click(chip);
    });
    const menu = screen.getByRole("menu");
    // The runtime row's own labels — never Hermes's Opus rows.
    expect(
      within(menu).getByRole("menuitemradio", { name: "SWE-2" }),
    ).toBeTruthy();
    expect(
      within(menu).queryByRole("menuitemradio", { name: "Opus 5.5" }),
    ).toBeNull();
  });
});
