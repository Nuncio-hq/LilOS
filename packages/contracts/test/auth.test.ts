import { describe, expect, it } from "vitest";
import { equalSecret } from "../src/auth";

/**
 * Issue #611 — the one shared constant-time secret compare, lifted out of
 * `apps/relay/src/auth.ts` (where #568 introduced it) so every loopback auth
 * gate — relay, harness, surfaces gateway — uses the same implementation.
 */
describe("equalSecret", () => {
  it("answers equal/unequal regardless of input length", () => {
    expect(equalSecret("a", "a")).toBe(true);
    expect(equalSecret("", "")).toBe(true);
    expect(equalSecret("a", "b")).toBe(false);
    expect(equalSecret("abc", "abcd")).toBe(false);
    expect(equalSecret("abcd", "abc")).toBe(false);
    expect(equalSecret("short", "a-much-longer-secret-value")).toBe(false);
  });

  it("refuses a near-miss — same length, one character different", () => {
    const secret = "install-token-0123456789abcdef";
    expect(equalSecret(secret, `${secret.slice(0, -1)}X`)).toBe(false);
    expect(equalSecret(secret, `X${secret.slice(1)}`)).toBe(false);
    expect(equalSecret(secret, secret)).toBe(true);
  });
});
