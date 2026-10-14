import {
  ChevronRightIcon,
  ListTodoIcon,
  MenuIcon,
  SearchIcon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import { HermesAvatar } from "../shell/avatars";
import { MainPane } from "../shell/main-pane";

/* One row in the cross-employee Sessions list — a view model, never a wire
   type: the app (and the prototype) derive it from conversation summaries
   plus the same running/needs-you rules the sidebar badges use. */
export type SessionRowVm = {
  /* What the host opens on click (conversation id / thread root id). */
  id: string;
  /* The employee the session belongs to — rows are DM sessions only. */
  employeeId: string;
  employeeName: string;
  title: string;
  /** Project folder the session works in ("LilOS"); absent = just chat. */
  folder?: string;
  /* needs you / running / failed / stopped / done — same words the DM
     session row states itself with. */
  state: "needs you" | "running" | "failed" | "stopped" | "done";
  /** The live line for in-flight rows: the current tool step for running
      sessions, the open ask for needs-you rows. */
  live?: string;
  /** Last activity label — "14:32", "Yesterday". */
  when: string;
  /** Finished since the watermark last moved — the "done since you last
      looked" dot. */
  unread?: boolean;
};

export type SessionGroups = {
  needsYou: SessionRowVm[];
  running: SessionRowVm[];
  finished: SessionRowVm[];
};

const STATE_TONE: Record<SessionRowVm["state"], string> = {
  "needs you": "text-amber-600",
  running: "text-work",
  failed: "text-red-600",
  stopped: "text-muted-foreground dark:text-foreground/80",
  done: "text-muted-foreground",
};

function SessionListRow({
  row,
  active,
  onOpen,
}: {
  row: SessionRowVm;
  active?: boolean;
  onOpen: (row: SessionRowVm) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(row)}
      data-session-row={row.id}
      data-state={row.state}
      data-unread={row.unread || undefined}
      title={[row.employeeName, row.folder].filter(Boolean).join(" · ")}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-accent/60 sm:px-5",
        active && "bg-primary/12 hover:bg-primary/15",
      )}
    >
      <HermesAvatar name={row.employeeName} className="mt-0.5 size-8" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-medium text-[14px]",
              row.unread && "font-semibold",
            )}
          >
            {row.title}
          </span>
          <span className="shrink-0 text-muted-foreground text-xs">
            {row.when}
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <span className="shrink-0 font-medium text-foreground/70">
            {row.employeeName}
          </span>
          {row.folder && (
            <span className="min-w-0 truncate">· {row.folder}</span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {row.unread && (
              <span
                title="Finished since you last looked"
                aria-label="Unread"
                className="size-2 rounded-full bg-primary"
              />
            )}
            <span
              data-row-state={row.state}
              className={cn("font-medium", STATE_TONE[row.state])}
            >
              {row.state}
            </span>
          </span>
        </div>
        {row.live && (
          <div
            data-row-live
            className={cn(
              "mt-0.5 min-w-0 truncate text-[12.5px]",
              row.state === "needs you"
                ? "font-medium text-amber-600"
                : "text-work",
            )}
          >
            {row.live}
          </div>
        )}
      </div>
      <ChevronRightIcon className="mt-2 size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function GroupHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-baseline gap-1.5 px-3 pt-4 pb-1 sm:px-5">
      <span className="font-semibold text-[12px] text-muted-foreground uppercase tracking-wide">
        {title}
      </span>
      <span className="text-muted-foreground text-xs">{count}</span>
    </div>
  );
}

/* The cross-employee session list (one view across every employee's DM
   sessions): Needs you / Running / Recently finished. Rows carry the
   employee avatar because the list mixes employees — everything else
   mirrors the DM session row's state words. */
export function SessionsHome({
  groups,
  activeId,
  onNav,
  onOpen,
  onSearchMessages,
  loading,
}: {
  groups: SessionGroups;
  /* The open conversation, when a row's session is on screen elsewhere —
     rows show the same active tint the DM list uses. */
  activeId?: string;
  onNav: () => void;
  onOpen: (row: SessionRowVm) => void;
  loading?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const match = (r: SessionRowVm) =>
    !q ||
    `${r.title}\n${r.employeeName}\n${r.folder ?? ""}`.toLowerCase().includes(q);
  const needsYou = groups.needsYou.filter(match);
  const running = groups.running.filter(match);
  const finished = groups.finished.filter(match);
  const empty = !needsYou.length && !running.length && !finished.length;

  return (
    <MainPane>
      <header className="lilos-drag flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:gap-3 sm:px-5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="lg:hidden"
          onClick={onNav}
          title="Sidebar"
          aria-label="Sidebar"
        >
          <MenuIcon />
        </Button>
        <ListTodoIcon className="size-5 text-muted-foreground" />
        <div className="min-w-0">
          <div className="truncate font-semibold text-[17px] tracking-tight">
            Sessions
          </div>
          <div className="truncate text-muted-foreground text-xs">
            Every session across employees
          </div>
        </div>
        {!empty && (
          <div className="relative ml-auto w-36 sm:w-44">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(ev) => setFilter(ev.target.value)}
              placeholder="Filter sessions"
              className="h-7 rounded-full border-transparent bg-foreground/[0.06] pl-7 text-xs shadow-none dark:bg-white/[0.08]"
            />
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div data-loading-sessions className="pt-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                data-session-skeleton
                className="flex items-start gap-3 px-3 py-2 sm:px-5"
              >
                <div className="size-8 animate-pulse rounded-full bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <ListTodoIcon className="size-10 text-muted-foreground/50" />
            <div className="font-medium">
              {q ? `No sessions match “${filter}”` : "No sessions yet"}
            </div>
            <div className="max-w-sm text-muted-foreground text-sm">
              {q
                ? "Titles, employees and folders are searched. Clear the filter to see everything."
                : "DM an employee to start a session — running, waiting and finished sessions list here."}
            </div>
          </div>
        ) : (
          <div className="pb-4" data-sessions-list>
            {needsYou.length > 0 && (
              <section data-sessions-group="needs-you">
                <GroupHeader title="Needs you" count={needsYou.length} />
                {needsYou.map((r) => (
                  <SessionListRow
                    key={r.id}
                    row={r}
                    active={r.id === activeId}
                    onOpen={onOpen}
                  />
                ))}
              </section>
            )}
            {running.length > 0 && (
              <section data-sessions-group="running">
                <GroupHeader title="Running" count={running.length} />
                {running.map((r) => (
                  <SessionListRow
                    key={r.id}
                    row={r}
                    active={r.id === activeId}
                    onOpen={onOpen}
                  />
                ))}
              </section>
            )}
            {finished.length > 0 && (
              <section data-sessions-group="finished">
                <GroupHeader
                  title="Recently finished"
                  count={finished.length}
                />
                {finished.map((r) => (
                  <SessionListRow
                    key={r.id}
                    row={r}
                    active={r.id === activeId}
                    onOpen={onOpen}
                  />
                ))}
              </section>
            )}
          </div>
        )}
      </div>
    </MainPane>
  );
}
