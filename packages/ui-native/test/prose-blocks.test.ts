import { describe, expect, it } from "vitest";
import { MARKDOWN_BLOCKS_SAMPLE } from "../../engine-fake/src/markdown-samples";
import { langName, parseProse } from "../src/components/prose-blocks";

/* #259: fenced code blocks are real blocks — mono panel, lang tag, copy —
   and mid-stream an unclosed fence is a block in progress, never raw
   backticks. Blocks, not inline `code`. */

describe("parseProse — fenced code blocks", () => {
  it("a fenced block with a language parses to a code block", () => {
    const blocks = parseProse("Here:\n\n```ts\nconst x = 1;\n```\n");
    expect(blocks[0]).toEqual({ kind: "text", text: "Here:" });
    expect(blocks[1]).toEqual({
      kind: "code",
      lang: "ts",
      code: "const x = 1;",
      closed: true,
    });
  });

  it("a fenced block without a language is plain code", () => {
    const [b] = parseProse("```\nsome code\n```");
    expect(b).toMatchObject({ kind: "code", lang: null, closed: true });
  });

  it("markdown-looking content inside a fence stays literal", () => {
    const [b] = parseProse("```\n**not bold** | - not a bullet `x`\n```");
    expect(b).toMatchObject({
      kind: "code",
      code: "**not bold** | - not a bullet `x`",
    });
  });

  it("an unclosed fence mid-stream is a code block in progress", () => {
    const blocks = parseProse("Working on it:\n\n```ts\nconst x = 1");
    expect(blocks).toEqual([
      { kind: "text", text: "Working on it:" },
      { kind: "code", lang: "ts", code: "const x = 1", closed: false },
    ]);
  });

  it("text after the fence closes renders as normal text", () => {
    const blocks = parseProse("```py\nx = 1\n```\n\nDone — that's the fix.");
    expect(blocks.at(-1)).toEqual({
      kind: "text",
      text: "Done — that's the fix.",
    });
  });

  it("a fence inside a paragraph line is not a code block", () => {
    const [b] = parseProse("use ` ``` ` like this");
    expect(b).toMatchObject({ kind: "text" });
  });

  it("the #259 sample reply: 7 fenced blocks, no stray backticks in text", () => {
    const blocks = parseProse(MARKDOWN_BLOCKS_SAMPLE);
    const code = blocks.filter((b) => b.kind === "code");
    expect(code.length).toBe(7);
    for (const b of blocks) {
      if (b.kind === "text") expect(b.text).not.toContain("```");
    }
    expect(code.map((c) => (c.kind === "code" ? c.lang : null))).toEqual([
      "ts",
      "python",
      "bash",
      "json",
      "markdown",
      null,
      "diff",
    ]);
    // every fence in the sample is closed
    expect(code.every((c) => c.kind === "code" && c.closed)).toBe(true);
  });

  it("bullets and bold still work alongside fences", () => {
    const blocks = parseProse(
      "Try this:\n\n- one **two**\n- three\n\n```bash\necho hi\n```",
    );
    expect(blocks[0]).toMatchObject({ kind: "text" });
    expect(blocks[1]).toEqual({
      kind: "bullets",
      items: ["one **two**", "three"],
    });
    expect(blocks[2]).toMatchObject({ kind: "code", lang: "bash" });
  });
});

describe("langName", () => {
  it("maps tags to friendly names", () => {
    expect(langName("ts")).toBe("TypeScript");
    expect(langName("tsx")).toBe("TypeScript");
    expect(langName("js")).toBe("JavaScript");
    expect(langName("py")).toBe("Python");
    expect(langName("sh")).toBe("Bash");
    expect(langName("json")).toBe("JSON");
    expect(langName("diff")).toBe("Diff");
  });
  it("unknown tag renders as its raw name; missing renders Code", () => {
    expect(langName("rust")).toBe("rust");
    expect(langName(null)).toBe("Code");
  });
});
