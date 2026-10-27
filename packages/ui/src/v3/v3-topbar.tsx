import { PanelLeftIcon, SearchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/** Where the sidebar is: docked beside the page, hidden (out of the way,
    unreachable), or popped out over the page from its hidden state. */
export type SidebarMode = "docked" | "hidden" | "popped";

/* D-#232, #797: the window has ONE toolbar row, `--v3-toolbar-h` tall (52px
   on the Mac, where the traffic lights are centred in it; compact in a
   browser). It is not an element of its own but the first row of each
   column — the sidebar's, the page's, the side peek's — so a column's items
   live in the column they belong to and the peek can still be one `<aside>`.
   Every segment is `data-toolbar` and drags the window like a title bar; the
   segment at the window's left edge is `data-toolbar-lead` and leaves room
   for the lights (apps/web/src/index.css). Nothing else sits in the row: the
   page names itself, and Search is the sidebar's row. */

/** A toolbar button: a quiet 28px square with a 16px glyph, no border; the
    hover fill is the only affordance, as in a native toolbar. */
export const toolbarBtn =
  "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground [&_svg]:size-4";

const TOGGLE: Record<SidebarMode, string> = {
  docked: "Hide sidebar",
  hidden: "Show sidebar",
  popped: "Keep sidebar open",
};

/** The sidebar toggle — the standard sidebar glyph, right after the traffic
    lights whether the sidebar is shown (it is the sidebar segment's item),
    hidden (the first item of the leftmost segment), or floating over the page. */
export function SidebarToggle({
  mode,
  onToggle,
  overlayOnly,
}: {
  mode: SidebarMode;
  onToggle: () => void;
  /** Narrow window (#886): popped it is an overlay to close, never one to
      "keep open" — it cannot dock. */
  overlayOnly?: boolean;
}) {
  const label =
    overlayOnly && mode === "popped" ? "Close sidebar" : TOGGLE[mode];
  return (
    <button
      type="button"
      onClick={onToggle}
      title={`${label} (⌘\\)`}
      aria-label={label}
      className={toolbarBtn}
    >
      <PanelLeftIcon />
    </button>
  );
}

/** What the hidden sidebar leaves in the toolbar: its toggle, then Search (the
    one Search the screen shows — docked, it is the sidebar's row). It leads
    the leftmost segment: the page's, or the side peek's once that covers the
    page. */
export function SidebarShortcuts({
  onShow,
  onSearch,
}: {
  onShow: () => void;
  onSearch: () => void;
}) {
  return (
    <div data-sidebar-shortcuts className="flex items-center gap-1">
      <SidebarToggle mode="hidden" onToggle={onShow} />
      <button
        type="button"
        onClick={onSearch}
        className={toolbarBtn}
        title="Search (⌘K)"
        aria-label="Search"
      >
        <SearchIcon />
      </button>
    </div>
  );
}

/** The page column's toolbar segment: empty drag space — the company is the
    sidebar's section label, the page names itself — except, while the sidebar
    is hidden and nothing covers the page, the sidebar's shortcuts (`lead`). */
export function V3TopBar({ lead }: { lead?: ReactNode }) {
  return (
    <div
      data-v3-topbar
      data-toolbar
      data-toolbar-lead={lead ? "" : undefined}
      className={cn(
        "lilos-drag col-start-1 row-start-1 flex items-center gap-1 pr-3.5",
        lead ? "pl-3.5" : "pl-5",
      )}
    >
      {lead}
    </div>
  );
}
