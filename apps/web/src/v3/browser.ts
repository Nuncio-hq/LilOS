import type { DesktopBrowserState } from "@lilos/contracts/app";
import type { V3BrowserTab } from "@lilos/ui";
import { atom } from "nanostores";

/* The LilOS Browser's tabs as v3 reads them. The desktop host owns the real
   pages and pushes a full snapshot; this mirrors it into a store. Without the
   bridge (plain web, D-#19) the list stays empty and the browser actions are
   absent. A tab a thread owns shows under that thread's employee; the page
   itself is a native view the host paints, so `page` is left out. */

export const browserTabs = atom<V3BrowserTab[]>([]);

const tabsOf = (s: DesktopBrowserState): V3BrowserTab[] =>
  s.tabs.map((t) => ({
    id: t.id,
    title: t.title || t.url,
    url: t.url,
    by: t.group?.employeeId ?? "you",
    ...(t.group ? { threadId: t.group.threadId } : {}),
  }));

/** Start mirroring the host's snapshots; returns the unsubscribe. */
export function watchBrowserTabs(): () => void {
  const bridge = window.lilos?.browser;
  if (!bridge || bridge.isBrowserWindow) return () => {};
  void bridge.command({ op: "getState" }).then((s) => {
    if (s) browserTabs.set(tabsOf(s));
  });
  return bridge.onState((s) => browserTabs.set(tabsOf(s)));
}
