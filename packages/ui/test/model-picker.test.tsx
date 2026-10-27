// @vitest-environment happy-dom
/* Model picker (#886): two composer-row dropdowns — a searchable model
   list grouped by provider, and a plain effort menu of the engine's own
   levels. Issue #30's
   ACs still hold (engine list, pick reports the engine id, no picker without
   the capability); the rest pins the v2 behaviour agreed with the client. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { Composer } from "../src/chat/composer";
import {
  choiceFor,
  ModelPicker,
  sessionChoice,
  withSessionModel,
} from "../src/chat/model-picker";
import { isHidden, modelKey } from "../src/chat/model-visibility";
import type { ModelChoice, ModelOption, ModelVisibility } from "../src/types";

/* happy-dom does not implement every browser API the vendored components touch. */
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

const LADDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
/* A multi-provider catalog like a real Hermes `models.list` answer. */
const MODELS: ModelOption[] = [
  {
    id: "qwen",
    name: "Qwen",
    provider: "hpc",
    efforts: LADDER,
    defaultEffort: "medium",
  },
  {
    id: "gpt-test-5",
    name: "GPT test 5",
    provider: "openai",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    fast: true,
  },
  { id: "gpt-test-4o", provider: "openai" },
  { id: "claude-test-4.5", name: "Claude test 4.5", provider: "anthropic" },
  { id: "orphan-1" },
];

/* #194: a catalog shaped like a real Hermes `model.options` — several
   providers × many models with real Hermes id shapes (date pins, `[1m]`
   routes, `-fast` variants, `-900k` context ids, `devin/…` slashes). Names
   are what `listModels` derives; `custom-raw-id` is the id-only fallback. */
const CATALOG_PROVIDERS = [
  { id: "hpc", name: "HPC" },
  { id: "anthropic-cliproxy", name: "Anthropic – CLIProxyAPI" },
  { id: "openai-codex", name: "ChatGPT or Codex Subscription" },
  { id: "agentauth", name: "AgentAuth (Devin Cascade)" },
  { id: "xai-oauth", name: "xAI Grok OAuth" },
  { id: "cliproxy" },
];
const CATALOG: ModelOption[] = [
  {
    id: "qwen3.8-flash-next",
    name: "Qwen3.8 Flash Next",
    provider: "hpc",
    efforts: LADDER,
    defaultEffort: "medium",
  },
  { id: "qwen3-32b", name: "Qwen3 32B", provider: "hpc" },
  {
    id: "claude-opus-4-5-20251101",
    name: "Opus 4.5",
    provider: "anthropic-cliproxy",
    efforts: LADDER,
    defaultEffort: "high",
    fast: true,
  },
  {
    id: "claude-sonnet-5[1m]",
    name: "Sonnet 5 1M",
    provider: "anthropic-cliproxy",
  },
  {
    id: "claude-opus-4.8-fast",
    name: "Opus 4.8 Fast",
    provider: "anthropic-cliproxy",
  },
  {
    id: "gpt-6-sol-900k",
    name: "GPT-6-sol-900k",
    provider: "openai-codex",
    fast: true,
  },
  { id: "gpt-6-sol", name: "GPT-6-sol", provider: "openai-codex" },
  {
    id: "devin/claude-opus-5",
    name: "Opus 5",
    provider: "agentauth",
    fast: true,
  },
  { id: "devin/kimi-k3", name: "Kimi K3", provider: "agentauth" },
  { id: "grok-4.6", name: "Grok 4.6", provider: "xai-oauth" },
  { id: "custom-raw-id", provider: "cliproxy" },
];

