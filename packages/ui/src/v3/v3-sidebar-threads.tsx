import { ChevronRightIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { useTick } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import { useFoldPrefs } from "./v3-layout-prefs";
import type { V3Actions, V3Route } from "./v3-page-types";
import { sectionedThreads } from "./v3-sections";
import { ThreadRow } from "./v3-threads-rows";

/* The sidebar's own thread list, under the Threads entry (#862): the same
   sections the Threads page draws — Pinned, Active (what came back newest
   first), Working and the Snoozed / Settled shelves folded — in the same
   row, compacted. The folds are the device's own (localStorage), shared
   with the page's, so opening Working here opens it there too. Helpers
   stay hidden (D-#847): a parent waiting on them just reads Working. */

function SidebarFold({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
        className="flex h-[26px] w-full items-center gap-1 rounded-md pl-[18px] text-[12px] text-muted-foreground/70 hover:text-foreground"
      >
        <ChevronRightIcon
          className={cn("size-3 transition-transform", open && "rotate-90")}
        />
        {title} ({count})
      </button>
      {open && children}
    </div>
  );
}

/** The thread list under the sidebar's Threads entry. Empty shelves draw
    nothing; an all-empty list draws nothing at all. Rows carry
    `data-sidebar-row`, not `data-thread-row`: the page list's own marker
    stays unique to it — a sidebar row would double every row a test or a
    style asks for (#862). */
export function V3SidebarThreads({
  data,
  go,
  act,
}: {
  data: V3Data;
  go: (r: V3Route) => void;
  act: V3Actions;
}) {
  /* A wake time passing quietly returns its thread to Active; tick so the
     sidebar re-reads the clock without waiting for a touch. */
  useTick(30_000);
  const s = sectionedThreads(data);
  const { folds, setFold } = useFoldPrefs();
  const total =
    s.pinned.length +
    s.active.length +
    s.working.length +
    s.snoozed.length +
    s.settled.length;
  if (total === 0) return null;
  const row = (t: (typeof s.active)[number], settled?: boolean) => (
    <ThreadRow
      key={t.id}
      data={data}
      t={t}
      go={go}
      act={act}
      compact
      settled={settled}
      marker="data-sidebar-row"
    />
  );
  return (
    <div data-sidebar-threads className="pb-1">
      {s.pinned.length > 0 && (
        <>
          <div className="pt-1 pr-2 pl-[26px] text-[11px] font-medium text-muted-foreground/60">
            Pinned
          </div>
          {s.pinned.map((t) => row(t))}
        </>
      )}
      {s.active.map((t) => row(t))}
      <SidebarFold
        title="Working"
        count={s.working.length}
        open={folds.working === true}
        onToggle={(o) => setFold("working", o)}
      >
        {s.working.map((t) => row(t))}
      </SidebarFold>
      <SidebarFold
        title="Snoozed"
        count={s.snoozed.length}
        open={folds.snoozed === true}
        onToggle={(o) => setFold("snoozed", o)}
      >
        {s.snoozed.map((t) => row(t))}
      </SidebarFold>
      <SidebarFold
        title="Settled"
        count={s.settled.length}
        open={folds.settled === true}
        onToggle={(o) => setFold("settled", o)}
      >
        {s.settled.map((t) => row(t, true))}
      </SidebarFold>
    </div>
  );
}
