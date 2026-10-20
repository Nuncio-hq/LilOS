import {
  ArrowLeftIcon,
  ArrowRightIcon,
  LockIcon,
  RotateCwIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { displayUrl } from "./v3-browser-bits";

/* The session browser's address row: back / forward / reload and the address.
   Back and forward walk the tabs you looked at, in order, since a tab has no
   page history of its own here. */

const ICON_BTN =
  "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4";

export function AddressBar({
  url,
  hasPage,
  canBack,
  canForward,
  reloads,
  focusKey,
  onBack,
  onForward,
  onReload,
  onSubmit,
}: {
  /** The shown tab's address; empty on a blank tab. */
  url: string;
  /** A real page is on show (so it can be reloaded). */
  hasPage: boolean;
  canBack: boolean;
  canForward: boolean;
  /** How many times reload was pressed; the icon spins once per press. */
  reloads: number;
  /** Bump to focus and select the address. */
  focusKey: number;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  /** Enter on typed text (an address or a search). */
  onSubmit: (text: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  // null = not editing: the bar shows the page's own address.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = displayUrl(url);

  // Only a press of + moves the focus, never the first render.
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
        className="mx-1 flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-lg bg-[var(--v3-hover)] pr-2.5 pl-2.5 focus-within:bg-background focus-within:shadow-[inset_0_0_0_1px_var(--foreground)]"
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
      </form>
    </div>
  );
}
