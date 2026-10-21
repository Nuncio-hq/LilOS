import { describe, expect, it } from "vitest";
import {
  assertReportsAcyclic,
  CeoGraphError,
  reportsToAfterCeo,
  withReportsTo,
} from "../src/app/ceo.js";

const row = (id: string, reportsTo?: string) =>
  reportsTo ? { id, reportsTo } : { id };

describe("reportsTo after a new CEO (D-#778)", () => {
  it("puts the first holder under the owner and everyone else under them", () => {
    const people = [row("a"), row("b"), row("c")];
    const patches = reportsToAfterCeo(people, undefined, "b");
    expect(patches).toEqual([
      { id: "a", reportsTo: "b" },
      { id: "c", reportsTo: "b" },
    ]);
    const next = withReportsTo(people, patches);
    expect(next.find((e) => e.id === "b")?.reportsTo).toBeUndefined();
    expect(next.find((e) => e.id === "a")?.reportsTo).toBe("b");
    assertReportsAcyclic(next);
  });

  it("moves the old CEO and their reports, and leaves a deeper link", () => {
    const people = [
      row("old"),
      row("neo", "old"),
      row("mid", "old"),
      row("leaf", "mid"),
    ];
    const patches = reportsToAfterCeo(people, "old", "neo");
    const next = withReportsTo(people, patches);
    expect(next.find((e) => e.id === "neo")?.reportsTo).toBeUndefined();
    expect(next.find((e) => e.id === "old")?.reportsTo).toBe("neo");
    expect(next.find((e) => e.id === "mid")?.reportsTo).toBe("neo");
    expect(next.find((e) => e.id === "leaf")?.reportsTo).toBe("mid");
    assertReportsAcyclic(next);
  });

  it("rejects a cycle", () => {
    expect(() => assertReportsAcyclic([row("a", "b"), row("b", "a")])).toThrow(
      CeoGraphError,
    );
  });
});
