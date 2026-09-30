/**
 * Block structure for `Prose` — the slice of markdown agent replies send
 * (see prose.tsx). Pure TS so vitest covers it; the RN component only
 * renders what this returns.
 */

export type ProseBlock =
  | { kind: "text"; text: string }
  | { kind: "bullets"; items: string[] }
  | {
      kind: "code";
      /** Info-string tag (`ts`, `python`, …); null when the fence is bare. */
      lang: string | null;
      code: string;
      /** False while the closing ``` hasn't streamed in yet (#259 AC-4). */
      closed: boolean;
    }
  | {
      kind: "table";
      align: ("left" | "center" | "right")[];
      header: string[];
      rows: string[][];
    };

const FENCE_OPEN = /^\s*```/;
const FENCE_CLOSE = /^\s*```\s*$/;
const BULLET = /^\s*[-*] /;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const ALIGN_CELL = /^:?-{3,}:?$/;

/** Fenced code blocks first, then blank-line paragraphs — fences win over
    every other construct, their content is always literal. */
export function parseProse(raw: string): ProseBlock[] {
  const lines = raw.split("\n");
  const out: ProseBlock[] = [];
  let text: string[] = [];

  const flushText = () => {
    let block: string[] = [];
    for (const line of text) {
      if (line.trim() === "") {
        pushParagraph(block);
        block = [];
      } else {
        block.push(line);
      }
    }
    pushParagraph(block);
    text = [];
  };
  const pushParagraph = (block: string[]) => {
    if (!block.length) return;
    if (block.every((l) => BULLET.test(l))) {
      out.push({
        kind: "bullets",
        items: block.map((l) => l.replace(BULLET, "")),
      });
    } else {
      out.push({ kind: "text", text: block.join("\n") });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    if (FENCE_OPEN.test(lines[i])) {
      flushText();
      const lang = lines[i].replace(FENCE_OPEN, "").trim().split(/\s+/)[0];
      const code: string[] = [];
      let closed = false;
      while (++i < lines.length) {
        if (FENCE_CLOSE.test(lines[i])) {
          closed = true;
          break;
        }
        code.push(lines[i]);
      }
      out.push({
        kind: "code",
        lang: lang || null,
        code: code.join("\n"),
        closed,
      });
    } else if (isTableStart(lines, i)) {
      flushText();
      const header = splitRow(lines[i]);
      const align = splitRow(lines[i + 1]).map(alignOf);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      i--;
      // Columns are the header's; short rows pad, extra cells drop (GFM).
      out.push({
        kind: "table",
        align: header.map((_, j) => align[j] ?? "left"),
        header,
        rows: rows.map((r) => header.map((_, j) => r[j] ?? "")),
      });
    } else {
      text.push(lines[i]);
    }
  }
  flushText();
  return out;
}

/* A table only starts once its `| --- |` row lands — until then a `|`
   line is plain prose. Body rows need a trailing pipe, so a row still
   streaming mid-line never joins the table; it falls out as text (#306). */
function isTableStart(lines: string[], i: number): boolean {
  if (!/^\s*\|/.test(lines[i]) || i + 1 >= lines.length) return false;
  if (!/^\s*\|/.test(lines[i + 1])) return false;
  const cells = splitRow(lines[i + 1]);
  return cells.length > 0 && cells.every((c) => ALIGN_CELL.test(c));
}

/** `| a | b |` → [a, b]; `\|` stays inside its cell. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur);
      cur = "";
    } else {
      cur += s[i];
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function alignOf(cell: string): "left" | "center" | "right" {
  const l = cell.startsWith(":");
  const r = cell.endsWith(":");
  return l && r ? "center" : r ? "right" : "left";
}

export const TABLE_COL_MIN = 104;
export const TABLE_COL_MAX = 220;

/* One width per column, shared by header and every row — measured on
   the widest cell so each row's boundaries land on the same x. ~7.5px
   per glyph at the 14px cell size + 24px padding, clamped to
   [104, 220]: beyond the cap the cell wraps. */
export function columnWidths(header: string[], rows: string[][]): number[] {
  return header.map((_, j) => {
    let longest = header[j]?.length ?? 0;
    for (const row of rows) {
      const len = row[j]?.length ?? 0;
      if (len > longest) longest = len;
    }
    return Math.min(TABLE_COL_MAX, Math.max(TABLE_COL_MIN, longest * 7.5 + 24));
  });
}

/** Fence tags → the label on the block's header row (matches the desktop
    code-block names, #307). Unknown tags show as typed; bare fences "Code". */
export function langName(lang: string | null): string {
  if (!lang) return "Code";
  const NAMES: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript",
    mts: "TypeScript",
    cts: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    mjs: "JavaScript",
    cjs: "JavaScript",
    py: "Python",
    python: "Python",
    sh: "Bash",
    bash: "Bash",
    zsh: "Bash",
    shell: "Bash",
    json: "JSON",
    jsonc: "JSON",
    diff: "Diff",
    patch: "Diff",
    md: "Markdown",
    markdown: "Markdown",
    yml: "YAML",
    yaml: "YAML",
    toml: "TOML",
    xml: "XML",
    html: "HTML",
    css: "CSS",
    sql: "SQL",
  };
  return NAMES[lang.toLowerCase()] ?? lang;
}
