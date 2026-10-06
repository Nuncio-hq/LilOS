import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
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
  useUiLayer({ onEscape: onClose });
  useEffect(() => {
    if (focusSignal === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);
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
        value={query}
        onChange={(e) => onQuery(e.target.value)}
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
        className="min-w-12 text-center text-muted-foreground text-xs tabular-nums"
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
