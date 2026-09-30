import {
  effortIndex,
  effortOf,
  findModel,
  isModelHidden,
  type ModelRow,
  modelKeyOf,
  nextModelPick,
  pickableModels,
} from "@lilos/ui-native/model-rules";
import { hasProviderLogo } from "@lilos/ui-native/provider-logos";
import { describe, expect, it } from "vitest";
import {
  defaultModelPick,
  openConversationParams,
  toModelCatalog,
} from "../src/dm-model";

/* #160 — the mobile composer's model picker mirrors the Mac: the engine's
   real models grouped by provider with logos and the shared hide list
   honoured (AC-1/AC-3), that model's own effort ladder + Fast tier (AC-2),
   and the pick applied next-turn with provider disambiguation (AC-4).
   Pure rules — the sheet and screens are thin wiring over these. */

const MODELS: ModelRow[] = [
  {
    id: "opus",
    name: "Claude Opus 4.5",
    provider: "anthropic",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    fast: true,
  },
  {
    id: "sonnet",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "gpt-5",
    name: "GPT-5",
    provider: "openai",
    efforts: ["minimal", "low", "medium", "high"],
    fast: true,
  },
  { id: "local-8b", name: "Local 8B", provider: "ollama" },
  {
    id: "opus",
    name: "Claude Opus 4.5",
    provider: "openrouter",
    efforts: ["low", "high"],
  },
];

describe("AC-1: the picker lists the engine's models minus the shared hide list", () => {
  it("AC-1 drops models whose provider is hidden, and single hidden model keys", () => {
    const shown = pickableModels(MODELS, {
      providers: ["openai"],
      models: ["anthropic::sonnet"],
    });
    expect(shown.map((m) => `${m.provider}::${m.id}`)).toEqual([
      "anthropic::opus",
      "ollama::local-8b",
      "openrouter::opus",
    ]);
  });

  it("AC-1 keeps the session's own pick visible even when its provider is hidden", () => {
    const shown = pickableModels(
      MODELS,
      { providers: ["anthropic"], models: [] },
      { model: "opus", provider: "anthropic" },
    );
    expect(shown.map((m) => `${m.provider}::${m.id}`)).toEqual([
      "anthropic::opus",
      "openai::gpt-5",
      "ollama::local-8b",
      "openrouter::opus",
    ]);
  });

  it("AC-1 merges the session's off-catalog pick as a notInList row", () => {
    const shown = pickableModels(MODELS, undefined, {
      model: "opus-5.5",
      provider: "anthropic",
    });
    const merged = shown.find((m) => m.id === "opus-5.5");
    expect(merged).toMatchObject({
      id: "opus-5.5",
      provider: "anthropic",
      notInList: true,
    });
    // …and it stays visible even hidden in the shared list.
    const still = pickableModels(
      MODELS,
      { providers: ["anthropic"], models: [] },
      { model: "opus-5.5", provider: "anthropic" },
    );
    expect(still.some((m) => m.id === "opus-5.5")).toBe(true);
  });

  it("AC-1 key-matches on provider::id so the same id under two providers is distinct", () => {
    expect(modelKeyOf({ id: "opus", provider: "anthropic" })).toBe(
      "anthropic::opus",
    );
    expect(
      isModelHidden(
        { id: "opus", provider: "openrouter" },
        { providers: [], models: ["anthropic::opus"] },
      ),
    ).toBe(false);
    expect(
      isModelHidden(
        { id: "opus", provider: "anthropic" },
        { providers: [], models: ["anthropic::opus"] },
      ),
    ).toBe(true);
    // …and row lookup honours the pick's provider the same way.
    expect(findModel(MODELS, { model: "opus" })?.provider).toBe("anthropic");
    expect(findModel(MODELS, { model: "opus", provider: "openrouter" })).toBe(
      MODELS[4],
    );
  });
});

