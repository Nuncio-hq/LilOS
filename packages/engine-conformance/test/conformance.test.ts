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
  const steer = SUITES.find((x) => x.capability === "steer");
  if (!steer) throw new Error("steer suite must be registered");
  for (const s of steer.scenarios) {
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

test("AC-1 suite registry: core implemented, per-capability suites registered", () => {
  expect(SUITES.find((s) => s.capability === "core")?.implemented).toBe(true);
  const pending = SUITES.filter((s) => !s.implemented).map((s) => s.capability);
  expect(pending).toContain("image_prompt");
  expect(pending.length).toBeGreaterThan(3); // the other capabilities are registered but empty
});
