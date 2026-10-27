/* Issue #884 round 1: the harness pins the engine's global approval policy
   to `manual` — the mode that makes LilOS's Ask surface a card — on attach
   and on every describe probe, so a stale `off`/`smart` value or later
   drift never leaves the owner under an "Ask" pill that never asks. */

import type { DescribeResult } from "@lilos/contracts/engine";
import { describe, expect, it } from "vitest";
import type { EngineConnection } from "../src/engine/client";
import { enforceApprovalPolicy } from "../src/harness/policy";

function conn(calls: string[]): EngineConnection {
  return {
    request: async <T = unknown>(method: string, params?: unknown) => {
      calls.push(`${method} ${JSON.stringify(params)}`);
      return {} as T;
    },
    onEvent: () => () => {},
    close: () => {},
  };
}

function desc(
  current: string,
  options = ["smart", "manual", "off"],
): DescribeResult {
  return {
    capabilities: [
      {
        id: "approval_policy",
        label: "Approval policy",
        detail: { current, options },
      },
    ],
  } as unknown as DescribeResult;
}

describe("issue #884 — enforceApprovalPolicy", () => {
  it("an engine reporting off is reset to manual", async () => {
    const calls: string[] = [];
    const d = desc("off");
    await enforceApprovalPolicy(conn(calls), d);
    expect(calls).toEqual(['approvals.setPolicy {"policy":"manual"}']);
    /* the passed describe is patched so the cache reports the new truth */
    expect(d.capabilities[0].detail?.current).toBe("manual");
  });

  it("an engine reporting smart is reset too — smart can answer asks itself", async () => {
    const calls: string[] = [];
    await enforceApprovalPolicy(conn(calls), desc("smart"));
    expect(calls).toEqual(['approvals.setPolicy {"policy":"manual"}']);
  });

  it("manual is left alone — no write, no drift", async () => {
    const calls: string[] = [];
    await enforceApprovalPolicy(conn(calls), desc("manual"));
    expect(calls).toEqual([]);
  });

  it("an engine without the capability is left alone", async () => {
    const calls: string[] = [];
    await enforceApprovalPolicy(conn(calls), {
      capabilities: [],
    } as unknown as DescribeResult);
    expect(calls).toEqual([]);
  });

  it("a capability that cannot spell manual is not written", async () => {
    const calls: string[] = [];
    await enforceApprovalPolicy(conn(calls), desc("off", ["off", "auto"]));
    expect(calls).toEqual([]);
  });

  it("a refused write is logged, not thrown — the next probe retries", async () => {
    const failing: EngineConnection = {
      request: async () => {
        throw new Error("denied");
      },
      onEvent: () => () => {},
      close: () => {},
    };
    const d = desc("off");
    await expect(enforceApprovalPolicy(failing, d)).resolves.toBeUndefined();
    expect(d.capabilities[0].detail?.current).toBe("off");
  });
});
