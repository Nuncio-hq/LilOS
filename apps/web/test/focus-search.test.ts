/* #319 AC-2: the focus route's `?tab=` parsing — a real Workbench tab comes
   through, anything else drops so a stray param can't break the tab strip. */
import { describe, expect, test } from "vitest";
import { parseFocusTab } from "../src/lib/focus-search";

describe("parseFocusTab", () => {
  test.each([
    ["subagents", "subagents"],
    ["changes", "changes"],
    ["terminal", "terminal"],
    ["pr", "pr"],
  ] as const)("keeps %s", (given, want) => {
    expect(parseFocusTab({ tab: given })).toBe(want);
  });

  test.each([
    ["bogus"],
    ["subagents;drop"],
    ["Subagents"],
    [""],
    ["subagents&x=1"],
  ] as const)("drops %s", (given) => {
    expect(parseFocusTab({ tab: given })).toBeUndefined();
  });

  test("drops a missing or non-string tab", () => {
    expect(parseFocusTab({})).toBeUndefined();
    expect(parseFocusTab({ tab: 42 })).toBeUndefined();
    expect(parseFocusTab({ tab: ["subagents"] })).toBeUndefined();
    expect(parseFocusTab({ tab: undefined })).toBeUndefined();
  });
});
