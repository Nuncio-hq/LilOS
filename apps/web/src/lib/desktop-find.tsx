import { FindBar, setFindSessionOpen } from "@lilos/ui";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Issue #554 — ⌘F find over the open thread, desktop only. The Edit menu's
 * Find items (⌘F / ⌘G / ⇧⌘G) arrive over the preload bridge; the bar then
 * searches the thread's DOM itself — a TreeWalker collects every text-node
 * occurrence, the CSS Custom Highlight API paints them (the active match in
 * its own accent highlight), and `ensureMatchVisible` scrolls the active
 * one inside the scrollport and out from under the bar. Held rows stay
 * mounted for the whole find session via `setFindSessionOpen`, so early
 * turns of a long thread match too (#430/#512).
 *
 * A DOM find never sees the bar itself — the walker skips the
 * `[data-find-bar]` subtree — so the query field can never count as a
 * match, whatever it holds (digits, symbols, any script). The query text is
 * never rewritten either, which keeps macOS IME composition (Telex etc.)
 * and screen readers intact.
 *
 * Rendered once per conversation surface (the host passes it to
 * ThreadView/FocusView's `findBar` slot); on plain web there is no bridge
 * and it renders nothing — the browser's own find bar owns the chord.
 */

/** Case-folded + canonically decomposed, so an NFC query still matches NFD
    text in the DOM (Vietnamese diacritics land in either form depending on
    the keyboard/IME that produced them). */
const fold = (s: string) => s.normalize("NFD").toLowerCase();

/* All occurrences of `needle` inside one text node, folded. Each folded
   offset maps back to the code point that produced it; a match covering
   only part of a decomposed character (e.g. the "o" in "ờ") paints the
   whole glyph — a half-glyph highlight isn't paintable anyway. */
const findInNode = (node: Text, needle: string): Range[] => {
  const raw = node.nodeValue ?? "";
  let hay = "";
  const cpIdx: number[] = []; // folded offset -> code point index
  const cps: { s: number; e: number }[] = []; // code point index -> raw [start, end)
  for (let i = 0, ci = 0; i < raw.length; ci += 1) {
    const cp = raw.codePointAt(i) ?? 0;
    const len = cp > 0xffff ? 2 : 1;
    const d = fold(raw.slice(i, i + len));
    for (let k = 0; k < d.length; k += 1) cpIdx.push(ci);
    cps.push({ s: i, e: i + len });
    hay += d;
    i += len;
  }
  const ranges: Range[] = [];
  for (let at = hay.indexOf(needle); at !== -1; ) {
    const first = cpIdx[at];
    const last = cpIdx[at + needle.length - 1];
    if (first === undefined || last === undefined) break;
    const r = document.createRange();
    r.setStart(node, cps[first].s);
    r.setEnd(node, cps[last].e);
    ranges.push(r);
    at = hay.indexOf(needle, at + Math.max(needle.length, 1));
  }
  return ranges;
};

/** The text-node occurrences of `query` inside the conversation surface
    that hosts the bar — the bar's parent element (the Conversation root in
    Thread, the column in Focus), with the bar's own subtree excluded.
    Matches are per text node; a needle split across element boundaries
    (e.g. half inside a code span) isn't joined — same scope trade-off the
    count probe makes. */
const collectMatches = (host: Element, query: string): Range[] => {
  const root = host.parentElement;
  const needle = fold(query);
  if (!root || !needle) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest("[data-find-bar]")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (
    let n = walker.nextNode() as Text | null;
    n;
    n = walker.nextNode() as Text | null
  ) {
    ranges.push(...findInNode(n, needle));
  }
  return ranges;
};

const paintHighlights = (ranges: Range[], active: number) => {
  const registry = CSS.highlights;
  if (!registry) return;
  registry.set("lilos-find", new Highlight(...ranges));
  registry.set(
    "lilos-find-active",
    active >= 0 && ranges[active]
      ? new Highlight(ranges[active])
      : new Highlight(),
  );
};

const clearHighlights = () => {
  CSS.highlights?.delete("lilos-find");
  CSS.highlights?.delete("lilos-find-active");
};

export function DesktopFindBar() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{
    matches: number;
    activeMatchOrdinal: number;
  } | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  /* The IPC callbacks fire outside React — they read the latest bar state
     through a ref, never a stale closure. */
  const live = useRef({ open, query });
  live.current = { open, query };
  /* Invalidates a running ensureMatchVisible retry chain. */
  const scrollRun = useRef(0);
  /* The live find session's ranges in document order + the 0-based active
     index. Rebuilt on every query/step so rows that mount or stream in
     mid-session can't leave stale ranges painted. */
  const matchRanges = useRef<Range[]>([]);
  const activeIdx = useRef(0);
  /* Host element for scoping — the FindBar div itself. */
  const hostRef = useRef<Element | null>(null);

  const paint = useCallback((active: number) => {
    activeIdx.current = active;
    paintHighlights(matchRanges.current, active);
  }, []);

  /* Chromium used to scroll the active match into view itself; a DOM find
     re-scrolls the match's own element until it sits inside its scroller's
     clip — and out from under the bar, which overlays the port's top
     edge. */
  const ensureMatchVisible = useCallback((index: number) => {
    const run = ++scrollRun.current;
    const attempt = () => {
      if (run !== scrollRun.current) return;
      if (!live.current.open) return;
      const range = matchRanges.current[index];
      if (!range) return;
      const start = range.startContainer;
      const el = (
        start.nodeType === Node.TEXT_NODE ? start.parentElement : start
      ) as Element | null;
      if (!el || !document.contains(el)) return;
      let port = el.parentElement;
      while (port && !/(auto|scroll)/.test(getComputedStyle(port).overflowY))
        port = port.parentElement;
      const pt = port?.getBoundingClientRect();
      const r = range.getClientRects()[0] ?? el.getBoundingClientRect();
      const bar = document
        .querySelector("[data-find-bar]")
        ?.getBoundingClientRect();
      const underBar =
        !!bar &&
        r.bottom > bar.top &&
        r.top < bar.bottom &&
        r.right > bar.left &&
        r.left < bar.right;
      const inside =
        !!pt && r.bottom > pt.top + 1 && r.top < pt.bottom - 1 && !underBar;
      if (!inside) el.scrollIntoView({ block: "center" });
      if (inside || !port) return;
      setTimeout(attempt, 100);
    };
    attempt();
  }, []);

  const runFind = useCallback(
    (text: string, activate: number | "wrap-next" | "wrap-prev") => {
      const host = hostRef.current;
      const ranges = host ? collectMatches(host, text) : [];
      matchRanges.current = ranges;
      const len = ranges.length;
      if (!len) {
        paint(-1);
        setResult({ matches: 0, activeMatchOrdinal: 0 });
        return;
      }
      const next =
        activate === "wrap-next"
          ? (activeIdx.current + 1) % len
          : activate === "wrap-prev"
            ? (activeIdx.current - 1 + len) % len
            : Math.min(activate, len - 1);
      paint(next);
      setResult({ matches: len, activeMatchOrdinal: next + 1 });
      ensureMatchVisible(next);
    },
    [paint, ensureMatchVisible],
  );

  const openBar = useCallback(() => {
    setFindSessionOpen(true);
    setOpen(true);
    setFocusSignal((n) => n + 1);
    /* The bar keeps its last query across closes (like Chrome's): on
       reopen re-run the find so matches re-highlight immediately. Rows may
       still be re-mounting — wait a frame so the walker sees them all. */
    const q = live.current.query;
    if (q) requestAnimationFrame(() => runFind(q, 0));
  }, [runFind]);

  const step = useCallback(
    (forward: boolean) => {
      const q = live.current.query;
      if (!q) return;
      runFind(q, forward ? "wrap-next" : "wrap-prev");
    },
    [runFind],
  );

  const closeBar = useCallback(() => {
    scrollRun.current += 1;
    setOpen(false);
    setResult(null);
    matchRanges.current = [];
    clearHighlights();
    setFindSessionOpen(false);
  }, []);

  useEffect(() => {
    const bridge = window.lilos;
    if (!bridge?.isDesktop) return;
    const openThen = (fn: () => void) => {
      if (!live.current.open) openBar();
      fn();
    };
    const offFind = bridge.onFind?.((action) =>
      action === "open" ? openBar() : openThen(() => step(action === "next")),
    );
    /* The renderer keydown path — a find chord that reaches the page (a
       menu-less dev window, or a platform that passes the chord through)
       does exactly what the menu item would. Both are idempotent, so a
       double delivery only refocuses, never toggles closed. */
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "f") {
        e.preventDefault();
        openBar();
      } else if (k === "g") {
        e.preventDefault();
        openThen(() => step(!e.shiftKey));
      }
    };
    window.addEventListener("keydown", onKey, true);
    /* Rows mount/stream while a session is open — re-run the live find so
       the count and highlights track the DOM instead of freezing at query
       time (debounced: held rows mount in a burst when the bar opens). */
    let moTimer: ReturnType<typeof setTimeout> | undefined;
    const debounced = new MutationObserver(() => {
      clearTimeout(moTimer);
      moTimer = setTimeout(() => {
        const { open: o, query: q } = live.current;
        const el = hostRef.current;
        if (!o || !q || !el) return;
        const next = collectMatches(el, q);
        const len = next.length;
        if (len === matchRanges.current.length) return;
        matchRanges.current = next;
        const idx = len ? Math.min(activeIdx.current, len - 1) : -1;
        paint(idx);
        setResult({
          matches: len,
          activeMatchOrdinal: len ? idx + 1 : 0,
        });
      }, 150);
    });
    /* The bar mounts lazily inside the surface — observe the document so a
       surface swap (Thread → Focus) still gets caught. */
    debounced.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return () => {
      offFind?.();
      debounced.disconnect();
      clearTimeout(moTimer);
      window.removeEventListener("keydown", onKey, true);
      /* Unmounting mid-session ends the find: no stale highlights or pinned
         rows left behind in the next surface. */
      if (live.current.open) {
        clearHighlights();
        matchRanges.current = [];
        setFindSessionOpen(false);
      }
    };
  }, [openBar, step, paint]);

  if (!window.lilos?.isDesktop || !open) return null;
  return (
    <div
      ref={(el) => {
        hostRef.current = el;
      }}
      className="contents"
    >
      <FindBar
        query={query}
        matches={query ? (result?.matches ?? null) : null}
        activeOrdinal={result?.activeMatchOrdinal ?? null}
        focusSignal={focusSignal}
        onQuery={(v) => {
          scrollRun.current += 1;
          setQuery(v);
          if (!v) {
            matchRanges.current = [];
            clearHighlights();
            setResult(null);
          } else {
            runFind(v, 0);
          }
        }}
        onNext={() => step(true)}
        onPrev={() => step(false)}
        onClose={closeBar}
        /* Over the scrollport's top edge but under Focus's 28px fade mask. */
        className="absolute top-9 right-3 z-20"
      />
    </div>
  );
}
