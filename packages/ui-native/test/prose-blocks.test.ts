import { describe, expect, it } from "vitest";
import {
  MARKDOWN_BLOCKS_SAMPLE,
  MARKDOWN_TABLE_SAMPLE,
} from "../../engine-fake/src/markdown-samples";
import {
  columnWidths,
  langName,
  parseProse,
  TABLE_COL_MAX,
  TABLE_COL_MIN,
} from "../src/components/prose-blocks";

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

describe("parseProse — GFM tables", () => {
  it("a header + separator + rows parses to a table block", () => {
    const [b] = parseProse("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |");
    expect(b).toEqual({
      kind: "table",
      align: ["left", "left"],
      header: ["a", "b"],
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
    });
  });

  it(":--- / ---: / :---: / --- map to left/right/center/left", () => {
    const [b] = parseProse(
      "| a | b | c | d |\n| :--- | ---: | :---: | --- |\n| 1 | 2 | 3 | 4 |",
    );
    expect(b).toMatchObject({
      kind: "table",
      align: ["left", "right", "center", "left"],
    });
  });

  it("prose before and after the table stays text", () => {
    const blocks = parseProse(
      "Look:\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nDone.",
    );
    expect(blocks.map((x) => x.kind)).toEqual(["text", "table", "text"]);
  });

  it("a pipe line with no separator after it stays plain text", () => {
    const blocks = parseProse("use a | b for this\nnot a separator line");
    expect(blocks).toEqual([
      { kind: "text", text: "use a | b for this\nnot a separator line" },
    ]);
  });

  it("a partial row mid-stream is held back as plain text, not a table row", () => {
    const blocks = parseProse(
      "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | half-typed",
    );
    expect(blocks[0]).toMatchObject({
      kind: "table",
      rows: [["1", "2"]],
    });
    expect(blocks[1]).toEqual({ kind: "text", text: "| 3 | half-typed" });
  });

  it("short rows pad to the column count; extra cells drop", () => {
    const [b] = parseProse(
      "| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n| 1 | 2 | 3 | 4 |",
    );
    expect(b).toMatchObject({
      kind: "table",
      rows: [
        ["1", "2", ""],
        ["1", "2", "3"],
      ],
    });
  });

  it("inline markdown inside cells stays literal for the renderer", () => {
    const [b] = parseProse("| a | b |\n| --- | --- |\n| **bold** | `code` |");
    expect(b).toMatchObject({
      kind: "table",
      rows: [["**bold**", "`code`"]],
    });
  });

  it("an escaped \\| stays inside its cell", () => {
    const [b] = parseProse("| a | b |\n| --- | --- |\n| x \\| y | z |");
    expect(b).toMatchObject({ kind: "table", rows: [["x | y", "z"]] });
  });

  it("the #306 sample reply: three tables with the right shapes", () => {
    const tables = parseProse(MARKDOWN_TABLE_SAMPLE).filter(
      (b) => b.kind === "table",
    );
    expect(tables.length).toBe(3);
    expect(tables[0]).toMatchObject({
      header: ["Issue", "What it needs"],
      align: ["left", "left"],
    });
    expect(tables[1]).toMatchObject({
      header: ["Slice", "AC", "Tier", "Status", "Owner", "Notes"],
      align: Array(6).fill("left"),
    });
    expect(tables[2]).toMatchObject({
      header: ["Rank", "Name", "Score"],
      align: ["right", "center", "left"],
      rows: [
        ["1", "Relay", "98.2"],
        ["12", "Harness", "87.04"],
        ["123", "Desktop", "76.345"],
      ],
    });
    // long Vietnamese cell text lands intact in one cell
    const cell = tables[0].kind === "table" ? tables[0].rows[0][1] : "";
    expect(cell).toContain("Cần trả lời");
  });

  it("the fixture carries a **bold** cell and a `code` cell (AC-1 visual)", () => {
    const tables = parseProse(MARKDOWN_TABLE_SAMPLE).filter(
      (b) => b.kind === "table",
    );
    const cells = tables[1].kind === "table" ? tables[1].rows.flat() : [];
    expect(cells).toContain("**Building**");
    expect(cells).toContain("`agent-ready`");
  });
});

describe("columnWidths — one grid, shared x-offsets", () => {
  it("each column gets the widest cell's width, shared by every row", () => {
    const header = ["a", "b"];
    const rows = [
      ["tiny", "this is a much much much longer cell that wants the cap"],
      ["x", "y"],
    ];
    const w = columnWidths(header, rows);
    expect(w.length).toBe(2);
    // col 0: longest is 4 → min clamp; col 1: longest → at/over the cap
    expect(w[0]).toBe(TABLE_COL_MIN);
    expect(w[1]).toBe(TABLE_COL_MAX);
    // the same array feeds header + all rows, so boundaries share x-offsets:
    // cumulative offsets are identical per row by construction
    const offsets = w.reduce<number[]>((acc, _width, i) => {
      acc.push(i === 0 ? 0 : acc[i - 1] + w[i - 1]);
      return acc;
    }, []);
    expect(offsets).toEqual([0, TABLE_COL_MIN]);
  });

  it("mid-size content lands between the clamps", () => {
    const w = columnWidths(["head"], [["12345678901234567890"]]);
    expect(w[0]).toBeGreaterThan(TABLE_COL_MIN);
    expect(w[0]).toBeLessThan(TABLE_COL_MAX);
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
