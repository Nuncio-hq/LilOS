/* Issue #586: two sessions never show the same label. Engine refs go through
   `sessionLabel` — Hermes ids are date-first (`20261006_221236_cfe2c4`), so a
   head-slice collides for every session started on the same day; the label is
   the id's short tail instead. */
import { describe, expect, test } from "vitest";
import { sessionLabel } from "../src/lib/mapping";

describe("issue #586 session labels", () => {
  test("AC-2 Hermes-style ids never share a label (date-first ids collide on slice(0,8))", () => {
    const a = "20261006_221236_cfe2c4";
    const b = "20261006_221236_a1b2c3";
    expect(a.slice(0, 8)).toBe(b.slice(0, 8)); // the old collision
    const la = sessionLabel(a);
    const lb = sessionLabel(b);
    expect(la).not.toBe(lb);
    expect(la).toBe("cfe2c4");
    expect(lb).toBe("a1b2c3");
  });

  test("AC-2 the label is a short alphanumeric tail of the engine ref", () => {
    expect(sessionLabel("s_ab12cd34ef")).toBe("cd34ef");
    expect(sessionLabel("session-9f8e7d")).toBe("9f8e7d");
    // Trailing punctuation can't leave an empty label.
    expect(sessionLabel("abc123_")).toBe("abc123");
    expect(sessionLabel("")).toBe("");
  });
});
