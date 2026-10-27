/* The real app's agent edit and remove (apps/web/src/v3/employees.ts): the
   same relay calls the pre-v3 Edit dialog made. The engine profile write
   lands first, the company record mirrors it after it sticks, a guarded model
   waits for a confirm, and removing never touches the engine profile. The
   relay is a recording fake; the catalog the page's model labels resolve
   against is the real store. */
import type { Employee } from "@lilos/contracts/app";
import type { DescribeResult, ModelOption } from "@lilos/contracts/engine";
import { beforeEach, describe, expect, test, vi } from "vitest";

const calls: [string, unknown][] = [];
let employee: Employee;
let updateAgentReply: { agent: { id: string }; confirmModel?: string };
let capabilities: DescribeResult["capabilities"];

vi.mock("../src/lib/runtime", async (orig) => {
  const actual = await orig<typeof import("../src/lib/runtime")>();
  const relay = {
    employees: { get: () => [employee], listen: () => () => {} },
    // profiles.ts re-signs its per-runtime asks off the roster.
    status: { get: () => ({}), listen: () => () => {} },
    // Reading the profile behind the employee (profiles.ts), as the engine says it.
    describeAgent: vi.fn(async (id: string) => ({ id, name: id })),
    updateAgent: vi.fn(async (p: unknown) => {
      calls.push(["agents.update", p]);
      return updateAgentReply;
    }),
    updateEmployee: vi.fn(async (id: string, p: unknown) => {
      calls.push(["employees.update", { id, ...(p as object) }]);
    }),
    removeEmployee: vi.fn(async (id: string) => {
      calls.push(["employees.remove", { id }]);
    }),
    request: vi.fn(async (m: string, p: unknown) => {
      calls.push([m, p]);
      return { tasks: [] };
    }),
  };
  const engine = {
    description: { get: () => ({ capabilities }), listen: () => () => {} },
  };
  return { ...actual, relay, engine };
});

import { engineModels } from "../src/lib/runtime";
import { removeAgent, saveAgent } from "../src/v3/employees";
import { updatableOf } from "../src/v3/profiles";

const agents = (updatable: string[]): DescribeResult["capabilities"] => [
  { id: "agents", name: "Agents", detail: { updatable } },
];

beforeEach(() => {
  calls.length = 0;
  employee = {
    id: "emp_1",
    name: "Reviewer",
    role: "QA",
    status: "online",
    profile: "reviewer",
    model: "sonnet",
    now: "",
    instructions: "old",
    respondTo: "me",
    createdAt: 0,
  };
  updateAgentReply = { agent: { id: "reviewer" } };
  capabilities = agents(["description", "soul", "model"]);
  engineModels.set([
    { id: "haiku", name: "Haiku 5", provider: "anthropic" },
  ] as ModelOption[]);
});

describe("saveAgent", () => {
  test("engine profile first, then the record mirrors it", async () => {
    const r = await saveAgent("emp_1", {
      name: "Maker",
      role: "Builds",
      description: "Ships",
      instructions: "new",
      model: "Haiku 5",
    });
    expect(r).toBeUndefined();
    expect(calls).toEqual([
      [
        "agents.update",
        {
          id: "reviewer",
          soul: "new",
          description: "Ships",
          model: "haiku",
          provider: "anthropic",
        },
      ],
      [
        "employees.update",
        {
          id: "emp_1",
          name: "Maker",
          role: "Builds",
          instructions: "new",
          model: "haiku",
        },
      ],
    ]);
  });

  test("the display name reaches the profile only where the engine lists name", async () => {
    capabilities = agents(["name", "soul"]);
    await saveAgent("emp_1", { name: "Maker" });
    expect(calls[0]).toEqual([
      "agents.update",
      { id: "reviewer", name: "Maker" },
    ]);
    calls.length = 0;
    capabilities = agents(["soul"]);
    await saveAgent("emp_1", { name: "Maker" });
    // Hermes cannot rename a profile: the record alone changes.
    expect(calls).toEqual([
      ["employees.update", { id: "emp_1", name: "Maker" }],
    ]);
  });

  test("an engine that lists nothing writable still saves the record", async () => {
    capabilities = agents([]);
    await saveAgent("emp_1", {
      role: "Builds",
      instructions: "new",
      model: "Haiku 5",
    });
    expect(calls).toEqual([
      ["employees.update", { id: "emp_1", role: "Builds" }],
    ]);
  });

  test("a held model is not mirrored; confirming sends it alone and mirrors it", async () => {
    updateAgentReply = {
      agent: { id: "reviewer" },
      confirmModel: "Costs more",
    };
    const held = await saveAgent("emp_1", {
      role: "Builds",
      instructions: "new",
      model: "Haiku 5",
    });
    expect(held).toEqual({ confirmModel: "Costs more" });
    expect(calls[1]).toEqual([
      "employees.update",
      { id: "emp_1", role: "Builds", instructions: "new" },
    ]);

    calls.length = 0;
    updateAgentReply = { agent: { id: "reviewer" } };
    expect(
      await saveAgent("emp_1", { model: "Haiku 5", confirmModel: true }),
    ).toBeUndefined();
    expect(calls).toEqual([
      [
        "agents.update",
        {
          id: "reviewer",
          model: "haiku",
          provider: "anthropic",
          confirmModel: true,
        },
      ],
      ["employees.update", { id: "emp_1", model: "haiku" }],
    ]);
  });

  test("muting is a record write only", async () => {
    await saveAgent("emp_1", { muted: true });
    expect(calls).toEqual([["employees.update", { id: "emp_1", muted: true }]]);
  });

  test("an agent that left the team cannot be saved", async () => {
    await expect(saveAgent("gone", { name: "X" })).rejects.toThrow(/no longer/);
    expect(calls).toEqual([]);
  });
});

describe("removeAgent", () => {
  test("removes the record and reads the schedules the relay dropped with it, never the profile", async () => {
    await removeAgent("emp_1");
    expect(calls).toEqual([
      ["employees.remove", { id: "emp_1" }],
      ["schedules.list", {}],
    ]);
    expect(calls.some(([m]) => m.startsWith("agents."))).toBe(false);
  });
});

describe("updatableOf", () => {
  test("reads the agents capability's writable fields, ignoring junk", () => {
    expect(
      updatableOf({
        capabilities: [
          {
            id: "agents",
            name: "A",
            detail: { updatable: ["soul", 3, "model"] },
          },
        ],
      } as unknown as DescribeResult),
    ).toEqual(["soul", "model"]);
    expect(updatableOf(undefined)).toEqual([]);
    expect(
      updatableOf({
        capabilities: [{ id: "models", name: "M" }],
      } as unknown as DescribeResult),
    ).toEqual([]);
  });
});
