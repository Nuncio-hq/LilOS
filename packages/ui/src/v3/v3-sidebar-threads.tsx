import { ChevronRightIcon, PinIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { useTick } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import { useFoldPrefs } from "./v3-layout-prefs";
import { StatusDot } from "./v3-marks";
import { boardStatus, listedAncestorOf, snoozed } from "./v3-model";
import { RowButton, useOpenRoute } from "./v3-open-record";
import type { V3Actions, V3Route } from "./v3-page-types";
import { sectionedThreads, settledReason, snoozeBack } from "./v3-sections";
import { useRenameMenu } from "./v3-thread-menu";
import type { V3Thread } from "./v3-types";

/* The sidebar's own thread list, under the Threads entry (#862): the same
   sections the Threads page draws — Pinned, Active (what came back newest
   first), Working and the Snoozed / Settled shelves folded — in compact
   rows. The folds are the device's own (localStorage), shared with the
   page's, so opening Working here opens it there too. Helpers stay hidden
   (D-#847): a parent waiting on them just reads Working. */

function SidebarRow({
  data,
  t,
  go,
  act,
  dim,
}: {
  data: V3Data;
  t: V3Thread;
  go: (r: V3Route) => void;
  act: V3Actions;
  /** On a shelf: parked threads draw quieter. */
  dim?: boolean;
}) {
  const {
    renameThread,
    archiveThread,
    pinThread,
    snoozeThread,
    wakeThread,
    setAutoSettle,
  } = act;
  const settled = dim === true;
  const { input, menu } = useRenameMenu({
    title: t.title,
    archived: settled,
    quiet: true,
    onRename: renameThread && ((title) => renameThread(t.id, title)),
    onArchive: archiveThread && ((to) => archiveThread(t.id, to)),
    park: settled
      ? undefined
      : {
          pinned: t.pinnedAt !== undefined,
          onPin: pinThread && ((to) => pinThread(t.id, to)),
          snoozedUntil: snoozed(t) ? t.snoozedUntil : undefined,
          onSnooze: snoozeThread && ((until) => snoozeThread(t.id, until)),
          onWake: wakeThread && (() => wakeThread(t.id)),
          autoSettle: !t.autoSettleOff,
          onAutoSettle: setAutoSettle && ((on) => setAutoSettle(t.id, on)),
        },
  });
  // An open helper marks its nearest listed ancestor's row (D-#847).
  const open = useOpenRoute();
  const asleep = snoozed(t);
  return (
    // `data-sidebar-row`, not `data-thread-row`: the main list's own marker
    // stays unique to it — a sidebar row would double every row a test or a
    // style asks for (#862).
    <div data-sidebar-row={t.id}>
      <RowButton
        opens={{ page: "thread", id: t.id }}
        marked={
          open?.page === "thread" && listedAncestorOf(data, open.id) === t.id
        }
        onClick={() => go({ page: "thread", id: t.id })}
        className="group/thread flex min-h-[28px] items-center gap-2 rounded-md pr-2 pl-[18px] text-[13px]"
      >
        <StatusDot status={boardStatus(data, t)} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            dim ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {t.pinnedAt !== undefined && (
            <PinIcon className="mr-1 inline size-3 align-[-1.5px] text-muted-foreground/70" />
          )}
          {input ?? t.title}
        </span>
        {asleep && t.snoozedUntil !== undefined && (
          <span className="shrink-0 text-[11px] text-muted-foreground/70">
            {snoozeBack(t.snoozedUntil)}
          </span>
        )}
        {settled && (
          <span
            className="max-w-[84px] shrink-0 truncate text-[11px] text-muted-foreground/70"
            title={settledReason(t)}
          >
            {settledReason(t)}
          </span>
        )}
        {menu}
      </RowButton>
    </div>
  );
}

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
    nothing; an all-empty list draws nothing at all. */
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
  return (
    <div data-sidebar-threads className="pb-1">
      {s.pinned.length > 0 && (
        <>
          <div className="pt-1 pr-2 pl-[26px] text-[11px] font-medium text-muted-foreground/60">
            Pinned
          </div>
          {s.pinned.map((t) => (
            <SidebarRow key={t.id} data={data} t={t} go={go} act={act} />
          ))}
        </>
      )}
      {s.active.map((t) => (
        <SidebarRow key={t.id} data={data} t={t} go={go} act={act} />
      ))}
      <SidebarFold
        title="Working"
        count={s.working.length}
        open={folds.working === true}
        onToggle={(o) => setFold("working", o)}
      >
        {s.working.map((t) => (
          <SidebarRow key={t.id} data={data} t={t} go={go} act={act} />
        ))}
      </SidebarFold>
      <SidebarFold
        title="Snoozed"
        count={s.snoozed.length}
        open={folds.snoozed === true}
        onToggle={(o) => setFold("snoozed", o)}
      >
        {s.snoozed.map((t) => (
          <SidebarRow key={t.id} data={data} t={t} go={go} act={act} />
        ))}
      </SidebarFold>
      <SidebarFold
        title="Settled"
        count={s.settled.length}
        open={folds.settled === true}
        onToggle={(o) => setFold("settled", o)}
      >
        {s.settled.map((t) => (
          <SidebarRow key={t.id} data={data} t={t} go={go} act={act} dim />
        ))}
      </SidebarFold>
    </div>
  );
}
