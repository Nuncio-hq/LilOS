/* File `@`-mentions ride the wire as plain text `@relpath` (issue #105 — the
 * agent reads the path itself; nothing is inlined). For display they get the
 * chip look: wrap a path-like token in backticks so MessageResponse renders an
 * inline-code lozenge. Employee mentions (`@Name` — no `/` or `.`) and tokens
 * already inside backticks stay untouched, so the transform is idempotent. */

const TOKEN = /(^|[\s("'])(@[\w./+-]*[./][\w./+-]*)/g;
const CODE_SPAN = /`[^`]*`/g;

export function withFileMentionChips(text: string): string {
  const parts = text.split(CODE_SPAN);
  const spans = text.match(CODE_SPAN) ?? [];
  return parts
    .map(
      (part, i) =>
        part.replace(
          TOKEN,
          (_m, pre: string, tok: string) => `${pre}\`${tok}\``,
        ) + (i < spans.length ? spans[i] : ""),
    )
    .join("");
}
