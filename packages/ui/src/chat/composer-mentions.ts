/* `@`-mention fragment helpers for the composer menu (issue #105): one menu,
 * two sections — Employees then Files. A mention is a trailing `@token` whose
 * `@` sits at a word boundary (start or after whitespace), so `mail me@x`
 * never opens the menu. File tokens widen the character set beyond `\w` to
 * include `.`, `/`, `+`, `-` so `src/app.tsx` completes. */

export interface MentionFragment {
  /** Index of the `@` in the draft. */
  at: number;
  /** Text after the `@` — the search query. */
  query: string;
}

const FRAGMENT = /(^|\s)@([\w./+-]*)$/;

/** The fragment the draft ends in, or null. */
export function mentionQuery(draft: string): MentionFragment | null {
  const m = FRAGMENT.exec(draft);
  return m ? { at: m.index + m[1].length, query: m[2] } : null;
}

/** Replace the live fragment (or append) with `@token `; dirs get a `/`. */
export function insertMention(
  draft: string,
  token: string,
  dir: boolean,
): string {
  const m = mentionQuery(draft);
  const head = m ? draft.slice(0, m.at) : `${draft.replace(/\s*$/, "")} `;
  return `${head}@${token}${dir ? "/" : ""} `;
}

const AT_TOKEN = /(^|\s)(@[\w./+-]+)[ ]?$/;

/** Index where the `@token` ending at the caret starts (a chip is atomic:
 * one Backspace removes token + trailing space), or null when the caret is
 * not right after a mention. */
export function mentionBeforeCaret(
  draft: string,
  caret: number,
): number | null {
  const m = AT_TOKEN.exec(draft.slice(0, caret));
  return m ? m.index + m[1].length : null;
}