const body = () => document.body as HTMLElement;
const trigger = () => {
  const el = body().querySelector('[data-slot="model-picker-trigger"]');
  if (!el) throw new Error("no picker trigger");
  return el as HTMLElement;
};
const open = async () => {
  await act(async () => fireEvent.click(trigger()));
};
/* #886: the model trigger IS the list — one click lands on the search. */
const openModels = open;
const effortTrigger = () => {
  const el = body().querySelector('[data-slot="effort-picker-trigger"]');
  if (!el) throw new Error("no effort trigger");
  return el as HTMLElement;
};
const openEffort = async () => {
  /* The trigger toggles — open only when its menu isn't already. */
  if (!body().querySelector('[aria-label="Reasoning levels"]'))
    await act(async () => fireEvent.click(effortTrigger()));
};
const pickEffort = async (label: string) => {
  const menu = body().querySelector('[aria-label="Reasoning levels"]');
  if (!menu) throw new Error("no effort menu");
  await act(async () =>
    fireEvent.click(
      within(menu as HTMLElement).getByRole("menuitemradio", { name: label }),
    ),
  );
};
/* Fast is a footer row in the model list now, not a button in the popover. */
const fastRow = () =>
  [...body().querySelectorAll("[cmdk-item]")].find((el) =>
    el.textContent?.includes("Fast mode"),
  ) as HTMLElement | undefined;
const clickFast = async () => {
  const row = fastRow();
  if (!row) throw new Error("no Fast mode row");
  await act(async () => fireEvent.click(row));
};

function Harness(
  props: Partial<Parameters<typeof ModelPicker>[0]> & {
    picks?: ModelChoice[];
  },
) {
  const { picks, ...rest } = props;
  return (
    <ModelPicker
      value={choiceFor("gpt-test-5", MODELS)}
      models={MODELS}
      onChoice={(c) => picks?.push(c)}
      {...rest}
    />
  );
}

const list = () => body().querySelector("[cmdk-list]") as HTMLElement;
const headings = () =>
  [...body().querySelectorAll("[cmdk-group-heading]")] as HTMLElement[];
const headingFor = (name: string) => {
  const h = headings().find((el) => el.textContent?.includes(name));
  if (!h) throw new Error(`no heading ${name}`);
  return h;
};
const searchBox = () => {
  const el = body().querySelector('[data-slot="command-input"]');
  if (!el) throw new Error("no search input");
  return el as HTMLInputElement;
};

