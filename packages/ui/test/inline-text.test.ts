/* Issue #448: the subagent now-line and the Start-work title seed share
   `inline`/`titleSeed` — the single-line siblings of preview() (#417).
   The char regexes they replace ate the "_" inside `write_file` /
   `ses_c03e` / `LILOS_ENGINE` while leaving real `_emph_` markers on. */
import { describe, expect, test } from "vitest";
import { inline, titleSeed } from "../src/lib/helpers";

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

describe("issue #448 — titleSeed() for the Start-work dialog", () => {
  test("AC-3 mentions come out and emphasis unwraps to one flat line", () => {
    expect(titleSeed("**@Builder** fix _the_ `foo_bar` retry path")).toBe(
      "fix the foo_bar retry path",
    );
  });

  test("AC-3 a multi-line message seeds a single line", () => {
    const seed = titleSeed("First line\n\n- second **point**\n- third `x_y`");
    expect(seed).toBe("First line second point third x_y");
    expect(seed).not.toContain("\n");
  });

  test("AC-3 the seed caps at 60 chars", () => {
    expect(titleSeed(`Refactor ${"x".repeat(80)} end`)).toBe(
      `Refactor ${"x".repeat(51)}`,
    );
  });
});
