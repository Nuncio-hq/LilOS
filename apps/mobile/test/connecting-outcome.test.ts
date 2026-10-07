/* Issue #593: the Connecting screen's outcome mapping — each exchange
   refusal gets its own words (wrong code ≠ unreachable ≠ throttled), and
   the throttled wait rides the error's retryAfterMs. */
import { PairingExchangeFailed } from "@lilos/client-runtime";
import { describe, expect, it } from "vitest";
import { connectingOutcome } from "../src/mapping";

describe("connectingOutcome (#593)", () => {
  it("'unknown' reads 'mismatch' — a wrong code is not 'can't reach'", () => {
    expect(connectingOutcome(new PairingExchangeFailed("unknown"))).toEqual({
      state: "mismatch",
    });
  });

  it("'expired' and 'used' read 'expired' — same dead-code screen", () => {
    expect(connectingOutcome(new PairingExchangeFailed("expired")).state).toBe(
      "expired",
    );
    expect(connectingOutcome(new PairingExchangeFailed("used")).state).toBe(
      "expired",
    );
  });

  it("'throttled' reads 'throttled' with the wait in seconds", () => {
    expect(
      connectingOutcome(new PairingExchangeFailed("throttled", 42_000)),
    ).toEqual({ state: "throttled", retryAfterSeconds: 42 });
  });

  it("throttled without a Retry-After falls back to the 60s cooldown", () => {
    expect(connectingOutcome(new PairingExchangeFailed("throttled"))).toEqual({
      state: "throttled",
      retryAfterSeconds: 60,
    });
  });

  it("network/shape failures read 'unreachable'", () => {
    expect(connectingOutcome(new Error("network request failed")).state).toBe(
      "unreachable",
    );
    expect(
      connectingOutcome(new DOMException("Aborted", "TimeoutError")).state,
    ).toBe("unreachable");
  });
});
