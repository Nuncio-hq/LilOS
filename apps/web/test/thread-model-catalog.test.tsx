// @vitest-environment happy-dom
/* #895 — an open thread's composer lists ITS agent's models. The hook reads
   the thread's runtime: a Hermes thread keeps the default engine's catalog
   and picker extras; a runtime thread reads that runtime's own catalog
   (`models.list {runtime}`, via v3/runtimes.ts) and none of Hermes's — no
   provider groups, no Edit models (Hermes's hide list), and Refresh re-asks
   the runtime. The relay is a fake; the catalog flow is the real store. */
import type { Employee } from "@lilos/contracts/app";
import type { ModelOption, ModelsListResult } from "@lilos/contracts/engine";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const HERMES_MODELS: ModelOption[] = [
  { id: "qwen", name: "Qwen", provider: "hpc" },
];
const DEVIN_MODELS: ModelOption[] = [
  {
    id: "swe-2-high",
    name: "SWE-2 High",
    provider: "devin",
    efforts: ["low", "thought_level"],
  },
];
const DEVIN_FRESH: ModelOption[] = [
  ...DEVIN_MODELS,
  { id: "swe-2-max", name: "SWE-2 Max", provider: "devin" },
];

const asked: { runtime?: string; refresh?: boolean }[] = [];
let devinModels: ModelOption[] = [];

vi.mock("../src/lib/runtime", async (orig) => {
  const actual = await orig<typeof import("../src/lib/runtime")>();
  const { atom } = await import("nanostores");
  const relay = {
    employees: atom<Employee[]>([]),
    status: atom<unknown>({}),
    listModels: vi.fn(
      async (p?: {
        runtime?: string;
        refresh?: boolean;
      }): Promise<ModelsListResult> => {
        asked.push({ runtime: p?.runtime, refresh: p?.refresh });
        return {
          models: p?.runtime === "acp:devin" ? devinModels : HERMES_MODELS,
          default: "swe-2-high",
          defaultProvider: "devin",
        };
      },
    ),
  };
  const engine = {
    description: atom({
      capabilities: [{ id: "models", detail: { refreshable: true } }],
    }),
  };
  return { ...actual, relay, engine };
});

/* The catalog store is module state (what each runtime was asked and
   answered): every test gets a fresh copy of the modules. */
let relay: typeof import("../src/lib/runtime").relay;
let engineModels: typeof import("../src/lib/runtime").engineModels;
let useModelCatalog: typeof import("../src/thread/use-model-catalog").useModelCatalog;

const setRoster = (devinState: string) =>
  relay.status.set({
    result: {
      runtimes: [
        { id: "hermes", label: "Hermes" },
        {
          id: "acp:devin",
          label: "Devin",
          available: true,
          state: devinState,
        },
      ],
    },
  } as never);

beforeEach(async () => {
  vi.resetModules();
  asked.length = 0;
  devinModels = DEVIN_MODELS;
  ({ relay, engineModels } = await import("../src/lib/runtime"));
  ({ useModelCatalog } = await import("../src/thread/use-model-catalog"));
  engineModels.set(HERMES_MODELS);
  relay.employees.set([
    { id: "emp_devin", runtime: "acp:devin" } as unknown as Employee,
  ]);
});
afterEach(cleanup);

describe("useModelCatalog on a runtime thread (#895)", () => {
  test("AC-5: a Hermes thread keeps the default engine's list and picker", () => {
    setRoster("running");
    const { result } = renderHook(() => useModelCatalog(undefined));
    expect(result.current.catalog).toBe(HERMES_MODELS);
    expect(result.current.own).toBe(false);
    expect(result.current.picker?.onVisibility).toBeTypeOf("function");
    expect(result.current.picker?.onRefresh).toBeTypeOf("function");
  });

  test("AC-5: the launcher literals (`hermes`, `default`) are Hermes threads too", () => {
    setRoster("running");
    for (const rt of ["hermes", "default"]) {
      const { result } = renderHook(() => useModelCatalog(rt));
      expect(result.current.catalog).toBe(HERMES_MODELS);
    }
  });

  test("AC-2: until the runtime's catalog lands the list is empty — never Hermes's", () => {
    // Not live: nothing asks the runtime yet.
    setRoster("stopped");
    const { result } = renderHook(() => useModelCatalog("acp:devin"));
    expect(result.current.catalog).toEqual([]);
    expect(result.current.picker).toBeUndefined();
    expect(result.current.own).toBe(true);
    expect(asked).toEqual([]);
  });

  test("AC-1/AC-3: the landed catalog is the runtime's own, with its efforts and default", async () => {
    setRoster("running");
    const { result } = renderHook(() => useModelCatalog("acp:devin"));
    await waitFor(() => expect(result.current.catalog).toEqual(DEVIN_MODELS));
    expect(result.current.catalog[0].efforts).toEqual(["low", "thought_level"]);
    expect(result.current.defaultModel).toBe("swe-2-high");
    expect(result.current.defaultProvider).toBe("devin");
  });

  test("AC-4: no Edit models / provider groups; Refresh re-asks the runtime", async () => {
    setRoster("running");
    const { result } = renderHook(() => useModelCatalog("acp:devin"));
    await waitFor(() => expect(result.current.picker).toBeDefined());
    expect(result.current.picker?.onVisibility).toBeUndefined();
    expect(result.current.picker?.visibility).toBeUndefined();
    expect(result.current.picker?.providers).toBeUndefined();

    devinModels = DEVIN_FRESH;
    asked.length = 0;
    await act(async () => {
      await result.current.picker?.onRefresh?.();
    });
    expect(asked).toEqual([{ runtime: "acp:devin", refresh: true }]);
    await waitFor(() => expect(result.current.catalog).toEqual(DEVIN_FRESH));
    // Hermes's own catalog is untouched.
    expect(engineModels.get()).toBe(HERMES_MODELS);
  });

  test("AC-4: an answered-empty refresh keeps the rows already known", async () => {
    setRoster("running");
    const { result } = renderHook(() => useModelCatalog("acp:devin"));
    await waitFor(() => expect(result.current.picker).toBeDefined());
    devinModels = [];
    await act(async () => {
      await result.current.picker?.onRefresh?.();
    });
    expect(result.current.catalog).toEqual(DEVIN_MODELS);
  });
});
