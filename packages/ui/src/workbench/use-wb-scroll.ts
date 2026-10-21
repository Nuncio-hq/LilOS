import { useLayoutEffect, useRef } from "react";
import { patchWbCache, type WbCacheEntry } from "../lib/wb-probe-cache";
import type { HostAccessors, WbTab } from "../types";

/* #547 AC-2: per-tab scroll offsets ride the folder's cache entry — put back
   in a layout effect (before paint) and re-applied while the tree window
   still grows, since rows mount under the scrollport. Returns the ref for the
   workbench's root, where the scrollports are looked up. */
export function useWbScroll({
  restored,
  shownTab,
  liveMode,
  host,
  liveCwd,
  win,
}: {
  restored: WbCacheEntry | undefined;
  shownTab: WbTab | undefined;
  liveMode: boolean;
  host?: HostAccessors;
  liveCwd?: string;
  /** The file tree's window: it grows as rows mount, so the offset is re-applied. */
  win: number;
}) {
  const scrollsRef = useRef<Partial<Record<WbTab, number>>>(
    restored?.scrolls ?? {},
  );
  const wbRootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!liveMode || !host || !liveCwd || !shownTab) return;
    const holder = wbRootRef.current?.querySelector(
      `[data-wb-scroll="${shownTab}"]`,
    );
    const vp = holder?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!vp) return;
    const saved = scrollsRef.current[shownTab];
    if (saved) vp.scrollTop = saved;
    const t = shownTab;
    const onScroll = () => {
      scrollsRef.current[t] = vp.scrollTop;
      patchWbCache(host, liveCwd, (e) => ({
        ...e,
        scrolls: { ...e.scrolls, [t]: vp.scrollTop },
      }));
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => vp.removeEventListener("scroll", onScroll);
  }, [shownTab, liveMode, liveCwd, host, win]);
  return wbRootRef;
}
