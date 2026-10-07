import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useUiLayer } from "../chat/ui-layers";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";

/**
 * Issue #554 — the thread find bar. Presentational only: the host owns the
 * query and the find session (Electron's `webContents.findInPage` behind
 * the desktop bridge); this renders the bar and owns its keys.
 *
 * The bar is a UI layer in #576's stack — while top-most, Esc closes the
 * bar and never the surface beneath, which is exactly the stack's
 * "menu/dialog" tier.
 */

/** Chromium's find-in-page searches form-field text too, so a find input
    holding the plain query would count (and paint) itself as a match —
    and invisible separators don't help: the searcher's text extraction
    strips format characters before comparing. The field instead renders
    the query with one letter swapped for a lookalike Cyrillic/Greek
    letter — visually identical, but the field's text can never equal
    the needle, so the bar's own text is never a match and keeps normal
    selection styling. A query with no mappable letter (digits or
    symbols only) renders unchanged; the host subtracts that residual
    input match from the count itself. */
const HOMOGLYPHS: Record<string, string> = {
  a: "\u0430",
  c: "\u0441",
  d: "\u0501",
  e: "\u0435",
  g: "\u0261",
  h: "\u04BB",
  i: "\u0456",
  j: "\u0458",
  k: "\u03BA",
  m: "\u217F",
  n: "\u0578",
  o: "\u043E",
  p: "\u0440",
  s: "\u0455",
  t: "\u03C4",
  u: "\u03C5",
  v: "\u03BD",
  w: "\u03C9",
  x: "\u0445",
  y: "\u0443",
  A: "\u0410",
  B: "\u0412",
  C: "\u0421",
  E: "\u0415",
  H: "\u041D",
  I: "\u0406",
  J: "\u0408",
  K: "\u039A",
  M: "\u039C",
  N: "\u039D",
  O: "\u041E",
  P: "\u0420",
  S: "\u0405",
  T: "\u03A4",
  X: "\u0425",
  Y: "\u0423",
  Z: "\u0396",
};
/* Letters with the most faithful lookalikes are preferred swap spots. */
const SWAP_ORDER = "aeocpxsijyAEOCPXSIJY";
const GLYPH_TO_ASCII = new Map(
  Object.entries(HOMOGLYPHS).map(([a, g]) => [g, a]),
);
export const displayFindQuery = (q: string) => {
  for (const ch of SWAP_ORDER) {
    const i = q.lastIndexOf(ch);
    if (i !== -1) return q.slice(0, i) + HOMOGLYPHS[ch] + q.slice(i + 1);
  }
  for (let i = q.length - 1; i >= 0; i -= 1) {
    const g = HOMOGLYPHS[q[i]];
    if (g) return q.slice(0, i) + g + q.slice(i + 1);
  }
  return q;
};
export const parseFindQuery = (v: string) =>
  [...v].map((c) => GLYPH_TO_ASCII.get(c) ?? c).join("");

export function FindBar({
  query,
  matches,
  activeOrdinal,
  focusSignal,
  onQuery,
  onNext,
  onPrev,
  onClose,
  className,
}: {
  query: string;
  /** Chromium's match count for the live find session; null = none yet. */
  matches: number | null;
  /** 1-based ordinal of the active match; null alongside `matches`. */
  activeOrdinal: number | null;
  /** Bumped by the host to re-focus the input (the ⌘F item re-arms it). */
  focusSignal: number;
  onQuery: (v: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  /** Caret index to restore after the display value re-renders whole. */
  const pendingCaret = useRef<number | null>(null);
  useUiLayer({ onEscape: onClose });
  useEffect(() => {
    if (focusSignal === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);
  /* The swapped letter can move position between renders (e.g. typing a
     preferred letter shifts the swap spot); keep the caret where the
     user was typing instead of letting it jump. Lengths are 1:1. */
  const shown = displayFindQuery(query);
  useLayoutEffect(() => {
    const i = pendingCaret.current;
    pendingCaret.current = null;
    if (i === null || !inputRef.current) return;
    const at = Math.min(i, inputRef.current.value.length);
    inputRef.current.setSelectionRange(at, at);
  });
  return (
    <div
      data-find-bar
      role="search"
      aria-label="Find in thread"
      className={cn(
        "flex items-center gap-0.5 rounded-lg border bg-popover py-1 ps-2 pe-1 shadow-lg",
        className,
      )}
    >
      <input
        ref={inputRef}
        data-find-input
        value={shown}
        aria-label="Find in thread"
        onChange={(e) => {
          pendingCaret.current =
            e.target.selectionStart ?? e.target.value.length;
          onQuery(parseFindQuery(e.target.value));
        }}
        onCopy={(e) => {
          /* The clipboard gets the clean query, not the display text. */
          e.clipboardData.setData("text/plain", query);
          e.preventDefault();
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (e.shiftKey) onPrev();
          else onNext();
        }}
        placeholder="Find in thread"
        className="w-36 bg-transparent text-sm outline-none placeholder:text-muted-foreground sm:w-44"
      />
      <span
        data-find-count
        className="min-w-12 text-center text-foreground text-xs tabular-nums"
      >
        {matches === null
          ? ""
          : matches === 0
            ? "No results"
            : `${activeOrdinal ?? 0} of ${matches}`}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onPrev}
        disabled={!query}
        title="Previous match (⇧⌘G)"
        aria-label="Previous match"
        data-find-prev
      >
        <ChevronUpIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onNext}
        disabled={!query}
        title="Next match (⌘G)"
        aria-label="Next match"
        data-find-next
      >
        <ChevronDownIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onClose}
        title="Close (Esc)"
        aria-label="Close find"
        data-find-close
      >
        <XIcon />
      </Button>
    </div>
  );
}
