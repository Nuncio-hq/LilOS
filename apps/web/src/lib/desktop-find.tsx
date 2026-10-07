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

/** Ordinal of the find bar's own match, when there is one. FindBar renders
    the query with a lookalike-letter swap so the field's text can never
    hold the needle — except a query with no mappable letter (digits or
    symbols only), whose field still matches once, at the input's
    flat-tree position: every text-node occurrence before it, plus one. */
const inputMatchOrdinal = (text: string) => {
  const input = document.querySelector<HTMLInputElement>("[data-find-input]");
  if (!input?.value.toLowerCase().includes(text.toLowerCase())) return null;
  const needle = text.toLowerCase();
  let seen = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(input.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING))
      continue;
    const value = n.nodeValue ?? "";
    for (let at = value.toLowerCase().indexOf(needle); at !== -1; ) {
      seen += 1;
      at = value.toLowerCase().indexOf(needle, at + needle.length);
    }
  }
  return seen + 1;
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
  /* Direction of the last step, used to keep walking when the active match
     lands on the bar's own input. */
  const lastStepDir = useRef(true);
  /* Chromium's raw active ordinal on the last result, for stall checks. */
  const lastRawOrd = useRef(0);
  /* A step that comes back with the ordinal unmoved didn't move: Blink can
     re-report the current match once or twice after the session has been
     re-anchored by repeated fresh searches — retry the step, bounded. */
  const pendingStep = useRef<{
    dir: boolean;
    from: number;
    tries: number;
  } | null>(null);

  /* Chromium scrolls the active match into view itself, but the jump can
     land while the un-stub mount still holds the scrollport's top edge —
     the hold then undoes it and the match stays off-screen. Re-scroll the
     match's own element until it sits inside its scroller's clip — and out
     from under the bar, which overlays the port's top edge. */
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
    lastStepDir.current = forward;
    pendingStep.current = { dir: forward, from: lastRawOrd.current, tries: 0 };
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
      const q = live.current.query;
      lastRawOrd.current = r.activeMatchOrdinal;
      /* A requested step that reports the ordinal unmoved didn't move —
         Blink can re-report the current match right after the session is
         re-anchored; retry the step (bounded) instead of showing a stall. */
      const stepped = pendingStep.current;
      pendingStep.current = null;
      if (
        stepped &&
        r.matches > 1 &&
        r.activeMatchOrdinal === stepped.from &&
        stepped.tries < 3
      ) {
        pendingStep.current = { ...stepped, tries: stepped.tries + 1 };
        window.lilos?.findInPage?.({
          text: q,
          step: stepped.dir ? "next" : "prev",
        });
        return;
      }
      /* The field's display value is unmatchable by construction; only a
         query with no mappable letter still lands a match inside the
         input — subtract it from the count/ordinal and step on past it
         instead of activating the field itself. */
      const skip = q ? inputMatchOrdinal(q) : null;
      const total = r.matches - (skip ? 1 : 0);
      let ord = r.activeMatchOrdinal;
      if (skip && ord === skip) {
        if (r.matches > 1) {
          pendingStep.current = {
            dir: lastStepDir.current,
            from: r.activeMatchOrdinal,
            tries: 0,
          };
          window.lilos?.findInPage?.({
            text: q,
            step: lastStepDir.current ? "next" : "prev",
          });
          return;
        }
        ord = 0;
      } else if (skip && ord > skip) {
        ord -= 1;
      }
      setResult({ matches: total, activeMatchOrdinal: ord });
      if (total > 0 && ord > 0) ensureMatchVisible(q, ord);
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
        pendingStep.current = null;
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
