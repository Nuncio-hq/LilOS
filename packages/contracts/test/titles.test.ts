import { describe, expect, it } from "vitest";
import { AUTO_TITLE_MAX, autoTitle } from "../src/engine/titles";

/**
 * Issue #886: auto-titles use the first full sentence (≤ ~60 chars), not a
 * word or a first clause — a stub opener ("Hi!") is not a title, so it
 * extends into what follows while the whole still fits the cap.
 */

describe("autoTitle", () => {
  it("takes the first full sentence, ignoring what follows", () => {
    expect(
      autoTitle("Fix the relay reconnect bug. Also update the tests."),
    ).toBe("Fix the relay reconnect bug.");
  });

  it("extends a stub opener into the next sentence while it fits", () => {
    expect(autoTitle("Hi! What can you do for me today?")).toBe(
      "Hi! What can you do for me today?",
    );
    expect(
      autoTitle("Hi! What can you do for me today? And a third line."),
    ).toBe("Hi! What can you do for me today?");
  });

  it("keeps a sentence up to the cap without ellipsis", () => {
    const s = "Explain exactly how the relay reconnect backoff works today."; // 60
    expect(autoTitle(`${s} And more.`)).toBe(s);
  });

  it("fills the cap from the prompt when the cut would be a stub", () => {
    const t = autoTitle(
      "Hi. This is a very long second sentence that goes on and on beyond it",
    );
    expect(t.length).toBeLessThanOrEqual(AUTO_TITLE_MAX);
    expect(t.startsWith("Hi. This is a very long second sentence")).toBe(true);
    expect(t.endsWith("…")).toBe(true);
  });

  it("clips an over-long first sentence at a word boundary", () => {
    const t = autoTitle(
      "Refactor the entire gateway request pipeline to stream partial results end to end.",
    );
    expect(t.length).toBeLessThanOrEqual(AUTO_TITLE_MAX);
    expect(t.endsWith("…")).toBe(true);
    expect(t).not.toContain("  ");
  });

  it("mid-word dots are not sentence ends", () => {
    expect(autoTitle("file.ts breaks the build")).toBe(
      "file.ts breaks the build",
    );
    expect(autoTitle("Bump v1.2 of the contract")).toBe(
      "Bump v1.2 of the contract",
    );
  });

  it("collapses runs of spaces", () => {
    expect(autoTitle("  Fix   the relay   reconnect bug. ")).toBe(
      "Fix the relay reconnect bug.",
    );
  });

  it("a newline ends the title", () => {
    expect(
      autoTitle("Fix the relay reconnect bug\nThen update the tests"),
    ).toBe("Fix the relay reconnect bug");
    expect(autoTitle("\n\n  Fix the relay reconnect bug\r\nand more")).toBe(
      "Fix the relay reconnect bug",
    );
  });

  it("a short first sentence still ends the title when it is a real one", () => {
    expect(
      autoTitle("Fix login bug. Also update the docs and the tests."),
    ).toBe("Fix login bug.");
  });

  it("e.g. / i.e. / Dr. do not end a sentence", () => {
    expect(
      autoTitle("Use a small model, e.g. haiku for titles. Then more."),
    ).toBe("Use a small model, e.g. haiku for titles.");
    expect(autoTitle("Ask Dr. Chen about the build, i.e. the flaky one.")).toBe(
      "Ask Dr. Chen about the build, i.e. the flaky one.",
    );
  });

  it('a long URL does not leave a stub like "Look at…"', () => {
    const t = autoTitle(`Look at https://example.com/${"a".repeat(80)} please`);
    expect(t.length).toBeLessThanOrEqual(AUTO_TITLE_MAX);
    expect(t.startsWith("Look at https://example.com/aaaa")).toBe(true);
    expect(t.endsWith("…")).toBe(true);
  });

  it("CJK stops end the title without a space", () => {
    expect(autoTitle("修复登录错误。然后更新文档")).toBe("修复登录错误。");
    expect(autoTitle("ログインを直して！それから文書も")).toBe(
      "ログインを直して！",
    );
  });

  it("cuts on grapheme boundaries — no broken emoji", () => {
    const fam = "👨‍👩‍👧‍👦";
    const t = autoTitle(`${"ab ".repeat(19)}${fam.repeat(5)}`);
    expect(t.endsWith("…")).toBe(true);
    // Never a lone surrogate or a ZWJ dangling at the cut.
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(t)).toBe(false);
    expect(t.replace("…", "").endsWith("\u200d")).toBe(false);
    const clipped = autoTitle("😀".repeat(80));
    expect([...clipped.replace("…", "")].every((c) => c === "😀")).toBe(true);
  });

  it("keeps the user's casing — no Title Case", () => {
    expect(autoTitle("Hi! What can you do for me today?")).toBe(
      "Hi! What can you do for me today?",
    );
    expect(autoTitle("fix the iOS build on macOS")).toBe(
      "fix the iOS build on macOS",
    );
  });

  it("empty text has no title", () => {
    expect(autoTitle("")).toBe("");
    expect(autoTitle("   \n  ")).toBe("");
  });

  it("a lone stub returns all the text there is", () => {
    expect(autoTitle("OK.")).toBe("OK.");
  });
});
