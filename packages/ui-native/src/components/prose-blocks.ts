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
    };

const FENCE_OPEN = /^\s*```/;
const FENCE_CLOSE = /^\s*```\s*$/;
const BULLET = /^\s*[-*] /;

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
    } else {
      text.push(lines[i]);
    }
  }
  flushText();
  return out;
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
