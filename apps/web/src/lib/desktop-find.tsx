import { FindBar, setFindSessionOpen } from "@lilos/ui";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Issue #554 — ⌘F find over the open thread, desktop only. The Edit menu's
 * Find items (⌘F / ⌘G / ⇧⌘G) arrive over the preload bridge; the bar then
 * drives `webContents.findInPage`, which highlights every match and scrolls
 * the active one into view. Held rows stay mounted for the whole find
 * session via `setFindSessionOpen`, so early turns of a long thread match
 * too (#430/#512).
 *
 * Rendered once per conversation surface (the host passes it to
 * ThreadView/FocusView's `findBar` slot); on plain web there is no bridge
 * and it renders nothing — the browser's own find bar owns the chord.
 */
/** Element holding the `ordinal`-th occurrence of `text` in document
    order — the same ordering Chromium's `activeMatchOrdinal` counts by. */
const locateNthOccurrence = (text: string, ordinal: number) => {
  const needle = text.toLowerCase();
  if (!needle || ordinal < 1) return null;
  let seen = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const value = (n.nodeValue ?? "").toLowerCase();
    for (let at = value.indexOf(needle); at !== -1; ) {
      seen += 1;
      if (seen === ordinal) return n.parentElement;
      at = value.indexOf(needle, at + needle.length);
    }
  }
  return null;
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

  /* Chromium scrolls the active match into view itself, but the jump can
     land while the un-stub mount still holds the scrollport's top edge —
     the hold then undoes it and the match stays off-screen. Re-scroll the
     match's own element until it sits inside its scroller's clip. */
  const ensureMatchVisible = useCallback((text: string, ordinal: number) => {
    const run = ++scrollRun.current;
    const attempt = () => {
      if (run !== scrollRun.current) return;
      if (!live.current.open || live.current.query !== text) return;
      const el = locateNthOccurrence(text, ordinal);
      if (!el) return;
      let port = el.parentElement;
      while (port && !/(auto|scroll)/.test(getComputedStyle(port).overflowY))
        port = port.parentElement;
      const pt = port?.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const inside = !!pt && r.bottom > pt.top + 1 && r.top < pt.bottom - 1;
      if (!inside) el.scrollIntoView({ block: "center" });
      if (inside || !port) return;
      setTimeout(attempt, 100);
    };
    attempt();
  }, []);

  const openBar = useCallback(() => {
    setFindSessionOpen(true);
    setOpen(true);
    setFocusSignal((n) => n + 1);
    /* The bar keeps its last query across closes (like Chrome's): on
       reopen re-run the find so matches re-highlight immediately. */
    const q = live.current.query;
    if (q) window.lilos?.findInPage?.({ text: q });
  }, []);

  const step = useCallback((forward: boolean) => {
    const q = live.current.query;
    if (!q) return;
    window.lilos?.findInPage?.({
      text: q,
      step: forward ? "next" : "prev",
    });
  }, []);

  const closeBar = useCallback(() => {
    scrollRun.current += 1;
    setOpen(false);
    setResult(null);
    window.lilos?.stopFindInPage?.();
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
    const offResult = bridge.onFindResult?.((r) => {
      setResult({
        matches: r.matches,
        activeMatchOrdinal: r.activeMatchOrdinal,
      });
      if (r.matches > 0 && r.activeMatchOrdinal > 0)
        ensureMatchVisible(live.current.query, r.activeMatchOrdinal);
    });
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
    return () => {
      offFind?.();
      offResult?.();
      window.removeEventListener("keydown", onKey, true);
      /* Unmounting mid-session ends the find: no stale highlights or pinned
         rows left behind in the next surface. */
      if (live.current.open) {
        bridge.stopFindInPage?.();
        setFindSessionOpen(false);
      }
    };
  }, [openBar, step, ensureMatchVisible]);

  if (!window.lilos?.isDesktop || !open) return null;
  return (
    <FindBar
      query={query}
      matches={query ? (result?.matches ?? null) : null}
      activeOrdinal={result?.activeMatchOrdinal ?? null}
      focusSignal={focusSignal}
      onQuery={(v) => {
        scrollRun.current += 1;
        setQuery(v);
        if (!v) {
          window.lilos?.stopFindInPage?.();
          setResult(null);
        } else {
          window.lilos?.findInPage?.({ text: v });
        }
      }}
      onNext={() => step(true)}
      onPrev={() => step(false)}
      onClose={closeBar}
      /* Over the scrollport's top edge but under Focus's 28px fade mask. */
      className="absolute top-9 right-3 z-20"
    />
  );
}
