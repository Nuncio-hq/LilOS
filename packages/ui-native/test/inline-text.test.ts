/* Issue #448, iOS: the subagent now-line shares the same flatten as web —
   `inline` here is the native sibling of @lilos/ui's `inline` (helpers.ts).
   The char regex it replaces ate the "_" inside `write_file` / `ses_c03e`
   while leaving real `_emph_` markers on. */
import { describe, expect, test } from "vitest";
import { inline } from "../src/components/prose-blocks";

describe("issue #448 — inline() flattens markdown to one line", () => {
  test("AC-1 snake_case identifiers keep underscores, in and out of code spans", () => {
    expect(inline("Ran `write_file` on LILOS_ENGINE, then read foo_bar.")).toBe(
      "Ran write_file on LILOS_ENGINE, then read foo_bar.",
    );
  });

  test("AC-1 a session id like `ses_c03e` keeps its underscore", () => {
    expect(inline("`seq` is monotonic (checked in `ses_c03e`).")).toBe(
      "seq is monotonic (checked in ses_c03e).",
    );
  });

  test("AC-2 real emphasis unwraps: _emph_, *em*, **bold** and `code`", () => {
    expect(inline("ran _this_ *and* **that** `code_x` first")).toBe(
      "ran this and that code_x first",
    );
  });

  test("AC-2 heading and quote markers flatten away; blocks join with a space", () => {
    expect(inline("## Result\n> checked `foo_bar`")).toBe(
      "Result checked foo_bar",
    );
  });
});
