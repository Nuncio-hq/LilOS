/* #872 — a coding-runtime agent's edits route to ITS engine, never the
   default's: `agents.describe`/`agents.update` carry `runtime`, model picks
   resolve against that runtime's own `models.list`, and a field the runtime
   hasn't declared writable is dropped instead of sent to fail. The relay is
   a recording fake; the catalog flow is the real store (v3/runtimes.ts). */
import type { Employee } from "@lilos/contracts/app";
import type {
  DescribeResult,
  ModelOption,
  ModelsListResult,
} from "@lilos/contracts/engine";
import { beforeEach, describe, expect, test, vi } from "vitest";

const calls: [string, unknown][] = [];
let employee: Employee;
let capabilities: DescribeResult["capabilities"];
/* status.result.runtimes: row 0 is the default engine (D-#761); a test
   rewrites the roster with `setRuntimes` — status is a real atom. */
interface RuntimeRow {
  id: string;
  label: string;
  available?: boolean;
  agentsUpdatable?: string[];
}

const DEVIN_MODELS: ModelOption[] = [
  { id: "swe-2-high", name: "SWE-2 High", provider: "devin" },
  { id: "swe-2-max", name: "SWE-2 Max", provider: "devin" },
];

vi.mock("../src/lib/runtime", async (orig) => {
  const actual = await orig<typeof import("../src/lib/runtime")>();
  const { atom } = await import("nanostores");
  /* A real atom — runtimes.ts's roster computed takes it as a dep. */
  const status = atom<{ result?: { runtimes?: RuntimeRow[] } }>({});
  const relay = {
    employees: { get: () => [employee], listen: () => () => {} },
    status,
    describeAgent: vi.fn(async (id: string) => ({ id, name: id })),
    updateAgent: vi.fn(async (p: unknown) => {
      calls.push(["agents.update", p]);
      return { agent: { id: (p as { id: string }).id } };
    }),
    updateEmployee: vi.fn(async (id: string, p: unknown) => {
      calls.push(["employees.update", { id, ...(p as object) }]);
    }),
    /* The harness routes `models.list` on the runtime hint; the fake
       answers only the runtime it is asked for. */
    listModels: vi.fn(
      async (p?: { runtime?: string }): Promise<ModelsListResult> => ({
        models: p?.runtime === "acp:devin" ? DEVIN_MODELS : [],
        default: "swe-2-high",
        defaultProvider: "devin",
      }),
    ),
    request: vi.fn(async () => ({ tasks: [] })),
  };
  const engine = {
    description: { get: () => ({ capabilities }), listen: () => () => {} },
  };
  return { ...actual, relay, engine };
});

import { relay } from "../src/lib/runtime";
import { saveAgent } from "../src/v3/employees";
import { runtimeRows } from "../src/v3/runtimes";

const devinEmployee = (): Employee => ({
  id: "emp_devin",
  name: "Devin",
  role: "Coding agent",
  status: "online",
  profile: "devin",
  runtime: "acp:devin",
  model: "swe-2-high",
  now: "",
  instructions: "",
  respondTo: "me",
  createdAt: 0,
});

const setRuntimes = (rows: RuntimeRow[]) =>
  relay.status.set({
    result: { runtimes: rows },
  } as unknown as ReturnType<typeof relay.status.get>);

beforeEach(() => {
  calls.length = 0;
  employee = devinEmployee();
  capabilities = [{ id: "agents", name: "Agents", detail: { updatable: [] } }];
  setRuntimes([
    { id: "hermes", label: "Hermes" },
    {
      id: "acp:devin",
      label: "Devin",
      available: true,
      agentsUpdatable: ["name", "description", "soul", "model"],
    },
  ]);
});

describe("saveAgent on a coding-runtime agent", () => {
  test("a description edit lands on acp:devin, gated on ITS updatable", async () => {
    await saveAgent("emp_devin", { description: "Ships PRs" });
    expect(calls).toEqual([
      [
        "agents.update",
        { id: "devin", runtime: "acp:devin", description: "Ships PRs" },
      ],
    ]);
  });

  test("a model pick resolves through acp:devin's own catalog", async () => {
    // Reading the roster asks the runtime for its catalog (it lazy-starts).
    const stop = runtimeRows().subscribe(() => {});
    await vi.waitFor(() =>
      expect(
        runtimeRows()
          .get()
          ?.find((r) => r.id === "acp:devin")?.models,
      ).toEqual(["SWE-2 High", "SWE-2 Max"]),
    );
    await saveAgent("emp_devin", { model: "SWE-2 Max" });
    expect(calls).toEqual([
      [
        "agents.update",
        {
          id: "devin",
          runtime: "acp:devin",
          model: "swe-2-max",
          provider: "devin",
        },
      ],
      ["employees.update", { id: "emp_devin", model: "swe-2-max", effort: "" }],
    ]);
    stop();
  });

  test("a field the runtime hasn't declared is never sent", async () => {
    setRuntimes([
      { id: "hermes", label: "Hermes" },
      {
        id: "acp:devin",
        label: "Devin",
        available: true,
        agentsUpdatable: ["model"],
      },
    ]);
    await saveAgent("emp_devin", { description: "Ships PRs" });
    // Nothing engine-side, and nothing record-side for description.
    expect(calls).toEqual([]);
  });

  test("a label the runtime's catalog doesn't know is not written", async () => {
    const stop = runtimeRows().subscribe(() => {});
    await vi.waitFor(() =>
      expect(
        runtimeRows()
          .get()
          ?.find((r) => r.id === "acp:devin")?.models?.length,
      ).toBe(2),
    );
    await saveAgent("emp_devin", { model: "Opus 5.5" });
    expect(calls).toEqual([]);
    stop();
  });

  test("a runtime row that hasn't been described gates everything engine-side", async () => {
    setRuntimes([
      { id: "hermes", label: "Hermes" },
      { id: "acp:devin", label: "Devin", available: true },
    ]);
    await saveAgent("emp_devin", { name: "Renamed", description: "x" });
    expect(calls).toEqual([
      ["employees.update", { id: "emp_devin", name: "Renamed" }],
    ]);
  });
});
