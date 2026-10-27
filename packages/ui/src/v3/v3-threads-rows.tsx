import { ChevronRightIcon, PinIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { ago } from "./v3-bits";
import { HelpersHint } from "./v3-helpers";
import { ThreadPill } from "./v3-live";
import { StatusDot } from "./v3-marks";
import {
  agentNameOf,
  boardStatus,
  listedAncestorOf,
  projectOf,
  snoozed,
  threadOf,
  threadProjectId,
} from "./v3-model";
import { RowButton, useOpenRoute } from "./v3-open-record";
import type { V3PageProps } from "./v3-page-types";
import { settledReason, snoozeBack } from "./v3-sections";
import { useRenameMenu } from "./v3-thread-menu";
import type { V3Thread } from "./v3-types";

/* The one thread row (#862 feedback): the Threads page's single list and
   Home's list both draw it — a status dot (a word-pill only for Needs you /
   Failed, the two a scan should catch), the title, `project · agent`, and
   the ⋯ menu (pin, done, snooze — #862, renamed in #887). The clock stays
   quiet until the row is hovered; a snoozed row says when it's back and a
   done row says why it parked. */

export function ThreadRow({
  data,
  t,
  go,
  act,
  settled,
  drop,
}: V3PageProps & {
  t: V3Thread;
  /** A shelf row: dimmed, and its menu leads with Not done. */
  settled?: boolean;
  /** Inside a group that already names it — the Agent grouping, Home's
      project groups — that half of `project · agent` is spared. */
  drop?: "project" | "agent";
}) {
  const { renameThread, archiveThread, pinThread, snoozeThread, wakeThread } =
    act;
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
        },
  });
  // An open helper marks its nearest listed ancestor's row (D-#847).
  const open = useOpenRoute();
  const board = boardStatus(data, t);
  const parent = t.parentId ? threadOf(data, t.parentId) : undefined;
  const project = threadProjectId(data, t);
  const projectName = project ? projectOf(data, project)?.name : undefined;
  const asleep = snoozed(t);
  const meta = [
    drop === "project" ? undefined : projectName,
    drop === "agent" ? undefined : agentNameOf(data, t.agentId),
  ]
    .filter(Boolean)
    .join(" · ");
  /* The hover clock is when the thread last moved: when it came back to
     you, else when it opened, else how long it's been going. */
  const back = t.cameBackAt ?? t.openedAt;
  const when =
    back !== undefined
      ? Math.max(0, Math.round((Date.now() - back) / 60_000))
      : t.minutes;
  return (
    // `data-settled` marks the shelf rows: a done thread leaves the list
    // for the Done fold and the marker says so (#862).
    <div data-thread-row={t.id} data-settled={settled || undefined}>
      <RowButton
        opens={{ page: "thread", id: t.id }}
        marked={
          open?.page === "thread" && listedAncestorOf(data, open.id) === t.id
        }
        onClick={() => go({ page: "thread", id: t.id })}
        className={cn(
          "group/thread flex min-h-[38px] items-center gap-2.5 border-[var(--v3-line)] border-b py-1 text-[13.5px]",
          settled && "text-muted-foreground",
        )}
      >
        <StatusDot status={board} />
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {t.pinnedAt !== undefined && (
            <PinIcon
              aria-label="Pinned"
              className="size-3 shrink-0 text-muted-foreground/70"
            />
          )}
          {t.unseen && (
            <span
              aria-hidden
              // Test hook: the row's unseen dot (#563) — the merged list
              // carries what the card board did (#862).
              data-thread-unseen
              className="inline-block size-[7px] shrink-0 rounded-full bg-sky-600 dark:bg-sky-400"
            />
          )}
          {input ?? (
            <span
              data-thread-title
              className={cn("truncate", !settled && "text-foreground")}
            >
              {t.title}
            </span>
          )}
          {/* The two statuses a scan should catch get words; the rest stay
              a dot (#862 feedback). */}
          {(board === "needs" || board === "failed") && (
            <ThreadPill status={board} />
          )}
          {parent && (
            <span
              className="shrink-0 truncate text-[12px] text-muted-foreground/60"
              title={`helper of ${parent.title}`}
            >
              ↩ {parent.title}
            </span>
          )}
          <HelpersHint data={data} thread={t} className="text-[12px]" />
        </span>
        {/* `project · agent` has no room in a phone-narrow pane — the dot,
            title and menu already say what the row is. */}
        {meta && (
          <span className="@min-[560px]:block hidden max-w-[38%] shrink truncate text-[12.5px] text-muted-foreground/70">
            {meta}
          </span>
        )}
        <span
          className="max-w-[45%] shrink-0 truncate text-right text-[12.5px] text-muted-foreground/70"
          title={
            settled
              ? settledReason(t)
              : asleep && t.snoozedUntil !== undefined
                ? snoozeBack(t.snoozedUntil)
                : undefined
          }
        >
          {settled ? (
            settledReason(t)
          ) : asleep && t.snoozedUntil !== undefined ? (
            snoozeBack(t.snoozedUntil)
          ) : (
            <span className="opacity-0 transition-opacity group-hover/thread:opacity-100">
              {ago(when)}
            </span>
          )}
        </span>
        <span className="flex shrink-0 justify-end">{menu}</span>
      </RowButton>
    </div>
  );
}

/** A fold in the thread list ("Working (3)", an agent's group): a shelf or
    group that opens on the chevron. Its open state comes from the device
    (useFoldPrefs), so the caller picks the key and the default. `marker`
    names it for tests ("settled", "agent:<id>"). */
export function Fold({
  title,
  count,
  open,
  onToggle,
  marker,
  children,
}: {
  title: ReactNode;
  count: number;
  open: boolean;
  onToggle: (open: boolean) => void;
  marker?: string;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="mt-6" {...(marker ? { "data-fold": marker } : {})}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
        className="flex items-center gap-1.5 text-[13.5px] text-muted-foreground hover:text-foreground"
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        {title} ({count})
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}
