import type { WbTab } from "@lilos/ui/types";

/* #319 AC-2: the Focus URL carries the Workbench tab — `?tab=subagents`
   from a thread panel's "Open" link, then the user's own picks replace it
   so a reload always lands on the tab they left. Anything that isn't a real
   tab is dropped on the floor. */

const WB_TABS: readonly string[] = [
  "changes",
  "files",
  "terminal",
  "preview",
  "background",
  "subagents",
  "plan",
  "pr",
];

/** The focus route's `?tab=` value, or undefined when it isn't a WbTab. */
export function parseFocusTab(search: { tab?: unknown }): WbTab | undefined {
  return typeof search.tab === "string" && WB_TABS.includes(search.tab)
    ? (search.tab as WbTab)
    : undefined;
}
