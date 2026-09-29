import {
  AppWindowIcon,
  ClockIcon,
  GlobeIcon,
  LockIcon,
  SearchIcon,
  StarIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";
import type {
  BrowserBookmark,
  BrowserHistoryItem,
  BrowserTab,
} from "./browser-types";

const SEARCH = "https://www.google.com/search?q=";

/* What the address bar does with typed text: a URL-looking input opens that
   address (http for localhost), anything else searches. */
export function resolveInput(text: string): string {
  const t = text.trim();
  if (/^[a-z]+:\/\//i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (!/\s/.test(t) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t))
    return `https://${t}`;
  return SEARCH + encodeURIComponent(t);
}

/** The address as the bar shows it when not editing: no scheme, no slash. */
export function displayUrl(url: string): string {
  if (url.startsWith(SEARCH))
    return decodeURIComponent(url.slice(SEARCH.length).replace(/\+/g, " "));
  if (url.startsWith("lilos://newtab")) return "";
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function hostOf(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0] ?? url;
}

type Suggestion = {
  kind: "search" | "tab" | "bookmark" | "history" | "url";
  label: string;
  detail?: string;
  url: string;
  tabId?: string;
};

function suggest(
  q: string,
  tabs: BrowserTab[],
  bookmarks: BrowserBookmark[],
  history: BrowserHistoryItem[],
): Suggestion[] {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const hit = (title: string, url: string) =>
    title.toLowerCase().includes(s) || url.toLowerCase().includes(s);
  const target = resolveInput(q);
  const first: Suggestion = target.startsWith(SEARCH)
    ? { kind: "search", label: q.trim(), detail: "Search", url: target }
    : { kind: "url", label: displayUrl(target), url: target };
  const seen = new Set([first.url]);
  const out: Suggestion[] = [first];
  const add = (x: Suggestion) => {
    if (seen.has(x.url) || out.length >= 7) return;
    seen.add(x.url);
    out.push(x);
  };
  for (const t of tabs)
    if (hit(t.title, t.url))
      add({
        kind: "tab",
        label: t.title,
        detail: "Switch to this tab",
        url: t.url,
        tabId: t.id,
      });
  for (const b of bookmarks)
    if (hit(b.title, b.url))
      add({
        kind: "bookmark",
        label: b.title,
        detail: displayUrl(b.url),
        url: b.url,
      });
  for (const h of history)
    if (hit(h.title, h.url))
      add({
        kind: "history",
        label: h.title,
        detail: displayUrl(h.url),
        url: h.url,
      });
  return out;
}

const KIND_ICON = {
  search: SearchIcon,
  url: GlobeIcon,
  tab: AppWindowIcon,
  bookmark: StarIcon,
  history: ClockIcon,
} as const;

/* The address bar: shows the page's address, and while typing suggests
   matching open tabs, bookmarks and history (open tabs + bookmarks rank above
   history). Enter opens the highlighted suggestion. */
export function BrowserOmnibox({
  url,
  zoom,
  bookmarked,
  tabs,
  bookmarks,
  history,
  focusKey,
  onNavigate,
  onSwitchTab,
  onToggleBookmark,
  onResetZoom,
}: {
  url: string;
  zoom: number;
  bookmarked: boolean;
  tabs: BrowserTab[];
  bookmarks: BrowserBookmark[];
  history: BrowserHistoryItem[];
  /** Bump to focus + select the bar (⌘L, new tab). */
  focusKey?: number;
  onNavigate: (url: string) => void;
  onSwitchTab: (id: string) => void;
  onToggleBookmark?: () => void;
  onResetZoom?: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focusKey) return;
    input.current?.focus();
    input.current?.select();
  }, [focusKey]);
  const items = useMemo(
    () => (text === null ? [] : suggest(text, tabs, bookmarks, history)),
    [text, tabs, bookmarks, history],
  );
  const secure = url.startsWith("https://");
  const go = (s: Suggestion | undefined) => {
    if (!s) return;
    if (s.tabId) onSwitchTab(s.tabId);
    else onNavigate(s.url);
    setText(null);
    input.current?.blur();
  };

  return (
    <div className="relative min-w-0 flex-1">
      <div
        data-omnibox
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-full bg-muted px-3 text-[13px]",
          text !== null && "bg-background ring-2 ring-ring/40",
        )}
      >
        {text === null && secure ? (
          <LockIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <input
          ref={input}
          aria-label="Address and search bar"
          value={text ?? displayUrl(url)}
          placeholder="Search or type a URL"
          onFocus={(e) => {
            setText(displayUrl(url));
            setSel(0);
            e.currentTarget.select();
          }}
          onBlur={() => setTimeout(() => setText(null), 120)}
          onChange={(e) => {
            setText(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((i) => Math.min(i + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(
                items[sel] ??
                  (text
                    ? { kind: "url", label: text, url: resolveInput(text) }
                    : undefined),
              );
            } else if (e.key === "Escape") {
              setText(null);
              e.currentTarget.blur();
            }
          }}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        />
        {zoom !== 1 && text === null && (
          <button
            data-zoom-pill
            onClick={onResetZoom}
            title="Reset zoom"
            className="shrink-0 rounded-full bg-background px-1.5 text-[11px] text-muted-foreground tabular-nums hover:text-foreground"
          >
            {Math.round(zoom * 100)}%
          </button>
        )}
        {onToggleBookmark && text === null && (
          <button
            aria-label={bookmarked ? "Remove bookmark" : "Bookmark this page"}
            data-bookmark-star={bookmarked ? "on" : "off"}
            onClick={onToggleBookmark}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <StarIcon
              className={cn(
                "size-3.5",
                bookmarked && "fill-amber-400 text-amber-400",
              )}
            />
          </button>
        )}
      </div>
      {items.length > 0 && (
        <div
          data-omnibox-suggestions
          className="absolute inset-x-0 top-9 z-30 overflow-hidden rounded-xl border bg-popover py-1 text-[13px] shadow-lg"
        >
          {items.map((s, i) => {
            const Icon = KIND_ICON[s.kind];
            return (
              <button
                key={`${s.kind}:${s.url}`}
                data-suggestion={s.kind}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setSel(i)}
                onClick={() => go(s)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-1.5 text-left",
                  i === sel && "bg-accent",
                )}
              >
                <Icon
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground",
                    s.kind === "bookmark" && "text-amber-500",
                  )}
                />
                <span className="min-w-0 truncate">{s.label}</span>
                {s.detail && (
                  <span className="min-w-0 shrink truncate text-muted-foreground text-xs">
                    — {s.detail}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
