/* #886: auto-titles take the first full sentence of the prompt (up to
   ~60 chars) in the user's own casing — not one word, not a first clause,
   not Title Case. A stub opener ("Hi!") is not a title, so it extends into
   what follows while the whole still fits the cap. A newline ends the
   title. Shared by the relay placeholder and every engine's derived title
   so all three name a thread the same way. */

/** The most a derived title may carry, in characters the eye counts
    (graphemes), so an emoji is one. */
export const AUTO_TITLE_MAX = 60;

/** Fewer words than this and a cut is a stub ("Hi.") — reach for more. */
const STUB_WORDS = 3;

/** A cut that keeps less than this share of the cap is a bad word-boundary
    cut (one long URL leaves "Look at…"): hard-cut at the cap instead. */
const MIN_BOUNDARY_SHARE = 0.5;

/** Only the head of a pasted wall of text is ever looked at. */
const SCAN = 400;

/** A sentence ends at . ! or ? followed by whitespace or the end, or at a
    CJK stop (no space follows those). Mid-word dots ("file.ts", "v1.2")
    do not end one. */
const SENTENCE_END = /[.!?](?=\s|$)|[。！？]/g;

/** Words whose trailing dot is not a stop: "e.g.", "i.e.", "vs.", "Dr.". */
const ABBREVIATION =
  /(?:^|\s)(?:(?:[a-z]\.){2,}|vs\.|cf\.|approx\.|mr\.|mrs\.|ms\.|dr\.|st\.)$/i;

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

/** The text as user-perceived characters — never half an emoji. */
function graphemes(s: string): string[] {
  return segmenter
    ? Array.from(segmenter.segment(s), (g) => g.segment)
    : Array.from(s);
}

/** Words, with each CJK character counted as one (those scripts carry no
    spaces, so "修复登录错误。" is a sentence, not a stub). */
const wordCount = (s: string) =>
  s
    .replace(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g, " $& ")
    .split(/\s+/)
    .filter(Boolean).length;

function clip(s: string, max: number): string {
  const chars = graphemes(s);
  if (chars.length <= max) return s;
  const cut = chars.slice(0, max - 1).join("");
  const boundary = cut.lastIndexOf(" ");
  const kept = boundary > 0 ? cut.slice(0, boundary) : cut;
  return `${(graphemes(kept).length >= max * MIN_BOUNDARY_SHARE ? kept : cut).trimEnd()}…`;
}

/** Where each sentence of `line` ends (string offsets just past the stop). */
function sentenceEnds(line: string): number[] {
  const ends: number[] = [];
  for (const m of line.matchAll(SENTENCE_END)) {
    if (m[0] === "." && ABBREVIATION.test(line.slice(0, m.index + 1))) continue;
    ends.push(m.index + 1);
  }
  return ends;
}

/** The first full sentence of the first line, ≤ AUTO_TITLE_MAX — or "" for
    an empty prompt. */
export function autoTitle(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim());
  const line = (first ?? "").slice(0, SCAN).replace(/\s+/g, " ").trim();
  if (!line) return "";
  let cut = 0;
  for (const e of sentenceEnds(line)) {
    if (cut > 0 && wordCount(line.slice(0, cut)) >= STUB_WORDS) break;
    if (graphemes(line.slice(0, e)).length > AUTO_TITLE_MAX) break;
    cut = e;
  }
  const title = line.slice(0, cut);
  if (cut > 0 && wordCount(title) >= STUB_WORDS) return title;
  // A stub, an over-long first sentence or no stop at all: fill the cap.
  return clip(line, AUTO_TITLE_MAX);
}
