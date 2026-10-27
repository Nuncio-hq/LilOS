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
  state?: string;
  detail?: string;
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
import { profileKey } from "../src/v3/profiles";
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
      state: "running",
      agentsUpdatable: ["name", "description", "soul", "model"],
    },
  ]);
});

describe("saveAgent on a coding-runtime agent", () => {
  test("a description edit lands on acp:devin, and mirrors onto the record", async () => {
    await saveAgent("emp_devin", { description: "Ships PRs" });
    expect(calls).toEqual([
      [
        "agents.update",
        { id: "devin", runtime: "acp:devin", description: "Ships PRs" },
      ],
      /* #872: the relay record is the durable copy — an in-memory ACP
         persona re-seeds from it after a restart. */
      ["employees.update", { id: "emp_devin", description: "Ships PRs" }],
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

  test("a field the runtime hasn't declared errors loudly, never fakes Saved", async () => {
    setRuntimes([
      { id: "hermes", label: "Hermes" },
      {
        id: "acp:devin",
        label: "Devin",
        available: true,
        agentsUpdatable: ["model"],
      },
    ]);
    await expect(
      saveAgent("emp_devin", { description: "Ships PRs" }),
    ).rejects.toThrow(/doesn't let LilOS change the description/);
    // Nothing engine-side, and nothing record-side for description.
    expect(calls).toEqual([]);
  });

  test("a label the runtime's catalog doesn't know errors, not silently kept", async () => {
    const stop = runtimeRows().subscribe(() => {});
    await vi.waitFor(() =>
      expect(
        runtimeRows()
          .get()
          ?.find((r) => r.id === "acp:devin")?.models?.length,
      ).toBe(2),
    );
    await expect(saveAgent("emp_devin", { model: "Opus 5.5" })).rejects.toThrow(
      /isn't in Devin's model list/,
    );
    expect(calls).toEqual([]);
    stop();
  });

  test("an undescribed runtime row throws; a record-only field still lands", async () => {
    setRuntimes([
      { id: "hermes", label: "Hermes" },
      { id: "acp:devin", label: "Devin", available: true },
    ]);
    await expect(saveAgent("emp_devin", { description: "x" })).rejects.toThrow(
      /hasn't said what it can change yet/,
    );
    /* The name is the company's record — it never needed the engine. */
    await saveAgent("emp_devin", { name: "Renamed" });
    expect(calls).toEqual([
      ["employees.update", { id: "emp_devin", name: "Renamed" }],
    ]);
  });

  test("a failed runtime's row gives the engine's own reason", async () => {
    setRuntimes([
      { id: "hermes", label: "Hermes" },
      {
        id: "acp:devin",
        label: "Devin",
        available: true,
        state: "failed",
        detail: "devin acp exited (code 1)",
      },
    ]);
    await expect(saveAgent("emp_devin", { description: "x" })).rejects.toThrow(
      /isn't running — devin acp exited \(code 1\)/,
    );
    expect(calls).toEqual([]);
  });
});

/* #872 review: a literal runtime id "default" is the default engine
   (D-#761 normalizeRuntime) — its edits go to the default engine's
   updatable list, not a runtime row that does not exist. */
describe('saveAgent on a record stamped with the literal runtime "default"', () => {
  test("writes through the default engine", async () => {
    employee = { ...devinEmployee(), runtime: "default", profile: "ada" };
    capabilities = [
      { id: "agents", name: "Agents", detail: { updatable: ["description"] } },
    ];
    setRuntimes([{ id: "hermes", label: "Hermes" }]);
    await saveAgent("emp_devin", { description: "Ships PRs" });
    expect(calls).toEqual([
      ["agents.update", { id: "ada", description: "Ships PRs" }],
      ["employees.update", { id: "emp_devin", description: "Ships PRs" }],
    ]);
  });
});

/* D-#866: the boot catalog ask starts a runtime's engine — only one that
   is already running may be asked, and a cold start's overlapping status
   ticks share one `models.list`. */
describe("the boot catalog ask", () => {
  const asked = (runtime: string) =>
    (relay.listModels as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([p]) => (p as { runtime?: string } | undefined)?.runtime === runtime,
    ).length;

  test("never asks a hired runtime that is not running", async () => {
    employee = { ...devinEmployee(), runtime: "acp:idle" };
    setRuntimes([
      { id: "hermes", label: "Hermes" },
      { id: "acp:idle", label: "Idle", available: true, state: "idle" },
    ]);
    const stop = runtimeRows().subscribe(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(asked("acp:idle")).toBe(0);
    // Once it is running (real demand started it), it is asked.
    setRuntimes([
      { id: "hermes", label: "Hermes" },
      { id: "acp:idle", label: "Idle", available: true, state: "running" },
    ]);
    await vi.waitFor(() => expect(asked("acp:idle")).toBe(1));
    stop();
  });

  test("overlapping ticks during a cold start share one models.list", async () => {
    employee = { ...devinEmployee(), runtime: "acp:cold" };
    let release: () => void = () => {};
    (relay.listModels as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise<ModelsListResult>((resolve) => {
          release = () => resolve({ models: DEVIN_MODELS });
        }),
    );
    const row = { id: "acp:cold", label: "Cold", available: true };
    setRuntimes([
      { id: "hermes", label: "Hermes" },
      { ...row, state: "running" },
    ]);
    const stop = runtimeRows().subscribe(() => {});
    // Two more status ticks land while the first ask is still in flight.
    setRuntimes([
      { id: "hermes", label: "Hermes" },
      { ...row, state: "running" },
    ]);
    setRuntimes([
      { id: "hermes", label: "Hermes" },
      { ...row, state: "running" },
    ]);
    expect(asked("acp:cold")).toBe(1);
    release();
    await vi.waitFor(() =>
      expect(
        runtimeRows()
          .get()
          ?.find((r) => r.id === "acp:cold")?.models,
      ).toEqual(["SWE-2 High", "SWE-2 Max"]),
    );
    stop();
  });
});

/* #872: the describe store keyed `::id` for writes while page reads looked
   under `hermes::id` — a saved description appeared to revert. One canonical
   key: the default runtime always folds to `::`. */
describe("profileKey", () => {
  test("the default runtime always keys ::id — stamped or absent alike", () => {
    expect(profileKey(undefined, "p1")).toBe("::p1");
    expect(profileKey("hermes", "p1")).toBe("::p1");
    expect(profileKey("default", "p1")).toBe("::p1");
    expect(profileKey("acp:devin", "p1")).toBe("acp:devin::p1");
    /* Two runtimes' same-named profiles never collide. */
    expect(profileKey("acp:devin", "x")).not.toBe(
      profileKey("acp:claude", "x"),
    );
  });
});
