import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../lib/utils";
import { Meter, span, TicketId } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import { HelpersHint } from "./v3-helpers";
import { ThreadPill } from "./v3-live";
import {
  agentOf,
  boardStatus,
  listedAncestorOf,
  threadOf,
  threadTag,
} from "./v3-model";
import { RowButton, useOpenRoute } from "./v3-open-record";
import type { V3PageProps } from "./v3-page-types";
import { AgentName } from "./v3-rows";
import { useRenameMenu } from "./v3-thread-menu";
import type { V3Thread } from "./v3-types";

/* The rows of Threads' lists. Each carries the thread's quiet ⋯ menu (rename
   in place, archive) where the app can do those, and opens the thread on a
   click. The grids answer to the page's own width (it is a container: a
   thread open beside it takes more than half of it), never the window's, and
   every title column has a floor: a title truncates, it does not vanish. */

type Row = V3PageProps & { t: V3Thread; archived?: boolean };

/** The title with its tag (ticket or project); the input while it is being
    renamed. */
function RowTitle({
  data,
  t,
  editing,
}: {
  data: V3Data;
  t: V3Thread;
  editing: ReactNode | undefined;
}) {
  const parent = t.parentId ? threadOf(data, t.parentId) : undefined;
  return (
    <span className="flex min-w-0 items-center">
      <TicketId id={threadTag(data, t)} className="shrink-0" />
      {editing ?? <span className="truncate">{t.title}</span>}
      {parent && (
        <span
          className="ml-1.5 shrink-0 truncate text-[12px] text-muted-foreground/60"
          title={`helper of ${parent.title}`}
        >
          ↩ {parent.title}
        </span>
      )}
      <HelpersHint data={data} thread={t} className="ml-1.5 text-[12px]" />
    </span>
  );
}

/** One row: the thread's title (renameable), then `children` (its cells),
    then the menu. `grid` names the columns. */
function ThreadRow({
  data,
  t,
  go,
  act,
  archived,
  grid,
  className,
  children,
}: Row & { grid: string; className?: string; children: ReactNode }) {
  const { renameThread, archiveThread } = act;
  const { input, menu } = useRenameMenu({
    title: t.title,
    archived,
    quiet: true,
    onRename: renameThread && ((title) => renameThread(t.id, title)),
    onArchive: archiveThread && ((to) => archiveThread(t.id, to)),
  });
  // An open helper marks its nearest listed ancestor's row (D-#847).
  const open = useOpenRoute();
  return (
    // `data-thread-row`, not `data-thread`: that one marks the open thread's
    // transcript, and the list sits under the peek on the same page.
    <div data-thread-row={t.id} data-archived={archived || undefined}>
      <RowButton
        opens={{ page: "thread", id: t.id }}
        marked={
          open?.page === "thread" && listedAncestorOf(data, open.id) === t.id
        }
        onClick={() => go({ page: "thread", id: t.id })}
        className={cn(
          "group/thread grid items-center border-[var(--v3-line)] border-b py-2.5",
          grid,
          archived && "text-muted-foreground",
          className,
        )}
      >
        <RowTitle data={data} t={t} editing={input} />
        {children}
        <span className="flex justify-end">{menu}</span>
      </RowButton>
    </div>
  );
}

/* Live → Earlier today: title, who, what it did, how long. The summary only
   when there is room. */
const RECENT =
  "grid-cols-[minmax(96px,2fr)_minmax(0,1fr)_58px_24px] gap-3 @min-[760px]:grid-cols-[minmax(0,1fr)_150px_minmax(0,170px)_70px_24px] @min-[760px]:gap-4";

export function RecentRow(p: Row) {
  const { t, data } = p;
  return (
    <ThreadRow {...p} grid={RECENT} className="text-[13.5px]">
      <AgentName data={data} agent={agentOf(data, t.agentId)} />
      <span className="hidden truncate text-muted-foreground @min-[760px]:block">
        {t.summary}
      </span>
      <span className="text-right text-muted-foreground">
        {span(t.minutes)}
      </span>
    </ThreadRow>
  );
}

/* All: title, who, status; when started and how long once there is room, and
   the context column only where some thread reports one. */
export const ALL_GRID = {
  plain:
    "grid-cols-[minmax(96px,2fr)_minmax(0,1fr)_auto_24px] gap-3 @min-[700px]:grid-cols-[minmax(0,1fr)_150px_100px_70px_70px_24px] @min-[700px]:gap-4",
  context:
    "grid-cols-[minmax(96px,2fr)_minmax(0,1fr)_auto_24px] gap-3 @min-[700px]:grid-cols-[minmax(0,1fr)_150px_100px_70px_70px_100px_24px] @min-[700px]:gap-4",
};

export function AllRow(p: Row & { hasContext: boolean }) {
  const { t, data, hasContext } = p;
  return (
    <ThreadRow {...p} grid={hasContext ? ALL_GRID.context : ALL_GRID.plain}>
      <AgentName data={data} agent={agentOf(data, t.agentId)} />
      <span>
        <ThreadPill status={boardStatus(data, t)} />
      </span>
      <span className="hidden text-muted-foreground @min-[700px]:block">
        {t.startedAt}
      </span>
      <span className="hidden text-muted-foreground @min-[700px]:block">
        {span(t.minutes)}
      </span>
      {hasContext && (
        <span className="hidden items-center gap-2 text-muted-foreground @min-[700px]:flex">
          {t.context !== undefined && (
            <>
              <Meter value={t.context} className="w-10" />
              {t.context}%
            </>
          )}
        </span>
      )}
    </ThreadRow>
  );
}

/** By agent: the agent is the heading, so the row is title, status, time. */
export function AgentThreadRow(p: Row) {
  const { t, data } = p;
  return (
    <ThreadRow
      {...p}
      grid="grid-cols-[minmax(96px,1fr)_auto_58px_24px] gap-3 @min-[700px]:grid-cols-[minmax(0,1fr)_auto_48px_80px_24px] @min-[700px]:gap-4"
      className="py-2 text-[13.5px]"
    >
      <ThreadPill status={boardStatus(data, t)} />
      <span className="text-right text-muted-foreground">
        {span(t.minutes)}
      </span>
      <span className="hidden text-right text-muted-foreground/70 @min-[700px]:block">
        {t.startedAt}
      </span>
    </ThreadRow>
  );
}

/** Threads put away, folded under the list ("Archived (3)"); a row opens its
    thread and its menu brings it back. Nothing is drawn with none. */
export function Archived({
  threads,
  hasContext,
  ...p
}: V3PageProps & { threads: V3Thread[]; hasContext: boolean }) {
  const [open, setOpen] = useState(false);
  if (threads.length === 0) return null;
  return (
    <div className="mt-6">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[13.5px] text-muted-foreground hover:text-foreground"
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        Archived ({threads.length})
      </button>
      {open && (
        <div data-archived-list className="mt-1.5">
          {threads.map((t) => (
            <AllRow key={t.id} {...p} t={t} archived hasContext={hasContext} />
          ))}
        </div>
      )}
    </div>
  );
}
