import {
  ArrowLeftIcon,
  ArrowRightIcon,
  LibraryIcon,
  LockIcon,
  RotateCwIcon,
  StarIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import {
  type BrowserLink,
  displayUrl,
  Favicon,
  hostOf,
} from "./v3-browser-bits";

/* The address row: back / forward / reload, the address, a star, and the
   Library. Back and forward walk the tabs you looked at, in order, since a
   tab has no page history of its own here. */

const ICON_BTN =
  "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4";

function Library({
  bookmarks,
  recent,
  onOpen,
  onRemove,
}: {
  bookmarks: BrowserLink[];
  recent: BrowserLink[];
  onOpen: (url: string) => void;
  onRemove: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const row = (l: BrowserLink, removable: boolean) => (
    <div key={l.url} className="group/row flex items-center">
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          onOpen(l.url);
        }}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-1.5 text-left hover:bg-[var(--v3-hover)]"
      >
        <Favicon url={l.url} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] text-foreground">
            {l.title}
          </span>
          <span className="block truncate text-[12px] text-muted-foreground/70">
            {hostOf(l.url)}
          </span>
        </span>
      </button>
      {removable && (
        <button
          type="button"
          aria-label={`Remove bookmark ${l.title}`}
          onClick={() => onRemove(l.url)}
          className="mr-2 grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-[var(--v3-hover)] hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
        >
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  );

  return (
    <span className="relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-[7px] px-2 text-[13px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground",
          open && "bg-[var(--v3-hover)] text-foreground",
        )}
      >
        <LibraryIcon className="size-4" />
        <span className="hidden @min-[640px]:inline">Library</span>
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close library"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div className="absolute top-full right-0 z-20 mt-1 max-h-[min(420px,70dvh)] w-[min(340px,calc(100vw-24px))] overflow-y-auto rounded-lg border border-[var(--v3-line)] bg-background py-1.5 text-[13.5px]">
            <p className="px-3 pt-1 pb-1 text-[12px] text-muted-foreground/70">
              Bookmarks
            </p>
            {bookmarks.length === 0 && (
              <p className="px-3 py-1.5 text-muted-foreground">
                None yet. Star a page to keep it here.
              </p>
            )}
            {bookmarks.map((l) => row(l, true))}
            {recent.length > 0 && (
              <>
                <p className="mt-1 border-[var(--v3-line)] border-t px-3 pt-2.5 pb-1 text-[12px] text-muted-foreground/70">
                  Recent
                </p>
                {recent.map((l) => row(l, false))}
              </>
            )}
          </div>
        </>
      )}
    </span>
  );
}

export function AddressBar({
  url,
  hasPage,
  starred,
  canBack,
  canForward,
  reloads,
  focusKey,
  bookmarks,
  recent,
  onBack,
  onForward,
  onReload,
  onToggleStar,
  onSubmit,
  onOpen,
  onRemoveBookmark,
}: {
  /** The shown tab's address; empty on a blank tab. */
  url: string;
  /** A real page is on show (so it can be reloaded or starred). */
  hasPage: boolean;
  starred: boolean;
  canBack: boolean;
  canForward: boolean;
  /** How many times reload was pressed; the icon spins once per press. */
  reloads: number;
  /** Bump to focus and select the address. */
  focusKey: number;
  bookmarks: BrowserLink[];
  recent: BrowserLink[];
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onToggleStar: () => void;
  /** Enter on typed text (an address or a search). */
  onSubmit: (text: string) => void;
  onOpen: (url: string) => void;
  onRemoveBookmark: (url: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  // null = not editing: the bar shows the page's own address.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = displayUrl(url);

  // Only a press of + / ⌘T / ⌘L moves the focus, never the first render.
  const seenKey = useRef(focusKey);
  useEffect(() => {
    if (seenKey.current === focusKey) return;
    seenKey.current = focusKey;
    input.current?.focus();
    input.current?.select();
  }, [focusKey]);

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-[var(--v3-line)] border-b px-2">
      <button
        type="button"
        aria-label="Back"
        title="Back"
        disabled={!canBack}
        onClick={onBack}
        className={ICON_BTN}
      >
        <ArrowLeftIcon />
      </button>
      <button
        type="button"
        aria-label="Forward"
        title="Forward"
        disabled={!canForward}
        onClick={onForward}
        className={ICON_BTN}
      >
        <ArrowRightIcon />
      </button>
      <button
        type="button"
        aria-label="Reload"
        title="Reload"
        disabled={!hasPage}
        onClick={onReload}
        className={ICON_BTN}
      >
        <RotateCwIcon
          // A new key restarts the one-turn spin on every press.
          key={reloads}
          className={cn(
            reloads > 0 &&
              "animate-[spin_0.5s_ease-out_1] motion-reduce:animate-none",
          )}
        />
      </button>
      <form
        className="mx-1 flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-lg bg-[var(--v3-hover)] pr-1 pl-2.5 focus-within:bg-background focus-within:shadow-[inset_0_0_0_1px_var(--foreground)]"
        onSubmit={(e) => {
          e.preventDefault();
          const text = (draft ?? shown).trim();
          if (!text) return;
          onSubmit(text);
          setDraft(null);
          input.current?.blur();
        }}
      >
        <LockIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground/70",
            !/^https:/i.test(url) && "opacity-0",
          )}
        />
        <input
          ref={input}
          value={draft ?? shown}
          placeholder="Search or type an address"
          aria-label="Address"
          spellCheck={false}
          autoComplete="off"
          onFocus={(e) => {
            setDraft(shown);
            e.currentTarget.select();
          }}
          onBlur={() => setDraft(null)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") e.currentTarget.blur();
          }}
          className="min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/70"
        />
        <button
          type="button"
          aria-label={starred ? "Remove bookmark" : "Bookmark this page"}
          aria-pressed={starred}
          title={starred ? "Remove bookmark" : "Bookmark this page"}
          disabled={!hasPage}
          // Keep the address focused (and its draft) while you star.
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggleStar}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
        >
          <StarIcon
            className={cn(
              "size-3.5",
              starred && "fill-current text-foreground",
            )}
          />
        </button>
      </form>
      <Library
        bookmarks={bookmarks}
        recent={recent}
        onOpen={onOpen}
        onRemove={onRemoveBookmark}
      />
    </div>
  );
}
