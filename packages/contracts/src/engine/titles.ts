/* #886: auto-titles take the first full sentence of the prompt (up to
   ~60 chars) — not one word, not a first clause, not ~6 words. A stub
   opener ("Hi!") is not a title, so it extends into what follows while
   the whole still fits the cap. Shared by the relay placeholder and every
   engine's derived title so all three name a thread the same way. */

/** The most a derived title may carry. */
export const AUTO_TITLE_MAX = 60;

/** Under this, a cut is a stub ("Hi.") — reach for more of the prompt. */
const AUTO_TITLE_MIN = 15;

/** A sentence ends at . ! or ? followed by whitespace or the end —
   mid-word dots ("file.ts", "v1.2") do not end it. */
const SENTENCE_END = /[.!?](?=\s|$)/g;

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/** The first full sentence, ≤ AUTO_TITLE_MAX — or "" for an empty prompt. */
export function autoTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const ends = [...clean.matchAll(SENTENCE_END)].map((m) => m.index + 1);
  let cut = ends[0] ?? 0;
  for (const e of ends) {
    if (e <= cut) continue;
    if (cut >= AUTO_TITLE_MIN || e > AUTO_TITLE_MAX) break;
    cut = e;
  }
  if (cut >= AUTO_TITLE_MIN && cut <= AUTO_TITLE_MAX) {
    return clean.slice(0, cut);
  }
  // A stub or an over-long first sentence: fill the cap from the prompt.
  return clip(clean, AUTO_TITLE_MAX);
}
