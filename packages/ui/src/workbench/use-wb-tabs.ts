import { useEffect } from "react";
import type { WbProbeData } from "../lib/wb-probe-cache";
import type { WbTab } from "../types";
import { TAB_ORDER } from "./wb-tab-strip";

/* Which tabs the workbench shows, and which of them is showing. */

/* The tab that stands in when the caller's choice is not available: the
   first allowed one in this order. */
const FALLBACK: WbTab[] = [
  "changes",
  "files",
  "pr",
  "terminal",
  "preview",
  "browser",
  "subagents",
  "background",
  "plan",
];

export function useWbTabs({
  tab,
  liveMode,
  firstSettled,
  probe,
  folderless,
  isDM,
  hasSurfaces,
  hasBrowser,
  hasEmp,
  canStopJobs,
  caps,
  jobs,
  helpers,
  plans,
  onAllowed,
}: {
  tab: WbTab;
  liveMode: boolean;
  firstSettled: boolean;
  probe: WbProbeData | null;
  folderless: boolean;
  isDM: boolean;
  /** Live harness surfaces are wired (a real host exists even without `work`). */
  hasSurfaces: boolean;
  hasBrowser: boolean;
  hasEmp: boolean;
  canStopJobs: boolean;
  caps?: { plan?: boolean; subagents?: boolean; background?: boolean };
  /** How many of each the thread carries. */
  jobs: number;
  helpers: number;
  plans: number;
  onAllowed?: (tabs: WbTab[] | null) => void;
}): { allowed: Record<WbTab, boolean>; shownTab: WbTab | undefined } {
  /* Tabs render only when their host method answered (#114 AC-6) — and the
     folder-bound ones only when the session has a folder (#543). Terminal /
     Preview are surface-bound, not folder-bound: they render wherever live
     surfaces (or the LilOS Browser) are wired (slice B, #119) — a live
     attach means a real host exists even when `work` doesn't.
     #587 AC-1 — the strip is a FIXED membership: the engine-owned tabs
     (Plan/Background/Subagents) gate on their declared capability (the
     caller's `caps`), never on content arriving; a capable-but-empty tab
     renders greyed (data-wb-empty) instead of popping in mid-session.
     Content still forces a tab on (a job/plan/helper that arrived on an
     engine which never declared it is shown rather than lost), and the
     folder tabs keep their answered-probe / has-folder gating. */
  const surfacesOn = hasSurfaces || (!liveMode && !folderless);
  const allowed: Record<WbTab, boolean> = {
    changes: liveMode ? probe?.diffs != null : !folderless,
    files: liveMode ? probe?.files != null : !folderless,
    terminal: surfacesOn,
    preview: surfacesOn,
    /* The thread's own browser sits on its own tab (next to Preview), not in
       place of it — the dev-server preview stays reachable on desktop. */
    browser: hasBrowser,
    background:
      (caps ? !!caps.background : !folderless || hasEmp || canStopJobs) ||
      jobs > 0,
    /* A `?tab=subagents` deep link lands on the tab's empty state on a
       capable session (#319) — covered by the capability flag itself. */
    subagents: (caps ? !!caps.subagents : hasEmp) || helpers > 0,
    plan: (caps ? !!caps.plan : isDM && hasEmp) || plans > 0,
    pr: liveMode ? probe?.pr != null : !folderless,
    /* Details reads only what the thread carries, so it is always there —
       but it never counts as "something to show": the toggle and the
       "nothing to show" line gate on the tabs above (D-#19, #543 AC-5). */
    details: true,
  };
  /* Reports the settled tab set so the caller can hide the toggle when
     there's nothing to show (D-#19, #543 AC-5); null = still probing —
     the first full read round hasn't landed (a cache hit counts). */
  const probing = liveMode && !firstSettled;
  const allowedKey = TAB_ORDER.filter(
    (t) => t !== "details" && allowed[t],
  ).join(",");
  useEffect(() => {
    onAllowed?.(
      probing ? null : (allowedKey.split(",").filter(Boolean) as WbTab[]),
    );
  }, [allowedKey, probing, onAllowed]);
  /* The caller's tab choice yields to availability: when its method never
     answers the first allowed tab shows instead. */
  const shownTab = allowed[tab] ? tab : FALLBACK.find((t) => allowed[t]);
  return { allowed, shownTab };
}
