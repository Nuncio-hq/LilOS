import { PanelLeftIcon, SearchIcon } from "lucide-react";
import { cn } from "../lib/utils";

const iconBtn =
  "grid size-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground [&_svg]:size-4";

/* The strip above the page. It says nothing the page or the sidebar already
   says: the page names itself in its own heading, Search and the company live
   in the sidebar. So while the sidebar is docked the strip is empty, and only
   while the sidebar is hidden does it carry what the sidebar did — its toggle,
   Search and the company. The Mac app has no title bar (D-#232): the strip
   drags the window, and while the sidebar is hidden it leaves room for the
   traffic lights (apps/web/src/index.css, keyed on data-sidebar-hidden). */
export function V3TopBar({
  company,
  hidden,
  onHome,
  onShowSidebar,
  onSearch,
}: {
  company: string;
  /** The sidebar is hidden: the bar carries its toggle, Search and the company. */
  hidden: boolean;
  onHome: () => void;
  onShowSidebar: () => void;
  onSearch: () => void;
}) {
  return (
    <div
      data-v3-topbar
      data-sidebar-hidden={hidden || undefined}
      className={cn(
        "lilos-drag lilos-v3-bar flex h-[46px] shrink-0 items-center gap-1 pr-3.5 text-[14px] text-muted-foreground",
        hidden ? "pl-3" : "pl-5",
      )}
    >
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
        </>
      )}
    </div>
  );
}
