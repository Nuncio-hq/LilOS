import { useEffect } from "react";
import type { Diff, HostAccessors, WbSpot, WbTab } from "../types";
import type { WbProbe } from "./use-wb-probe";

/* #340 AC-2b: the session's `workbench_open` — open the panel on the target's
   tab. A changed file shows its diff; an unchanged one opens the file view
   (at `line` when given). The URL's navigation is the caller's (its Browser
   surface) — here it only lands on the preview tab. Keyed on `at` so a
   repeated open of the same target re-fires. */
export function useWbSpot({
  spot,
  changed,
  host,
  liveCwd,
  setSel,
  setTab,
  setViewFile,
}: {
  spot?: WbSpot;
  changed: Map<string, Diff>;
  host?: HostAccessors;
  liveCwd?: string;
  setSel: WbProbe["setSel"];
  setTab: (t: WbTab) => void;
  setViewFile: WbProbe["setViewFile"];
}) {
  const spotAt = spot?.at;
  useEffect(() => {
    if (!spot) return;
    const t = spot.target;
    if (t.tab !== undefined) {
      /* An engine tab (#543) — Subagents/Background/Plan exist with or
         without a folder. */
      setTab(t.tab);
      return;
    }
    if (t.file !== undefined) {
      const file = t.file;
      if (changed.has(file)) {
        setSel(file);
        setTab("changes");
        return;
      }
      setTab("files");
      if (host && liveCwd)
        void host
          .read(liveCwd, file)
          .then((r) => r && setViewFile({ path: file, ...r, line: t.line }));
      return;
    }
    if (t.diff === true) {
      setSel(t.path ?? null);
      setTab("changes");
      return;
    }
    setTab(t.pr === true ? "pr" : "preview");
  }, [spotAt]); // eslint-disable-line react-hooks/exhaustive-deps
}
