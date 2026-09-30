import { describe, expect, it } from "vitest";
import {
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
