// @vitest-environment happy-dom
/* Model picker v2 (Codex-style): one popover with the reasoning slider, the
   fast toggle and a "Model ›" drill-in list grouped by provider. Issue #30's
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
import { FocusComposer } from "../src/chat/focus-composer";
import {
  choiceFor,
  ModelPicker,
  sessionChoice,
  withSessionModel,
} from "../src/chat/model-picker";
import { isHidden, modelKey } from "../src/chat/model-visibility-dialog";
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

const body = () => document.body as HTMLElement;
const trigger = () => {
  const el = body().querySelector('[data-slot="model-picker-trigger"]');
  if (!el) throw new Error("no picker trigger");
  return el as HTMLElement;
};
const open = async () => {
  await act(async () => fireEvent.click(trigger()));
};
const openModels = async () => {
  await open();
  const row = [...body().querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Model"),
  );
  if (!row) throw new Error("no Model row");
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

describe("model picker v2", () => {
  test("AC-1 the Model list shows the engine's models grouped by provider", async () => {
    render(
      <Harness
        providers={[
          { id: "hpc", name: "HPC" },
          { id: "openai", name: "ChatGPT or Codex Subscription" },
        ]}
      />,
    );
    await openModels();
    const headings = [...body().querySelectorAll("[cmdk-group-heading]")].map(
      (el) => el.textContent,
    );
    // Engine-named providers win; unknown slugs get the models.dev name;
    // providerless models land in Other.
    expect(headings).toEqual([
      "HPC",
      "ChatGPT or Codex Subscription",
      "Anthropic",
      "Other",
    ]);
    for (const label of ["gpt-test-4o", "Claude test 4.5", "orphan-1"]) {
      expect(within(body()).getByText(label)).toBeTruthy();
    }
  });

  test("AC-2 picking a model reports its id + provider and that model's default effort", async () => {
    const picks: ModelChoice[] = [];
    render(<Harness picks={picks} />);
    await openModels();
    await act(async () =>
      fireEvent.click(within(body()).getByText("Claude test 4.5")),
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
      running: false,
      status: "ready" as const,
      placeholder: "Message…",
      hint: "",
      onSend: () => {},
    };
    const off = render(<FocusComposer {...props} />);
    expect(
      off.container.querySelector('[data-slot="model-picker-trigger"]'),
    ).toBeNull();
    const noHandler = render(<FocusComposer {...props} models={MODELS} />);
    expect(
      noHandler.container.querySelector('[data-slot="model-picker-trigger"]'),
    ).toBeNull();
  });

  test("the slider has exactly the steps the engine reported for THIS model", async () => {
    const { rerender } = render(<Harness />);
    await open();
    // No per-level tick buttons (Codex-style drag); the range input carries the ladder.
    expect(body().querySelector('button[aria-label="Medium"]')).toBeNull();
    const range = () => {
      const el = body().querySelector(
        'input[type="range"]',
      ) as HTMLInputElement;
      return [el.min, el.max, el.getAttribute("aria-valuetext")];
    };
    // gpt-test-5 reports 5 levels → 0..4, currently Medium.
    expect(range()).toEqual(["0", "4", "Medium"]);
    // Hermes' full ladder (engine couldn't say per model) → 7 steps.
    rerender(<Harness value={choiceFor("qwen", MODELS)} />);
    expect(range()).toEqual(["0", "6", "Medium"]);
    // No efforts → no slider at all.
    rerender(<Harness value={choiceFor("gpt-test-4o", MODELS)} />);
    expect(body().querySelector('[role="slider"]')).toBeNull();
    expect(body().textContent).toContain("no reasoning control");
  });

  test("an effort step reports the pick; the trigger shows model · effort", async () => {
    const picks: ModelChoice[] = [];
    render(<Harness picks={picks} />);
    expect(trigger().textContent).toContain("GPT test 5");
    expect(trigger().textContent).toContain("Medium");
    await open();
    // Keyboard on the slider moves one level: Medium → High.
    await act(async () =>
      fireEvent.keyDown(
        body().querySelector('input[type="range"]') as HTMLElement,
        { key: "ArrowRight" },
      ),
    );
    expect(picks.at(-1)).toMatchObject({
      model: "gpt-test-5",
      effort: "high",
    });
  });

  test("fast toggle renders only for a model with a fast tier", async () => {
    const picks: ModelChoice[] = [];
    const { rerender } = render(<Harness picks={picks} />);
    await open();
    const fast = body().querySelector('button[aria-label="Fast mode"]');
    expect(fast).toBeTruthy();
    await act(async () => fireEvent.click(fast as HTMLElement));
    expect(picks.at(-1)).toMatchObject({ model: "gpt-test-5", fast: true });
    rerender(<Harness value={choiceFor("qwen", MODELS)} />);
    expect(body().querySelector('button[aria-label="Fast mode"]')).toBeNull();
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
    expect(body().textContent).toContain("Engine default");
    // The slider is parked on the ladder's middle stop, not a claimed level.
    const range = body().querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    expect(range.getAttribute("aria-valuetext")).toBe("High");
  });
});

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
    const headings = [...body().querySelectorAll("[cmdk-group-heading]")].map(
      (el) => el.textContent,
    );
    expect(headings).toContain("Openai Codex");
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
    // Going ahead sends the pick.
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
    await act(async () => fireEvent.click(item("Claude test 4.5")));
    expect(body().textContent).not.toContain("can't switch back");
    expect(picks).toHaveLength(1);
  });
});
