/* Issue #884 round 1: the harness corrects an engine whose global approval
   policy was left on `off` — pinned back to `smart` (the ask-for-the-risky-
   ones mode behind LilOS's "Ask before risky commands") on attach and on
   every describe probe, so a stale `off` or later drift never leaves the
   owner under an "Ask" pill that never asks. `smart` and `manual` are left
   alone. */

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
  it("an engine reporting off is reset to smart — the mode behind 'Ask before risky commands'", async () => {
    const calls: string[] = [];
    const d = desc("off");
    await enforceApprovalPolicy(conn(calls), d);
    expect(calls).toEqual(['approvals.setPolicy {"policy":"smart"}']);
    /* the passed describe is patched so the cache reports the new truth */
    expect(d.capabilities[0].detail?.current).toBe("smart");
  });

  it("smart is left alone — it already asks for the risky ones", async () => {
    const calls: string[] = [];
    await enforceApprovalPolicy(conn(calls), desc("smart"));
    expect(calls).toEqual([]);
  });

  it("manual is left alone — gating every command is a deliberate choice", async () => {
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

  it("a capability that cannot spell smart is not written", async () => {
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