describe("model picker v2", () => {
  test("AC-1 groups collapse except the current model's provider — headings carry name + count", async () => {
    render(
      <ModelPicker
        value={choiceFor("qwen3.8-flash-next", CATALOG)}
        models={CATALOG}
        onChoice={() => {}}
        providers={CATALOG_PROVIDERS}
      />,
    );
    await openModels();
    // Only HPC (the current model's provider) is expanded: its two rows are
    // visible, every other provider's rows stay collapsed behind a heading
    // with the model count.
    expect(within(list()).getByText("Qwen3.8 Flash Next")).toBeTruthy();
    expect(within(list()).getByText("Qwen3 32B")).toBeTruthy();
    for (const label of [
      "Opus 4.5",
      "GPT-6-sol-900k",
      "Opus 5",
      "Grok 4.6",
      "custom-raw-id",
    ]) {
      expect(within(list()).queryByText(label)).toBeNull();
    }
    // Headings show the provider name + model count, collapsed.
    const heads = headings().map((el) => el.textContent);
    expect(heads).toEqual([
      "HPC2",
      "Anthropic – CLIProxyAPI3",
      "ChatGPT or Codex Subscription2",
      "AgentAuth (Devin Cascade)2",
      "xAI Grok OAuth1",
      "Cliproxy1",
    ]);
    // The current row is the selected one — scrolled into view.
    const curRow = within(list())
      .getByText("Qwen3.8 Flash Next")
      .closest("[cmdk-item]") as HTMLElement;
    expect(curRow.getAttribute("aria-selected")).toBe("true");
  });

  test("AC-2 a heading toggles its group; search expands matches across providers and clearing restores", async () => {
    render(
      <ModelPicker
        value={choiceFor("qwen3.8-flash-next", CATALOG)}
        models={CATALOG}
        onChoice={() => {}}
        providers={CATALOG_PROVIDERS}
      />,
    );
    await openModels();
    // Click the AgentAuth heading → its rows open.
    await act(async () =>
      fireEvent.click(
        headingFor("AgentAuth").querySelector("button") as HTMLElement,
      ),
    );
    expect(within(list()).getByText("Opus 5")).toBeTruthy();
    expect(within(list()).getByText("Kimi K3")).toBeTruthy();
    // HPC is still open; others still collapsed.
    expect(within(list()).getByText("Qwen3.8 Flash Next")).toBeTruthy();
    expect(within(list()).queryByText("Grok 4.6")).toBeNull();
    // Search `opus` → matches from every provider, expanded.
    await act(async () =>
      fireEvent.change(searchBox(), { target: { value: "opus" } }),
    );
    expect(within(list()).getByText("Opus 4.5")).toBeTruthy();
    expect(within(list()).getByText("Opus 4.8 Fast")).toBeTruthy();
    expect(within(list()).getByText("Opus 5")).toBeTruthy();
    // Non-matching providers/rows are filtered out entirely.
    expect(within(list()).queryByText("Grok 4.6")).toBeNull();
    expect(within(list()).queryByText("Qwen3.8 Flash Next")).toBeNull();
    // Search matches the id too, not only the name.
    await act(async () =>
      fireEvent.change(searchBox(), { target: { value: "devin/" } }),
    );
    expect(within(list()).getByText("Opus 5")).toBeTruthy();
    expect(within(list()).getByText("Kimi K3")).toBeTruthy();
    // Clearing search restores the remembered collapsed/open state.
    await act(async () =>
      fireEvent.change(searchBox(), { target: { value: "" } }),
    );
    expect(within(list()).getByText("Opus 5")).toBeTruthy(); // toggled open earlier
    expect(within(list()).queryByText("Grok 4.6")).toBeNull();
    expect(within(list()).queryByText("Opus 4.5")).toBeNull();
    // Toggle AgentAuth back closed → remembered.
    await act(async () =>
      fireEvent.click(
        headingFor("AgentAuth").querySelector("button") as HTMLElement,
      ),
    );
    expect(within(list()).queryByText("Opus 5")).toBeNull();
    expect(within(list()).getByText("Qwen3.8 Flash Next")).toBeTruthy();
  });

  test("AC-3 rows show names — the raw id is only a fallback, the chip shows the same name", async () => {
    render(
      <ModelPicker
        value={choiceFor("qwen3.8-flash-next", CATALOG)}
        models={CATALOG}
        onChoice={() => {}}
        providers={CATALOG_PROVIDERS}
      />,
    );
    // Composer chip: the derived name, not `qwen3.8-flash-next`.
    expect(trigger().textContent).toContain("Qwen3.8 Flash Next");
    expect(trigger().textContent).not.toContain("qwen3.8-flash-next");
    await openModels();
    // Rows show the name; a model without a derivable name keeps the id.
    await act(async () =>
      fireEvent.click(
        headingFor("Cliproxy").querySelector("button") as HTMLElement,
      ),
    );
    expect(within(list()).getByText("custom-raw-id")).toBeTruthy();
    expect(within(list()).queryByText("claude-opus-4-5-20251101")).toBeNull();
  });

  test("the default-collapse rule applies on first open; toggles live for the picker's lifetime", async () => {
    render(
      <ModelPicker
        value={choiceFor("gpt-6-sol", CATALOG)}
        models={CATALOG}
        onChoice={() => {}}
        providers={CATALOG_PROVIDERS}
      />,
    );
    await openModels();
    // Current = openai-codex → only that group is open on first open.
    expect(within(list()).getByText("GPT-6-sol-900k")).toBeTruthy();
    expect(within(list()).queryByText("Qwen3.8 Flash Next")).toBeNull();
    // Toggle HPC open, close the popover, reopen → still open.
    await act(async () =>
      fireEvent.click(headingFor("HPC").querySelector("button") as HTMLElement),
    );
    expect(within(list()).getByText("Qwen3.8 Flash Next")).toBeTruthy();
    await act(async () => fireEvent.keyDown(body(), { key: "Escape" }));
    await openModels();
    expect(within(list()).getByText("Qwen3.8 Flash Next")).toBeTruthy();
    expect(within(list()).getByText("GPT-6-sol-900k")).toBeTruthy();
    expect(within(list()).queryByText("Grok 4.6")).toBeNull();
  });

  test("the engine's models group by provider (name + count headings)", async () => {
    render(
      <Harness
        providers={[
          { id: "hpc", name: "HPC" },
          { id: "openai", name: "ChatGPT or Codex Subscription" },
        ]}
      />,
    );
    await openModels();
    const heads = headings().map((el) => el.textContent);
    // Engine-named providers win; unknown slugs get the models.dev name;
    // providerless models land in Other. Only openai (current) is expanded.
    expect(heads).toEqual([
      "HPC1",
      "ChatGPT or Codex Subscription2",
      "Anthropic1",
      "Other1",
    ]);
    for (const label of ["GPT test 5", "gpt-test-4o"]) {
      expect(within(list()).getByText(label)).toBeTruthy();
    }
    for (const label of ["Qwen", "Claude test 4.5", "orphan-1"]) {
      expect(within(list()).queryByText(label)).toBeNull();
    }
  });

  test("AC-2 picking a model reports its id + provider and that model's default effort", async () => {
    const picks: ModelChoice[] = [];
    render(<Harness picks={picks} />);
    await openModels();
    // #194: the Anthropic group starts collapsed — open it to pick.
    await act(async () =>
      fireEvent.click(
        headingFor("Anthropic").querySelector("button") as HTMLElement,
      ),
    );
    await act(async () =>
      fireEvent.click(within(list()).getByText("Claude test 4.5")),
    );
    // Claude test 4.5 reports no efforts → no effort in the pick; fast is
    // sent as false so an engine that retains the tier across switches
    // still turns it off.
    expect(picks).toEqual([
      {
        model: "claude-test-4.5",
        provider: "anthropic",
        effort: undefined,
        fast: false,
      },
    ]);
  });

  test("AC-3 the composer shows no picker without a handler or a model list", () => {
    const props = {
      placeholder: "Message…",
      employees: [],
      hint: "",
      onSend: () => {},
    };
    const off = render(<Composer {...props} />);
    expect(
      off.container.querySelector('[data-slot="model-picker-trigger"]'),
    ).toBeNull();
    const noHandler = render(<Composer {...props} models={MODELS} />);
    expect(
      noHandler.container.querySelector('[data-slot="model-picker-trigger"]'),
    ).toBeNull();
  });

  test("the one Composer draws the picker between the attach button and the tools slot", () => {
    /* Narrow thread and widened Focus both render this Composer: the picker
       sits right after the paperclip and before the host's pills. */
    const r = render(
      <Composer
        placeholder="Message…"
        employees={[]}
        hint=""
        accept="image/*"
        models={MODELS}
        onModel={() => {}}
        tools={<span data-testid="tools-slot">pills</span>}
      />,
    );
    const trigger = r.container.querySelector(
      '[data-slot="model-picker-trigger"]',
    ) as HTMLElement;
    const attach = r.container.querySelector(
      '[aria-label="Attach files"]',
    ) as HTMLElement;
    const tools = r.getByTestId("tools-slot");
    expect(trigger).toBeTruthy();
    expect(
      attach.compareDocumentPosition(trigger) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      trigger.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("the Composer's picker defaults to the first model, shows the session's pick, and forwards the open state", async () => {
    const opens: boolean[] = [];
    const view = (extra: Partial<Parameters<typeof Composer>[0]> = {}) => (
      <Composer
        placeholder="Message…"
        employees={[]}
        hint=""
        models={MODELS}
        onModel={() => {}}
        onModelOpen={(o) => opens.push(o)}
        {...extra}
      />
    );
    const r = render(view());
    expect(trigger().textContent).toContain("Qwen");
    r.rerender(view({ choice: choiceFor("claude-test-4.5", MODELS) }));
    expect(trigger().textContent).toContain("Claude test 4.5");

    /* The trigger reports through onModelOpen; modelOpen drives it from the
       host (`/model` opens the picker). */
    await open();
    expect(opens).toEqual([true]);
    expect(body().querySelector('[data-slot="popover-content"]')).toBeNull();
    await act(async () => r.rerender(view({ modelOpen: true })));
    expect(
      body().querySelector('[data-slot="popover-content"]'),
    ).not.toBeNull();
  });

  test("the effort dropdown lists exactly the levels the engine reported for THIS model", async () => {
    const { rerender } = render(<Harness />);
    await openEffort();
    const levels = () =>
      [
        ...body().querySelectorAll(
          '[aria-label="Reasoning levels"] [role="menuitemradio"]',
        ),
      ] as HTMLElement[];
    // gpt-test-5 reports 5 levels, currently Medium.
    expect(levels().map((b) => b.textContent?.trim())).toEqual([
      "Low",
      "Medium",
      "High",
      "Extra high",
      "Max",
    ]);
    expect(
      levels().find((b) => b.getAttribute("aria-checked") === "true")
        ?.textContent,
    ).toBe("Medium");
    // Hermes' full ladder (engine couldn't say per model) → all 7. The
    // menu stays open across the rerender.
    rerender(<Harness value={choiceFor("qwen", MODELS)} />);
    expect(levels()).toHaveLength(7);
    // No efforts → no effort chip at all.
    rerender(<Harness value={choiceFor("gpt-test-4o", MODELS)} />);
    expect(
      body().querySelector('[data-slot="effort-picker-trigger"]'),
    ).toBeNull();
  });

  test("an effort pick reports the choice; the trigger shows model · effort", async () => {
    const picks: ModelChoice[] = [];
    render(<Harness picks={picks} />);
    expect(trigger().textContent).toContain("GPT test 5");
    expect(effortTrigger().textContent).toContain("Medium");
    await openEffort();
    await pickEffort("High");
    expect(picks.at(-1)).toMatchObject({
      model: "gpt-test-5",
      effort: "high",
    });
  });

  test("fast toggle renders only for a model with a fast tier", async () => {
    const picks: ModelChoice[] = [];
    const { rerender } = render(<Harness picks={picks} />);
    await open();
    expect(fastRow()).toBeTruthy();
    await clickFast();
    expect(picks.at(-1)).toMatchObject({ model: "gpt-test-5", fast: true });
    rerender(<Harness value={choiceFor("qwen", MODELS)} />);
    expect(fastRow()).toBeUndefined();
  });

  /* #807: mid-turn pick. The model write echoes before Fast does. That
     echo must not wipe the draft, or the next effort pick composes from
     it and sends Fast back off. */
  test("a model echo without Fast leaves the Fast draft for the next effort pick", async () => {
    const picks: ModelChoice[] = [];
    const { rerender } = render(
      <Harness picks={picks} value={choiceFor("qwen", MODELS)} />,
    );
    await openModels();
    await act(async () =>
      fireEvent.click(
        headingFor("OpenAI").querySelector("button") as HTMLElement,
      ),
    );
    await act(async () =>
      fireEvent.click(within(list()).getByText("GPT test 5")),
    );
    await open();
    await clickFast();
    expect(picks.at(-1)).toMatchObject({ model: "gpt-test-5", fast: true });
    /* The model write's echo: gpt-test-5 landed, Fast has not. */
    await act(async () =>
      rerender(
        <Harness picks={picks} value={choiceFor("gpt-test-5", MODELS)} />,
      ),
    );
    await openEffort();
    await pickEffort("High");
    expect(picks.at(-1)).toMatchObject({
      model: "gpt-test-5",
      effort: "high",
      fast: true,
    });
  });

  /* The engine owns Fast and effort. An echo that is not an earlier write
     — Fast explicitly off, or a different effort — replaces the draft so
     the trigger does not keep a pick the engine rejected (#807). */
  test("an echo with Fast off drops a Fast draft the engine refused", async () => {
    const picks: ModelChoice[] = [];
    const { rerender } = render(<Harness picks={picks} />);
    await open();
    await clickFast();
    expect(picks.at(-1)).toMatchObject({ fast: true });
    expect(body().querySelector('[aria-label="Fast"]')).toBeTruthy();
    await act(async () =>
      rerender(
        <Harness
          picks={picks}
          value={{ ...choiceFor("gpt-test-5", MODELS), fast: false }}
        />,
      ),
    );
    expect(body().querySelector('[aria-label="Fast"]')).toBeNull();
    await openEffort();
    await pickEffort("High");
    expect(picks.at(-1)).toMatchObject({ fast: false, effort: "high" });
  });

  test("an echo with a normalised effort replaces the draft", async () => {
    const picks: ModelChoice[] = [];
    const { rerender } = render(<Harness picks={picks} />);
    await openEffort();
    await pickEffort("High");
    expect(picks.at(-1)).toMatchObject({ effort: "high" });
    expect(effortTrigger().textContent).toContain("High");
    await act(async () =>
      rerender(
        <Harness
          picks={picks}
          value={{ ...choiceFor("gpt-test-5", MODELS), effort: "low" }}
        />,
      ),
    );
    expect(effortTrigger().textContent).toContain("Low");
    expect(effortTrigger().textContent).not.toContain("High");
  });

  /* Three writes queued before any echo: model, then Fast, then effort.
     The first echo is only the model write. Popping it and then treating
     the effort mismatch as a rewrite used to wipe High and Fast (#807). */
  test("a model echo with Fast and effort still in flight keeps both", async () => {
    const picks: ModelChoice[] = [];
    const { rerender } = render(
      <Harness picks={picks} value={choiceFor("qwen", MODELS)} />,
    );
    await openModels();
    await act(async () =>
      fireEvent.click(
        headingFor("OpenAI").querySelector("button") as HTMLElement,
      ),
    );
    await act(async () =>
      fireEvent.click(within(list()).getByText("GPT test 5")),
    );
    await open();
    await clickFast();
    await openEffort();
    await pickEffort("High");
    expect(picks).toHaveLength(3);
    expect(picks[2]).toMatchObject({
      model: "gpt-test-5",
      effort: "high",
      fast: true,
    });
    expect(effortTrigger().textContent).toContain("High");
    expect(trigger().querySelector('[aria-label="Fast"]')).toBeTruthy();
    await act(async () =>
      rerender(
        <Harness picks={picks} value={choiceFor("gpt-test-5", MODELS)} />,
      ),
    );
    expect(effortTrigger().textContent).toContain("High");
    expect(effortTrigger().textContent).not.toContain("Medium");
    expect(trigger().querySelector('[aria-label="Fast"]')).toBeTruthy();
  });

  /* The harness stores a refused Fast as null; the relay maps that to
     undefined, not false. That echo is not the Fast-on write, so the
     draft drops (#807). */
  test("a Fast refusal echoed as undefined drops the draft", async () => {
    const picks: ModelChoice[] = [];
    /* The prop has to move: a refusal that stays `undefined` is the same
       value the picker already showed. Explicit false, then undefined, is
       what the relay emits when the harness writes null. */
    const { rerender } = render(
      <Harness
        picks={picks}
        value={{ ...choiceFor("gpt-test-5", MODELS), fast: false }}
      />,
    );
    await open();
    await clickFast();
    expect(picks.at(-1)).toMatchObject({ fast: true });
    expect(trigger().querySelector('[aria-label="Fast"]')).toBeTruthy();
    await act(async () =>
      rerender(
        <Harness
          picks={picks}
          value={{ ...choiceFor("gpt-test-5", MODELS), fast: undefined }}
        />,
      ),
    );
    expect(trigger().querySelector('[aria-label="Fast"]')).toBeNull();
    await openEffort();
    await pickEffort("High");
    expect(picks.at(-1)).toMatchObject({ fast: false, effort: "high" });
  });

  test("Refresh / Edit models render only with their handlers (D-#19)", async () => {
    const { unmount } = render(<Harness />);
    await openModels();
    expect(body().textContent).not.toContain("Refresh models");
    expect(body().textContent).not.toContain("Edit models");
    unmount();
    let refreshed = 0;
    render(
      <Harness
        onRefresh={async () => {
          refreshed++;
        }}
        visibility={{ providers: [], models: [] }}
        onVisibility={() => {}}
      />,
    );
    await openModels();
    expect(body().textContent).toContain("Edit models");
    await act(async () =>
      fireEvent.click(within(body()).getByText("Refresh models")),
    );
    expect(refreshed).toBe(1);
  });

  test("hidden models leave the list; the current model always stays", async () => {
    const v: ModelVisibility = {
      providers: ["anthropic"],
      models: [modelKey(MODELS[0])],
    };
    render(
      <Harness
        value={choiceFor("qwen", MODELS)}
        visibility={v}
        onVisibility={() => {}}
      />,
    );
    await openModels();
    const list = body().querySelector("[cmdk-list]") as HTMLElement;
    expect(within(list).queryByText("Claude test 4.5")).toBeNull();
    // Qwen is hidden but it is the session's model — still shown.
    expect(within(list).getByText("Qwen")).toBeTruthy();
    // Openai starts collapsed (the current model sits in hpc) — open it to
    // check its rows survived. No `providers` prop here → models.dev name.
    await act(async () =>
      fireEvent.click(
        headingFor("OpenAI").querySelector("button") as HTMLElement,
      ),
    );
    expect(within(list).getByText("GPT test 5")).toBeTruthy();
  });
});

describe("model choice rules", () => {
  test("a new session starts on the employee default with its default effort", () => {
    expect(sessionChoice({}, "gpt-test-5", MODELS)).toEqual({
      model: "gpt-test-5",
      provider: "openai",
      effort: "medium",
    });
  });

  test("a session keeps its own pick", () => {
    expect(
      sessionChoice(
        { model: "qwen", provider: "hpc", effort: "high", fast: false },
        "gpt-test-5",
        MODELS,
      ),
    ).toEqual({ model: "qwen", provider: "hpc", effort: "high", fast: false });
  });

  test("a hidden provider hides its models, including ones it adds later", () => {
    const v = { providers: ["openai"], models: [] };
    expect(isHidden(MODELS[1], v)).toBe(true);
    expect(isHidden({ id: "gpt-new", provider: "openai" }, v)).toBe(true);
    expect(isHidden(MODELS[0], v)).toBe(false);
  });

  test("the engine's defaultProvider disambiguates a same-id default model", () => {
    // `opus` exists under two providers; the engine says the default is hpc's.
    const dupes: ModelOption[] = [
      { id: "opus", provider: "openai" },
      { id: "opus", provider: "hpc" },
    ];
    expect(sessionChoice({}, undefined, dupes, "opus", "hpc")).toEqual({
      model: "opus",
      provider: "hpc",
      effort: undefined,
    });
    // Without it, the first row with the id wins.
    expect(sessionChoice({}, undefined, dupes, "opus")).toEqual({
      model: "opus",
      provider: "openai",
      effort: undefined,
    });
  });

  test("a model whose effort the engine never reported shows Engine default, not a guess", async () => {
    const withMystery: ModelOption[] = [
      ...MODELS,
      { id: "mystery", provider: "hpc", efforts: LADDER },
    ];
    render(
      <ModelPicker
        value={{ model: "mystery", provider: "hpc" }}
        models={withMystery}
        onChoice={() => {}}
      />,
    );
    await open();
    /* The effort chip reads "Engine default" — no level is claimed, and
       none of the menu rows is checked. */
    expect(effortTrigger().textContent).toContain("Engine default");
    await openEffort();
    expect(
      body().querySelector(
        '[aria-label="Reasoning levels"] [aria-checked="true"]',
      ),
    ).toBeNull();
    expect(
      body().querySelectorAll(
        '[aria-label="Reasoning levels"] [role="menuitemradio"]',
      ),
    ).toHaveLength(LADDER.length);
  });
});

/* D-#140: the picker shows the session's own model even when the catalog
   omits it; Refresh is the path back. */
describe("model picker #140: the session's own model missing from the catalog", () => {
  /* The Hermes/Astra case: the session runs gpt-6-astra while a normal
     models.list omits it (account-gated rows only show on refresh). */
  const ASTRA = { id: "gpt-6-astra", provider: "openai-codex" };
  const astraPick = { model: "gpt-6-astra", provider: "openai-codex" };

  /* The list-row CommandItem carrying a label (the trigger shows the same
     model name — text queries against body() would match both). */
  const item = (label: string) => {
    const el = [...body().querySelectorAll("[cmdk-item]")].find((i) =>
      i.textContent?.includes(label),
    );
    if (!el) throw new Error(`no model row ${label}`);
    return el as HTMLElement;
  };

  test("AC-1 withSessionModel appends only the session's pick, marked notInList", () => {
    // Absent from the catalog → appended.
    const merged = withSessionModel(MODELS, astraPick);
    expect(merged).toHaveLength(MODELS.length + 1);
    expect(merged.at(-1)).toEqual({ ...ASTRA, notInList: true });
    // Already listed → the catalog row stands as-is.
    expect(withSessionModel(MODELS, choiceFor("qwen", MODELS))).toBe(MODELS);
    // The same id under a DIFFERENT provider is still a different model.
    const other = withSessionModel(MODELS, {
      model: "qwen",
      provider: "other-co",
    });
    expect(other.at(-1)).toEqual({
      id: "qwen",
      provider: "other-co",
      notInList: true,
    });
    // No session model → nothing to merge.
    expect(withSessionModel(MODELS, { model: "" })).toBe(MODELS);
  });

  test("AC-1 the trigger and the checked row show the unlisted model, marked Not in list", async () => {
    render(
      <ModelPicker value={astraPick} models={MODELS} onChoice={() => {}} />,
    );
    expect(trigger().textContent).toContain("gpt-6-astra");
    await openModels();
    const row = item("gpt-6-astra");
    expect(row.textContent).toContain("Not in list");
    expect(row.getAttribute("data-checked")).toBe("true");
    // Only the session's own row is added.
    expect(within(body()).getAllByText("Not in list")).toHaveLength(1);
    // A provider the engine never named still gets a group — not a leak.
    // (#194: headings carry the model count, e.g. "Openai Codex1".)
    expect(
      headings()
        .map((el) => el.textContent)
        .join(" "),
    ).toContain("Openai Codex");
  });

  test("AC-2 the row's hint runs Refresh; once the engine lists the model the hint is gone", async () => {
    const refreshes: number[] = [];
    const onRefresh = async () => {
      refreshes.push(1);
    };
    const { rerender } = render(
      <ModelPicker
        value={astraPick}
        models={MODELS}
        onChoice={() => {}}
        onRefresh={onRefresh}
      />,
    );
    await openModels();
    await act(async () => fireEvent.click(item("gpt-6-astra")));
    expect(refreshes).toHaveLength(1);
    // The engine now offers it: the parent's new models prop lands and the
    // row is a normal catalog row again — no hint, still checked.
    rerender(
      <ModelPicker
        value={astraPick}
        models={[...MODELS, { ...ASTRA, name: "GPT 6 Astra" }]}
        onChoice={() => {}}
        onRefresh={onRefresh}
      />,
    );
    expect(body().textContent).not.toContain("Not in list");
    expect(item("GPT 6 Astra").getAttribute("data-checked")).toBe("true");
  });

  test("AC-3 after Refresh still omits it, switching away warns; cancel keeps, go ahead picks", async () => {
    const picks: ModelChoice[] = [];
    render(
      <Harness value={astraPick} picks={picks} onRefresh={async () => {}} />,
    );
    await openModels();
    // #194: Anthropic starts collapsed — open it to reach its rows.
    await act(async () =>
      fireEvent.click(
        headingFor("Anthropic").querySelector("button") as HTMLElement,
      ),
    );
    // Run Refresh (the engine still doesn't offer the model)…
    await act(async () => fireEvent.click(item("gpt-6-astra")));
    // …then pick a catalog model → the warning shows the exact copy.
    await act(async () => fireEvent.click(item("Claude test 4.5")));
    expect(body().textContent).toContain(
      "You can't switch back to gpt-6-astra from LilOS",
    );
    // Cancel keeps the session's pick — nothing is sent.
    await act(async () => fireEvent.click(within(body()).getByText("Cancel")));
    expect(picks).toHaveLength(0);
    // Going ahead sends the pick. The Anthropic toggle is remembered
    // (#194), so its rows are still open here.
    await openModels();
    await act(async () => fireEvent.click(item("Claude test 4.5")));
    await act(async () =>
      fireEvent.click(within(body()).getByText("Switch anyway")),
    );
    expect(picks).toEqual([
      { model: "claude-test-4.5", provider: "anthropic", fast: false },
    ]);
  });

  test("AC-3 switching away warns only once a refresh ran — a stale cache alone doesn't warn", async () => {
    const picks: ModelChoice[] = [];
    render(<Harness value={astraPick} picks={picks} />);
    await openModels();
    // #194: Anthropic starts collapsed — open it to reach its rows.
    await act(async () =>
      fireEvent.click(
        headingFor("Anthropic").querySelector("button") as HTMLElement,
      ),
    );
    await act(async () => fireEvent.click(item("Claude test 4.5")));
    expect(body().textContent).not.toContain("can't switch back");
    expect(picks).toHaveLength(1);
  });
});
