import { Command as CommandPrimitive } from "cmdk";
import {
  ArchiveIcon,
  FolderIcon,
  MessageSquareIcon,
  SearchIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useUiLayerEl } from "../chat/ui-layers";
import {
  type SwitcherItem,
  type SwitcherKind,
  searchSwitcher,
} from "../lib/switcher";
import { cn } from "../lib/utils";
import { HermesAvatar } from "./avatars";

/* ⌘K quick switcher: one box that jumps anywhere — employees, sessions
   (title + first message) and folders. cmdk owns the input focus, arrow
   nav and the highlighted row; searchSwitcher owns matching + grouping,
   so the same ranked rows render in the prototype, the app and tests. */

const HEADING: Record<SwitcherKind, string> = {
  employee: "Employees",
  session: "Sessions",
  folder: "Folders",
};

function Row({
  item,
  onPick,
}: {
  item: SwitcherItem;
  onPick: (item: SwitcherItem) => void;
}) {
  return (
    <CommandPrimitive.Item
      /* cmdk selects on click/Enter by value — the key is just a lookup. */
      value={`${item.kind}:${item.id}`}
      onSelect={() => onPick(item)}
      data-switcher-item={item.id}
      data-switcher-kind={item.kind}
      className={cn(
        "flex cursor-default items-center gap-2.5 rounded-lg px-2 py-2 text-sm outline-none select-none data-[selected=true]:bg-accent",
        item.archived && "opacity-60",
      )}
    >
      {item.kind === "employee" ? (
        <HermesAvatar name={item.title} className="size-5" />
      ) : item.kind === "folder" ? (
        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{item.title}</span>
        {item.subtitle && (
          <span className="block truncate text-muted-foreground text-xs">
            {item.subtitle}
          </span>
        )}
      </span>
      {item.archived && (
        <ArchiveIcon className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      {item.needsYou && (
        <span
          data-badge-needsyou
          title="Waiting on your approval"
          className="grid size-[18px] shrink-0 place-items-center rounded-full bg-primary font-bold text-[11px] text-primary-foreground"
        >
          !
        </span>
      )}
      {item.running && (
        <span
          data-badge-running
          title="Running"
          className="size-2 shrink-0 rounded-full bg-[#007aff] dark:bg-[#0a84ff]"
        />
      )}
    </CommandPrimitive.Item>
  );
}

export function QuickSwitcher({
  items,
  onPick,
  onClose,
}: {
  /** Employees, sessions and folders, pre-built by the host — employees in
      sidebar order, sessions newest first, folders in recents order. */
  items: SwitcherItem[];
  onPick: (item: SwitcherItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  /* Filter in the search helper, not cmdk (shouldFilter=false): one ranked
     list feeds both the view and the perf test. */
  const results = useMemo(() => searchSwitcher(items, query), [items, query]);
  /* Esc reaches this dialog wherever focus sits — the layer stack gives it
     to the top-most surface only. */
  const layerRef = useUiLayerEl<HTMLDivElement>({ onEscape: onClose });
  return (
    <div
      className="fixed inset-0 z-40 bg-black/30 pt-[14vh]"
      onClick={onClose}
      data-quick-switcher
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Quick switcher"
        ref={layerRef}
        className="mx-auto w-full max-w-lg overflow-hidden rounded-2xl border bg-popover shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <CommandPrimitive shouldFilter={false} loop>
          <div className="flex items-center gap-2 border-b px-3">
            <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
            <CommandPrimitive.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Jump to an employee, session or folder…"
              aria-label="Search employees, sessions and folders"
              className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <CommandPrimitive.List className="max-h-[50vh] overflow-y-auto p-1.5">
            <CommandPrimitive.Empty className="py-8 text-center text-muted-foreground text-sm">
              Nothing matches “{query}”
            </CommandPrimitive.Empty>
            {results.map((item, i) => (
              <div key={`${item.kind}:${item.id}`}>
                {(i === 0 || results[i - 1].kind !== item.kind) && (
                  <div className="px-2 pt-1.5 pb-0.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                    {HEADING[item.kind]}
                  </div>
                )}
                <Row item={item} onPick={onPick} />
              </div>
            ))}
          </CommandPrimitive.List>
          <div className="flex items-center gap-3 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
            <span>↑↓ choose</span>
            <span>↵ open</span>
            <span>esc close</span>
          </div>
        </CommandPrimitive>
      </div>
    </div>
  );
}