describe("AC-2: effort ladder = the model's efforts; Fast only when it has it", () => {
  it("AC-2 keeps the current effort when the new model's ladder has it", () => {
    const opus = MODELS[0]!;
    const gpt = MODELS[2]!;
    expect(nextModelPick({ effort: "high", fast: true }, gpt)).toEqual({
      model: "gpt-5",
      provider: "openai",
      effort: "high",
      fast: true,
    });
    expect(nextModelPick({ effort: "high" }, opus)).toEqual({
      model: "opus",
      provider: "anthropic",
      effort: "high",
      fast: false,
    });
  });

  it("AC-2 falls back to the target's default effort, then to nothing", () => {
    const orOpus = MODELS[4]!; // ladder low|high — "medium" isn't on it
    const sonnet = MODELS[1]!;
    expect(nextModelPick({ effort: "medium" }, orOpus)).toEqual({
      model: "opus",
      provider: "openrouter",
      fast: false,
    });
    // ollama's local model has no ladder at all → effort omitted.
    expect(nextModelPick({ effort: "high" }, MODELS[3]!)).toEqual({
      model: "local-8b",
      provider: "ollama",
      fast: false,
    });
    expect(nextModelPick({}, sonnet).effort).toBe("medium");
  });

  it("AC-2 sends explicit fast:false (not a dropped field) when the target has no fast tier", () => {
    const sonnet = MODELS[1]!; // fast undefined on the wire
    const pick = nextModelPick({ effort: "low", fast: true }, sonnet);
    expect(pick.fast).toBe(false);
    expect(Object.keys(pick)).toContain("fast");
  });

  it("AC-2 'Engine default': a ladder with nothing picked reports no effort and parks mid", () => {
    const orOpus = MODELS[4]!; // ladder low|high, no declared default
    expect(effortOf({}, orOpus)).toBeUndefined();
    expect(effortIndex(undefined, orOpus.efforts!)).toBe(0); // mid of low|high
    // …a declared default IS the effective effort (web defaultEffort)…
    const opus = MODELS[0]!;
    expect(effortOf({}, opus)).toBe("medium");
    // …while a picked rung is honoured verbatim.
    expect(effortOf({ effort: "high" }, opus)).toBe("high");
    expect(effortIndex("high", opus.efforts!)).toBe(2);
    // A rung the ladder doesn't have falls back to the model's own default.
    expect(effortOf({ effort: "ultra" }, opus)).toBe("medium");
  });
});

describe("AC-3: provider logos for known slugs, generic chip otherwise", () => {
  it("AC-3 marks models.dev-known provider ids with a logo slug", () => {
    const { providers } = toModelCatalog({
      models: [],
      providers: [
        { id: "anthropic", name: "Anthropic" },
        { id: "openai-codex", name: "OpenAI Codex" },
        { id: "hpc", name: "HPC" },
        { id: "ollama", name: "Ollama" },
      ],
    });
    expect(providers.map((p) => [p.id, p.logo])).toEqual([
      ["anthropic", "anthropic"],
      ["openai-codex", "openai"],
      ["hpc", "alibaba"],
      ["ollama", undefined],
    ]);
  });

  it("AC-3 knows the whole models.dev set the Mac renders, never a broken image", () => {
    for (const slug of [
      "alibaba",
      "amazon",
      "anthropic",
      "azure",
      "cerebras",
      "cohere",
      "deepseek",
      "fireworks",
      "github-copilot",
      "google",
      "groq",
      "meta",
      "mistral",
      "moonshotai",
      "nvidia",
      "openai",
      "openrouter",
      "togetherai",
      "vercel",
      "xai",
      "zai",
    ]) {
      expect(hasProviderLogo(slug), slug).toBe(true);
    }
    expect(hasProviderLogo("ollama")).toBe(false);
    expect(hasProviderLogo("fake")).toBe(false);
    expect(hasProviderLogo(undefined)).toBe(false);
  });
});

describe("AC-4: the pick applies next turn with provider disambiguation", () => {
  it("AC-4 defaultModelPick carries the provider of the row it chose", () => {
    const pick = defaultModelPick({
      employeeModel: undefined,
      models: MODELS,
      defaultModel: "opus",
      defaultProvider: "openrouter",
    });
    // Same id under two providers — the engine default's provider wins.
    expect(pick).toEqual({ model: "opus", provider: "openrouter" });
    expect(
      defaultModelPick({ employeeModel: "gpt-5", models: MODELS }),
    ).toEqual({ model: "gpt-5", provider: "openai" });
  });

  it("AC-4 openConversationParams stamps the picked provider for a shared id", () => {
    const params = openConversationParams({
      workspace: { folder: null, base: "", mode: "direct" },
      folders: [],
      model: { model: "opus", provider: "openrouter", effort: "high" },
      models: MODELS,
    });
    expect(params).toEqual({
      model: "opus",
      provider: "openrouter",
      effort: "high",
    });
    // An unpinned id resolves the first matching row's provider.
    expect(
      openConversationParams({
        workspace: { folder: null, base: "", mode: "direct" },
        folders: [],
        model: { model: "opus" },
        models: MODELS,
      }).provider,
    ).toBe("anthropic");
    // An off-catalog pick with a provider still sends it (the engine resolves).
    expect(
      openConversationParams({
        workspace: { folder: null, base: "", mode: "direct" },
        folders: [],
        model: { model: "opus-5.5", provider: "anthropic" },
        models: MODELS,
      }),
    ).toEqual({ model: "opus-5.5", provider: "anthropic" });
  });
});
