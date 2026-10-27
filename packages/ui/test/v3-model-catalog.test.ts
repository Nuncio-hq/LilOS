// @vitest-environment happy-dom
/* #872 seam: the composer's model list takes its options from the SELECTED
   agent's runtime — `modelCatalogOf` is the single lookup every chip's data
   input flows through, so the per-agent catalog lands as a body change,
   not a call-site one (PR #890 feeds `data.modelCatalogs`). */
import { describe, expect, test } from "vitest";
import type { V3Data } from "../src/v3/v3-data-types";
import { effortLadderOf, modelCatalogOf } from "../src/v3/v3-model";
import type { V3Agent } from "../src/v3/v3-types";

const CATALOG = {
  options: [{ id: "opus-5-5", name: "Opus 5.5", provider: "anthropic" }],
  defaultModel: "opus-5-5",
  defaultProvider: "anthropic",
};
const DEVIN_CATALOG = {
  options: [{ id: "swe-2", name: "SWE-2", provider: "cognition" }],
  defaultModel: "swe-2",
  defaultProvider: "cognition",
};

const data = (over: Partial<V3Data> = {}) =>
  ({
    modelCatalog: CATALOG,
    modelCatalogs: { "acp:devin": DEVIN_CATALOG },
    runtimes: [
      { id: "hermes", label: "Hermes", isDefault: true },
      { id: "acp:devin", label: "Devin", models: ["SWE-2"] },
    ],
    ...over,
  }) as V3Data;

const agent = (runtime?: string) => ({ runtime }) as V3Agent;

describe("modelCatalogOf (#872's per-agent data input)", () => {
  test("a default-runtime agent reads the engine's own catalog", () => {
    expect(modelCatalogOf(data(), agent("hermes"))).toBe(CATALOG);
    expect(modelCatalogOf(data(), agent())).toBe(CATALOG);
  });

  test("a runtime agent reads its OWN engine's catalog", () => {
    expect(modelCatalogOf(data(), agent("acp:devin"))).toBe(DEVIN_CATALOG);
  });

  /* A runtime whose catalog hasn't landed gets undefined — the chip then
     menus the runtime row's `models` labels, never the default engine's
     list on an ACP agent. */
  test("a runtime agent with no landed catalog falls to undefined, not the default list", () => {
    expect(
      modelCatalogOf(data({ modelCatalogs: {} }), agent("acp:devin")),
    ).toBeUndefined();
  });
});

/* #895: the open thread's composer asks the same lookup with only its
   agent's runtime — no whole V3Data, no whole agent. */
describe("modelCatalogOf for an open thread (#895)", () => {
  const src = (over: Partial<V3Data> = {}) => {
    const { modelCatalog, modelCatalogs, runtimes } = data(over);
    return { modelCatalog, modelCatalogs, runtimes };
  };

  test("a Devin thread reads Devin's catalog — never the default's", () => {
    expect(modelCatalogOf(src(), { runtime: "acp:devin" })).toBe(DEVIN_CATALOG);
  });

  test("a Hermes thread reads the default engine's catalog", () => {
    expect(modelCatalogOf(src(), { runtime: undefined })).toBe(CATALOG);
  });

  test("a Devin thread whose catalog has not landed reads nothing (a read-only chip, not Hermes's list)", () => {
    expect(
      modelCatalogOf(src({ modelCatalogs: {} }), { runtime: "acp:devin" }),
    ).toBeUndefined();
  });

  test("a runtime whose status row has not arrived reads nothing", () => {
    expect(
      modelCatalogOf(src({ runtimes: undefined }), { runtime: "acp:devin" }),
    ).toBeUndefined();
  });
});

describe("effortLadderOf follows the same catalog (#895 AC-3)", () => {
  test("a Devin agent's levels are Devin's for the picked model", () => {
    const d = data({
      modelCatalogs: {
        "acp:devin": {
          options: [
            {
              id: "swe-2-high",
              provider: "devin",
              efforts: ["low", "thought_level"],
              defaultEffort: "thought_level",
            },
          ],
        },
      },
    });
    expect(
      effortLadderOf(d, {
        runtime: "acp:devin",
        modelId: "swe-2-high",
      } as V3Agent),
    ).toEqual({
      efforts: ["low", "thought_level"],
      defaultEffort: "thought_level",
    });
  });
});
