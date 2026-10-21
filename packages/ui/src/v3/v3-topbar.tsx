import { PanelLeftIcon, SearchIcon, SparklesIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { Kbd } from "./v3-bits";

const iconBtn =
  "grid size-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground [&_svg]:size-4";

/* The bar above the page. It says where you are (the page, and the company
   only while the sidebar that already names it is hidden) and nothing the
   sidebar says: Search lives in the sidebar, so the bar offers a Search icon
   only while the sidebar is away. The Mac app has no title bar (D-#232): the
   bar drags the window, and while the sidebar is hidden it leaves room for the
   traffic lights (apps/web/src/index.css, keyed on data-sidebar-hidden). */
export function V3TopBar({
  company,
  pageName,
  hidden,
  askCeo,
  onHome,
  onShowSidebar,
  onSearch,
}: {
  company: string;
  pageName: string;
  /** The sidebar is hidden: the bar carries its toggle, Search and the company. */
  hidden: boolean;
  /** The app has a CEO to ask: its entry is a different action from Search. */
  askCeo: boolean;
  onHome: () => void;
  onShowSidebar: () => void;
  onSearch: () => void;
}) {
  return (
    <div
      data-v3-topbar
      data-sidebar-hidden={hidden || undefined}
      className={cn(
        "lilos-drag lilos-v3-bar flex h-[46px] shrink-0 items-center justify-between gap-4 pr-3.5 text-[14px] text-muted-foreground",
        hidden ? "pl-3" : "pl-5",
      )}
    >
      <div className="flex min-w-0 items-center gap-1 truncate">
        {hidden && (
          <>
            <button
              type="button"
              onClick={onShowSidebar}
              className={iconBtn}
              title="Show sidebar (⌘\\)"
              aria-label="Show sidebar"
            >
              <PanelLeftIcon />
            </button>
            <button
              type="button"
              onClick={onSearch}
              className={iconBtn}
              title="Search (⌘K)"
              aria-label="Search"
            >
              <SearchIcon />
            </button>
            <button
              type="button"
              onClick={onHome}
              className="ml-1.5 truncate hover:text-foreground"
            >
              {company}
            </button>
            <span className="mx-1.5 text-muted-foreground/60">/</span>
          </>
        )}
        <span className="truncate font-medium text-foreground">{pageName}</span>
      </div>
      {askCeo && (
        <button
          type="button"
          onClick={onSearch}
          className="flex h-[30px] w-[280px] items-center gap-2 rounded-lg bg-[var(--v3-hover)] pr-1.5 pl-2.5 text-[13px] text-muted-foreground/80 hover:text-foreground"
        >
          <SparklesIcon className="size-4" />
          Ask the CEO anything…
          <Kbd className="ml-auto">⌘K</Kbd>
        </button>
      )}
    </div>
  );
}
