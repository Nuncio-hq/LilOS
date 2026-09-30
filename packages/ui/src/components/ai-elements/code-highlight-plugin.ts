import type { BundledLanguage } from "shiki";
import { bundledLanguages, bundledLanguagesInfo } from "shiki";
import type { CodeHighlighterPlugin } from "streamdown";
import { highlightCode } from "./code-block";

/* A streamdown `plugins.code` implementation over the repo's own shiki 4 —
   `@streamdown/code` pins `shiki ^3`, which would ship a second highlighter
   and a second grammar set. This reuses the vendored code-block highlighter
   (its per-language highlighter + token caches), so highlighting is
   shared between this path and any other use of `code-block.tsx`. (#307) */

// Fence aliases ("ts", "py") → canonical shiki ids, same shape as @streamdown/code.
const ALIAS_TO_ID = new Map<string, string>();
for (const info of bundledLanguagesInfo) {
  for (const alias of info.aliases ?? []) ALIAS_TO_ID.set(alias, info.id);
}
const SUPPORTED = new Set<string>(Object.keys(bundledLanguages));

const resolveLanguage = (language: string): BundledLanguage | null => {
  const raw = language.trim().toLowerCase();
  const id = ALIAS_TO_ID.get(raw) ?? raw;
  return SUPPORTED.has(id) ? (id as BundledLanguage) : null;
};

/* Plain tokens for missing/unknown languages: same code, no colours. */
const plainResult = (code: string) => ({
  tokens: code.split("\n").map((line) => (line === "" ? [] : [{ content: line }])),
});

/* GitHub-style diff lines: whole-line green/red background tints. The shiki
   `diff` grammar only colours text, so `diff` fences emit one display:block
   token per line here — the block itself keeps the exact same chrome. */
const DIFF_TONES = {
  added: {
    color: "#116329",
    "--shiki-dark": "#3fb950",
    "background-color": "#dafbe1",
    "--shiki-dark-bg": "#2ea04326",
  },
  removed: {
    color: "#82071e",
    "--shiki-dark": "#f85149",
    "background-color": "#ffebe9",
    "--shiki-dark-bg": "#f8514926",
  },
  hunk: {
    color: "#0550ae",
    "--shiki-dark": "#a5d6ff",
    "background-color": "#ddf4ff",
    "--shiki-dark-bg": "#388bfd26",
  },
} as const;

const diffResult = (code: string) => ({
  tokens: code.split("\n").map((line) => {
    if (line === "") return [];
    const tone = line.startsWith("@@")
      ? DIFF_TONES.hunk
      : line.startsWith("+")
        ? DIFF_TONES.added
        : line.startsWith("-")
          ? DIFF_TONES.removed
          : null;
    if (!tone) return [{ content: line, color: "inherit" }];
    return [{ content: line, htmlStyle: { display: "block", ...tone } }];
  }),
});

export const lilosCodePlugin: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  getSupportedLanguages() {
    return [...SUPPORTED];
  },
  getThemes() {
    return ["github-light", "github-dark"];
  },
  supportsLanguage(language) {
    return resolveLanguage(language) !== null;
  },
  highlight({ code, language }, callback) {
    const lang = resolveLanguage(language);
    if (!lang) return plainResult(code);
    if (lang === "diff") return diffResult(code);
    const map = (r: NonNullable<ReturnType<typeof highlightCode>>) => ({
      tokens: r.tokens,
      bg: r.bg,
      fg: r.fg,
    });
    const cached = highlightCode(
      code,
      lang,
      callback ? (result) => callback(map(result)) : undefined,
    );
    return cached ? map(cached) : null;
  },
};
