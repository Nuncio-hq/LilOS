import { ChevronLeftIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useUiLayerEl } from "../chat/ui-layers";
import { cn } from "../lib/utils";

/* A panel that slides in from the right over whatever you were looking at:
   the page underneath never changes, Esc or the backdrop slides it away.
   `onBack` adds a back chevron for a page pushed inside the sheet. */
export function V2Sheet({
  title,
  icon,
  count,
  actions,
  onClose,
  onBack,
  width = "w-[min(560px,100vw)]",
  inset,
  fill,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  count?: number;
  actions?: React.ReactNode;
  onClose: () => void;
  onBack?: () => void;
  width?: string;
  /** Keeps a docked panel on the right uncovered (e.g. the CEO chat):
      classes that pull the sheet's right edge in. */
  inset?: string;
  /** The body manages its own scrolling (e.g. a pinned chat at the bottom). */
  fill?: boolean;
  children: React.ReactNode;
}) {
  const [closing, setClosing] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const close = () => {
    if (closing) return;
    setClosing(true);
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    timer.current = window.setTimeout(onClose, reduce ? 0 : 190);
  };
  const layerRef = useUiLayerEl<HTMLDivElement>({
    onEscape: onBack ?? close,
  });
  return (
    <div className={cn("fixed inset-0 z-30", inset)}>
      <div
        aria-hidden
        onClick={close}
        className={cn(
          "lilos-v2-dim absolute inset-0 bg-black/15 transition-opacity duration-200 dark:bg-black/35",
          closing && "opacity-0",
        )}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={layerRef}
        data-closing={closing || undefined}
        className={cn(
          "lilos-v2-sheet absolute inset-y-0 right-0 flex flex-col bg-[var(--v2-main)] shadow-[-16px_0_48px_-24px_rgb(0_0_0/0.35)] ring-1 ring-foreground/[0.08] lg:inset-y-2 lg:right-2 lg:rounded-[14px]",
          width,
        )}
      >
        <header className="flex h-[52px] shrink-0 items-center gap-2 px-3">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back"
              className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <ChevronLeftIcon className="size-4" />
            </button>
          ) : (
            icon && (
              <span className="grid size-8 place-items-center text-muted-foreground [&_svg]:size-4">
                {icon}
              </span>
            )
          )}
          <h2 className="min-w-0 truncate font-semibold text-[14px]">
            {title}
          </h2>
          {count !== undefined && (
            <span className="text-[12px] text-muted-foreground tabular-nums">
              {count}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            {actions}
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              title="Close  Esc"
              className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <XIcon className="size-4" />
            </button>
          </span>
        </header>
        <div
          className={cn(
            "min-h-0 flex-1",
            fill ? "flex flex-col overflow-hidden" : "overflow-y-auto",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
