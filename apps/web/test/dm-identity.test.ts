/* Issue #80, app wiring: the DM's `human` lookup resolves the relay's user
   author id to the same `Human` the sidebar footer renders — one identity,
   never the anonymous grey "You" fallback that caused the mismatch. */
import { describe, expect, test } from "vitest";
import { humanFor, ME, USER_ID } from "../src/lib/me";

describe("issue #80", () => {
  test("AC-1 the user author resolves to the signed-in human", () => {
    expect(humanFor(USER_ID)).toBe(ME);
    expect(ME).toMatchObject({ name: expect.any(String) });
    expect(ME.color).toMatch(/^bg-/);
    // Anything else (no other author kind reaches the app today) stays undefined.
    expect(humanFor("stranger")).toBeUndefined();
  });
});
