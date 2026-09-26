// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "../src/components/ai-elements/terminal";

/* AC-2 (issue #56): the streaming cursor must sit on the prompt line. A zsh
   prompt redraw pads the line with spaces through `\r` overwrites; with
   `whitespace-pre-wrap` that invisible run wraps and drops the cursor onto a
   phantom line below the prompt. */
afterEach(cleanup);

describe("AC-2 terminal cursor sits after the prompt", () => {
  it("a carriage-return-redrawn prompt keeps no trailing-space run to wrap", () => {
    // Real shape zsh emits: a line padded with spaces, then `\r` + the prompt.
    const output = `ls\nREADME.md\n${" ".repeat(80)}\r$ `;
    const { container } = render(<Terminal output={output} isStreaming />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    // No invisible trailing whitespace — nothing can wrap under the cursor.
    expect(pre?.textContent?.endsWith("$ ")).toBe(true);
    // The streaming cursor is rendered inline right after the output.
    expect(pre?.querySelector(".animate-pulse")).not.toBeNull();
  });
});
