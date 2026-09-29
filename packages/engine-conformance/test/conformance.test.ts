import { connectFake, FakeEngine } from "@lilos/engine-fake";
import { describe, expect, test } from "vitest";
import { Harness } from "../src/harness.js";
import { CORE_SCENARIOS, SUITES } from "../src/scenarios.js";

const make = () => {
  const engine = new FakeEngine({ tick: 2 });
  return new Harness(connectFake(engine));
};

describe("core suite vs engine-fake (in-memory transport)", () => {
  for (const s of CORE_SCENARIOS) {
    test(`AC-1 ${s.id}`, async () => {
      const h = make();
      try {
        await s.run(h);
      } finally {
        h.close();
      }
    });
  }
});

describe("capability suites vs engine-fake", () => {
  for (const suite of SUITES.filter(
    (x) => x.implemented && x.capability !== "core",
  )) {
    describe(suite.capability, () => {
      for (const s of suite.scenarios) {
        test(s.id, async () => {
          const h = make();
          try {
            await s.run(h);
          } finally {
            h.close();
          }
        });
      }
    });
  }
});

test("AC-1 suite registry: core implemented, per-capability suites registered", () => {
  expect(SUITES.find((s) => s.capability === "core")?.implemented).toBe(true);
  for (const cap of ["steer", "image_prompt", "models", "agents"])
    expect(
      SUITES.find((s) => s.capability === cap)?.implemented,
      `${cap} suite is implemented`,
    ).toBe(true);
  const pending = SUITES.filter((s) => !s.implemented).map((s) => s.capability);
  expect(pending).not.toContain("image_prompt");
  expect(pending).not.toContain("mcp_servers"); // #133 approval grant scenario
  expect(pending).not.toContain("plan"); // #180 plans/tasks suite
  expect(pending).not.toContain("rewind"); // #134 rewind scenarios
  expect(pending.length).toBeGreaterThanOrEqual(1); // usage stays registered but empty
});
