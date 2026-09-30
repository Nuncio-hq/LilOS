/**
 * Syntax highlighting for fenced code blocks — lowlight (highlight.js)
 * token trees flattened to styled spans the RN side can render as nested
 * <Text>. Registered grammars only: the languages #259 names plus aliases;
 * anything else is one plain span, never an error.
 */
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import { createLowlight } from "lowlight";

const low = createLowlight({
  bash,
  diff,
  javascript,
  json,
  python,
  typescript,
});

const ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  json5: "json",
  patch: "diff",
};

/** One flattened span: text plus every hljs class on the path down to it. */
export type CodeSpan = { text: string; classes: string[] };

type HastText = { type: "text"; value: string };
type HastElement = {
  type: "element";
  tagName: string;
  properties?: { className?: string[] };
  children: HastNode[];
};
type HastNode = HastText | HastElement;

function walk(node: HastNode, classes: string[], out: CodeSpan[]) {
  if (node.type === "text") {
    if (!node.value) return;
    const last = out[out.length - 1];
    if (last && sameClasses(last.classes, classes)) last.text += node.value;
    else out.push({ text: node.value, classes });
    return;
  }
  const next = [...classes, ...(node.properties?.className ?? [])];
  for (const child of node.children) walk(child, next, out);
}

function sameClasses(a: string[], b: string[]) {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

/** The fence tag → a registered grammar name, or null for plain code. */
export function resolveLang(lang: string | null): string | null {
  if (!lang) return null;
  const l = lang.toLowerCase();
  const name = ALIASES[l] ?? l;
  return low.registered(name) ? name : null;
}

export function highlight(code: string, lang: string | null): CodeSpan[] {
  const grammar = resolveLang(lang);
  if (!grammar) return [{ text: code, classes: [] }];
  try {
    const root = low.highlight(grammar, code, { prefix: "hljs-" });
    const out: CodeSpan[] = [];
    for (const node of root.children as HastNode[]) walk(node, [], out);
    return out.length ? out : [{ text: code, classes: [] }];
  } catch {
    return [{ text: code, classes: [] }];
  }
}
