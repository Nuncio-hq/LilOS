import { describe, expect, it } from "vitest";
import { grantRows } from "../src/employees/grant-rows";

/* #687 AC-1: the ask card's pills lay out as assigned rows — Deny trails
   the last grant row on its baseline, never vertically centred between
   two wrapped rows. */

describe("grantRows — the ask card's pill rows", () => {
  it("3 grants + deny → 2×2 grid, Deny trailing Always", () => {
    expect(grantRows(["once", "session", "always", "deny"])).toEqual([
      ["once", "session"],
      ["always", "deny"],
    ]);
  });

  it("2 grants + deny → grants row, Deny on its own trailing row", () => {
    expect(grantRows(["once", "always", "deny"])).toEqual([
      ["once", "always"],
      ["deny"],
    ]);
  });

  it("once + deny → a single row", () => {
    expect(grantRows(["once", "deny"])).toEqual([["once", "deny"]]);
  });

  it("grants without deny → pairs, nothing pinned", () => {
    expect(grantRows(["once", "session", "always"])).toEqual([
      ["once", "session"],
      ["always"],
    ]);
  });

  it("deny alone → one row", () => {
    expect(grantRows(["deny"])).toEqual([["deny"]]);
  });
});
