// @vitest-environment happy-dom
/* AC tests for issue #307: fenced code in agent replies gets real syntax
   highlighting inside ONE panel — a single header row, no card-in-card —
   plus diff line backgrounds, literal markdown-in-fence, plain rendering for
   unknown languages, exact-code copy and unclosed fences during streaming. */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MessageResponse } from "../src/components/ai-elements/message";

/* happy-dom does not implement every browser API the vendored components touch. */
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
afterEach(cleanup);

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;

const TS_BLOCK = fence(
  "ts",
  `// encode/decode helpers
import { z } from "zod";
export const encode = (f: Frame): string => JSON.stringify(f);`,
);

const blocks = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('[data-streamdown="code-block"]'));

const tokenColors = (block: Element) =>
  new Set(
    Array.from(block.querySelectorAll("span[style]"))
      .map((s) => s.getAttribute("style") ?? "")
      .map((style) => /--sdm-c:([^;]+)/.exec(style)?.[1])
      .filter((v): v is string => Boolean(v)),
  );

/* The shiki highlighter loads lazily; waits until token colours land. */
const waitForHighlight = (block: Element, min = 2) =>
  waitFor(() => expect(tokenColors(block).size).toBeGreaterThanOrEqual(min), {
    timeout: 20000,
  });

describe("issue #307 — real highlighting, one panel", () => {
  test("AC-1 a ts fence renders token colours; comments are dimmed", async () => {
    const { container } = render(
      <MessageResponse className="lilos-prose">{TS_BLOCK}</MessageResponse>,
    );
    const [block] = blocks(container);
    expect(block).toBeTruthy();
    await waitForHighlight(block);
    const comment = Array.from(block.querySelectorAll("span[style]")).find(
      (s) => s.textContent === "// encode/decode helpers",
    );
    expect(comment).toBeTruthy();
    // github-light's comment colour — the dim-comment palette #259 asks for.
    expect(comment?.getAttribute("style")).toContain("--sdm-c: #6A737D");
  });

  test("AC-2 one container, one header row carrying data-language, one copy action", () => {
    const { container } = render(
      <MessageResponse className="lilos-prose">{TS_BLOCK}</MessageResponse>,
    );
    const [block] = blocks(container);
    expect(
      block.querySelectorAll('[data-streamdown="code-block-header"]'),
    ).toHaveLength(1);
    const header = block.querySelector('[data-streamdown="code-block-header"]');
    expect(header?.getAttribute("data-language")).toBe("ts");
    expect(
      block.querySelectorAll('[data-streamdown="code-block-actions"]'),
    ).toHaveLength(1);
    expect(
      block.querySelector('[data-streamdown="code-block-copy-button"]'),
    ).toBeTruthy();
    expect(
      block.querySelector('[data-streamdown="code-block-download-button"]'),
    ).toBeNull();
    expect(
      block.querySelectorAll('[data-streamdown="code-block-body"]'),
    ).toHaveLength(1);
  });

  test("AC-1 unknown language renders plain with no error", () => {
    const { container } = render(
      <MessageResponse className="lilos-prose">
        {fence("frobnicate", "x = y ++ z << 1")}
      </MessageResponse>,
    );
    const [block] = blocks(container);
    expect(block).toBeTruthy();
    expect(block.textContent).toContain("x = y ++ z << 1");
    expect(tokenColors(block).size).toBe(0);
  });

  test("AC-4 diff fence paints added/removed/hunk line backgrounds", () => {
    const diff = fence(
      "diff",
      `@@ -1,2 +1,3 @@
 context();
-removed();
+added();`,
    );
    const { container } = render(
      <MessageResponse className="lilos-prose">{diff}</MessageResponse>,
    );
    const [block] = blocks(container);
    const styles = (text: string) =>
      Array.from(block.querySelectorAll("span[style]"))
        .filter((s) => s.textContent?.includes(text))
        .map((s) => s.getAttribute("style") ?? "");
    expect(styles("+added();")[0]).toContain("--sdm-tbg: #dafbe1");
    expect(styles("-removed();")[0]).toContain("--sdm-tbg: #ffebe9");
    expect(styles("@@ -1,2 +1,3 @@")[0]).toContain("--sdm-tbg: #ddf4ff");
  });

  test("AC-4 markdown-looking text inside a fence stays literal", () => {
    const md = fence("markdown", `## Not a heading\n- **not bold** \`x\``);
    const { container } = render(
      <MessageResponse className="lilos-prose">{md}</MessageResponse>,
    );
    const [block] = blocks(container);
    expect(block.textContent).toContain("**not bold**");
    expect(block.querySelector("strong")).toBeNull();
  });

  test("AC-5 copy writes the exact code and shows the Copied state", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const code = `const a = 1;\nconst b = "two";`;
    const { container } = render(
      <MessageResponse className="lilos-prose">
        {fence("ts", code)}
      </MessageResponse>,
    );
    const copy = container.querySelector(
      '[data-streamdown="code-block-copy-button"]',
    );
    expect(copy).toBeTruthy();
    fireEvent.click(copy as Element);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${code}\n`));
    await waitFor(() => expect(container.textContent).toContain("Copied"));
  });

  test("AC-6 an unclosed fence renders as an in-progress block", () => {
    const { container } = render(
      <MessageResponse className="lilos-prose" isAnimating={true}>
        {"```ts\nconst partial = "}
      </MessageResponse>,
    );
    const [block] = blocks(container);
    expect(block).toBeTruthy();
    expect(block.textContent).toContain("const partial =");
    expect(block.hasAttribute("data-incomplete")).toBe(true);
  });
});
