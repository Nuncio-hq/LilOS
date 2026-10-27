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

  it("collapses whitespace and newlines", () => {
    expect(autoTitle("  Fix the\n  relay reconnect bug. ")).toBe(
      "Fix the relay reconnect bug.",
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
