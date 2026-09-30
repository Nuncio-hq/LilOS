import { describe, expect, it } from "vitest";
import { highlight } from "../src/components/code-highlight";

/* #259 AC-2: ts/tsx/js, python, bash/sh, json, diff highlight; unknown or
   missing languages are plain code, never an error. */

const spansOf = (code: string, lang: string | null) =>
  highlight(code, lang)
    .map((t) => t.text)
    .join("");

describe("highlight", () => {
  it("returns the full code text unchanged across spans", () => {
    for (const lang of ["ts", "python", "bash", "json", "diff", null]) {
      const code = 'const s = "a\\nstring"; // c\nline2';
      expect(spansOf(code, lang)).toBe(code);
    }
  });

  it("typescript: keywords, strings and comments get classes", () => {
    const spans = highlight('const x = "hi"; // note', "ts");
    const byClass = (cls: string) =>
      spans.filter((s) => s.classes.some((c) => c.includes(cls)));
    expect(
      byClass("keyword")
        .map((s) => s.text)
        .join(""),
    ).toContain("const");
    expect(
      byClass("string")
        .map((s) => s.text)
        .join(""),
    ).toContain('"hi"');
    expect(
      byClass("comment")
        .map((s) => s.text)
        .join(""),
    ).toContain("// note");
  });

  it("aliases: tsx/py/sh all resolve to a registered grammar", () => {
    expect(highlight("x = 1", "py").some((s) => s.classes.length > 0)).toBe(
      true,
    );
    expect(highlight("echo hi", "sh").some((s) => s.classes.length > 0)).toBe(
      true,
    );
    expect(
      highlight("let x: number", "tsx").some((s) => s.classes.length > 0),
    ).toBe(true);
  });

  it("diff: added and removed lines carry addition/deletion classes", () => {
    const spans = highlight("+added\n-removed\n ctx", "diff");
    expect(
      spans.some((s) => s.classes.some((c) => c.includes("addition"))),
    ).toBe(true);
    expect(
      spans.some((s) => s.classes.some((c) => c.includes("deletion"))),
    ).toBe(true);
  });

  it("unknown and missing languages produce one plain unstyled span", () => {
    for (const lang of ["brainfuck", "totally-fake", null]) {
      const spans = highlight("some code", lang);
      expect(spans.length).toBe(1);
      expect(spans[0].classes).toEqual([]);
    }
  });

  it("an empty block still yields a span (layout stays stable)", () => {
    expect(highlight("", "ts").length).toBe(1);
  });
});
