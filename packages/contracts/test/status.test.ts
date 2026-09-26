import { describe, expect, it } from "vitest";
import {
  HarnessRegisterParams,
  HarnessReportParams,
  StatusComponent,
  StatusMismatch,
  SystemStatusParams,
  SystemStatusResult,
} from "../src/app";

/**
 * Issue #33 wire shapes: one `system.status` aggregate call, a version
 * handshake on `harness.register`, and telemetry on `harness.report`.
 */

const component = (id: string, state: string) => ({
  id,
  label: id[0].toUpperCase() + id.slice(1),
  state,
  reason: `${id} is ${state}`,
});

const fullResult = {
  protocolVersion: 1,
  generatedAt: 1_759_000_000_000,
  components: [
    component("relay", "ok"),
    component("harness", "ok"),
    component("engine", "ok"),
    component("model", "ok"),
  ],
  versions: {
    relay: "0.1.0",
    harness: "0.1.0",
    relayProtocol: 1,
    harnessProtocol: 1,
  },
  engine: {
    name: "engine-fake",
    version: "0.0.0",
    rssBytes: 84_000_000,
    sessions: 2,
  },
  logs: { relay: ["line a"], harness: ["line b"] },
};

describe("AC-1 (#33) system.status result carries one row per leg", () => {
  it("parses the four status components with state + reason", () => {
    const parsed = SystemStatusResult.parse(fullResult);
    expect(parsed.components.map((c) => c.id)).toEqual([
      "relay",
      "harness",
      "engine",
      "model",
    ]);
    for (const c of parsed.components) {
      expect(["ok", "connecting", "degraded", "down"]).toContain(c.state);
      expect(c.reason.length).toBeGreaterThan(0);
    }
  });

  it("rejects a component id outside the chain and a bogus state", () => {
    expect(
      StatusComponent.safeParse({ ...component("db", "ok") }).success,
    ).toBe(false);
    expect(
      StatusComponent.safeParse({ ...component("relay", "vibing") }).success,
    ).toBe(false);
  });
});

describe("AC-2 (#33) version handshake on harness.register", () => {
  it("requires protocolVersion and accepts a build version", () => {
    expect(HarnessRegisterParams.safeParse({}).success).toBe(false);
    expect(
      HarnessRegisterParams.parse({ protocolVersion: 1, version: "0.2.0" }),
    ).toEqual({ protocolVersion: 1, version: "0.2.0" });
    expect(
      HarnessRegisterParams.parse({ protocolVersion: 1 }).version.length,
    ).toBeGreaterThan(0);
  });

  it("status mismatch names which component to update", () => {
    for (const update of ["app", "relay", "harness"] as const) {
      expect(
        StatusMismatch.parse({ update, detail: "v1 speaks protocol 2" }).update,
      ).toBe(update);
    }
    expect(
      StatusMismatch.safeParse({ update: "engine", detail: "x" }).success,
    ).toBe(false);
  });
});

describe("AC-3 (#33) diagnostics params + log lines", () => {
  it("logLines defaults off and caps the bundle", () => {
    expect(SystemStatusParams.parse({}).logLines).toBe(0);
    expect(SystemStatusParams.parse({ logLines: 25 }).logLines).toBe(25);
    expect(SystemStatusParams.safeParse({ logLines: -1 }).success).toBe(false);
    expect(SystemStatusParams.safeParse({ logLines: 10_000 }).success).toBe(
      false,
    );
  });

  it("result carries per-component log tails when requested", () => {
    const parsed = SystemStatusResult.parse(fullResult);
    expect(parsed.logs?.relay).toEqual(["line a"]);
    expect(parsed.logs?.harness).toEqual(["line b"]);
    // Logs are optional: a plain status call without them still parses.
    const { logs, ...noLogs } = fullResult;
    expect(SystemStatusResult.safeParse(noLogs).success).toBe(true);
  });
});

describe("AC-4 (#33) harness.report telemetry carries engine RSS + sessions", () => {
  it("accepts a heartbeat-only report (backward compatible)", () => {
    expect(HarnessReportParams.parse({ engine: { state: "running" } })).toEqual(
      { engine: { state: "running" } },
    );
  });

  it("parses the extended status telemetry", () => {
    const parsed = HarnessReportParams.parse({
      engine: { state: "running", detail: "engine-fake" },
      status: {
        harnessVersion: "0.1.0",
        engineName: "engine-fake",
        engineVersion: "0.0.0",
        engineProtocol: 1,
        model: "fake-model-1",
        engineRssBytes: 84_000_000,
        sessions: 3,
        probedAt: 1_759_000_000_000,
        logTail: ["a", "b"],
      },
    });
    expect(parsed.status?.engineRssBytes).toBe(84_000_000);
    expect(parsed.status?.sessions).toBe(3);
    expect(parsed.status?.model).toBe("fake-model-1");
  });

  it("rejects negative counters", () => {
    expect(
      HarnessReportParams.safeParse({
        engine: { state: "running" },
        status: { sessions: -1 },
      }).success,
    ).toBe(false);
  });
});
