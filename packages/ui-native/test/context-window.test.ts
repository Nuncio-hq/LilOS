import { describe, expect, it } from "vitest";
import {
  contextUsedOf,
  contextWindowOf,
  FALLBACK_CONTEXT_WINDOW,
} from "../src/employees/model-rules";

/* #294: the phone divides by the same window the web does — the engine's
   report on the session's usage first, then the session model's catalog row,
   then the labelled estimate. Twin of packages/ui/test/context-window.test.tsx's
   helper cases; the meter renders `~` off the `estimated` flag. */

describe("contextWindowOf — the window the meter divides by (#294)", () => {
  it("prefers the session's engine-reported window over the catalog row", () => {
    expect(
      contextWindowOf({ contextWindow: 128_000 }, "fake-large", [
        {
          id: "fake-large",
          name: "Fake Large",
          provider: "fake",
          contextWindow: 262_000,
        },
      ]),
    ).toEqual({ tokens: 128_000, estimated: false });
  });

  it("falls back to the session model's catalog row", () => {
    expect(
      contextWindowOf(undefined, "fake-large", [
        {
          id: "fake-large",
          name: "Fake Large",
          provider: "fake",
          contextWindow: 262_000,
        },
      ]),
    ).toEqual({ tokens: 262_000, estimated: false });
  });

  it("flags the estimate when nothing reports a window", () => {
    expect(contextWindowOf(undefined, "qwen3.8-flash-next")).toEqual({
      tokens: 262_000,
      estimated: true,
    });
    expect(contextWindowOf(undefined, "fake/opus-2")).toEqual({
      tokens: FALLBACK_CONTEXT_WINDOW,
      estimated: true,
    });
    expect(contextWindowOf(undefined, undefined)).toEqual({
      tokens: FALLBACK_CONTEXT_WINDOW,
      estimated: true,
    });
  });
});

/* #415 twin of packages/ui/test/context-window.test.tsx: the meter's
   numerator is the engine's CURRENT occupancy (`context`), not the lifetime
   input+output sums — Hermes' 123.2% repro is exactly that mix-up. */
describe("contextUsedOf — the meter's numerator (#415)", () => {
  it("prefers the reported occupancy over the lifetime sum", () => {
    expect(
      contextUsedOf({ input: 305_800, output: 17_400, context: 21_300 }),
    ).toBe(21_300);
  });
  it("falls back to the last turn's in+out when the engine reports none", () => {
    expect(contextUsedOf({ input: 305_800, output: 17_400 })).toBe(323_200);
    expect(contextUsedOf(undefined)).toBe(0);
  });
});
