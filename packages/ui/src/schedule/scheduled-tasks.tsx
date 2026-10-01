import {
  CalendarClockIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  EllipsisIcon,
  FolderIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  ShieldIcon,
  SkipForwardIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { folderLabel } from "../lib/helpers";
import { cn } from "../lib/utils";
import type { Folder, ScheduledRun, ScheduledTask } from "../types";
import { describeSchedule, nextRun, whenText } from "./schedule-text";

const RUN: Record<
  ScheduledRun["result"],
  { label: string; icon: typeof PlayIcon; className: string }
> = {
  running: {
    label: "running now",
    icon: CircleDotIcon,
    className: "text-work [&>svg]:animate-pulse",
  },
  finished: {
    label: "finished",
    icon: CheckCircle2Icon,
    className: "text-emerald-700 dark:text-emerald-400",
  },
  failed: {
    label: "failed",
    icon: TriangleAlertIcon,
    className: "text-red-700 dark:text-red-400",
  },
};

/* An employee's scheduled tasks (#136), shown in the DM's right panel.
   Each run is a normal session in the DM; this list only owns the tasks. */
export function ScheduledTasks({
  employeeName,
  tasks,
  folders,
  highlight,
  now = new Date(),
  onNew,
  onEdit,
  onRunNow,
  onPause,
  onDelete,
  onOpenRun,
}: {
  employeeName: string;
  tasks: ScheduledTask[];
  folders: Folder[];
  /** Task to scroll to and flash (the DM's Scheduled chip). */
  highlight?: string | null;
  now?: Date;
  onNew: () => void;
  onEdit: (t: ScheduledTask) => void;
  onRunNow: (id: string) => void;
  onPause: (id: string, paused: boolean) => void;
  onDelete: (id: string) => void;
  /** Opens a run's session in the DM. */
  onOpenRun?: (rootId: string) => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const refs = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    if (highlight)
      refs.current[highlight]?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  return (
    <div className="space-y-2 p-3" data-scheduled-tasks>
      <div className="flex items-start gap-2">
        <p className="flex-1 text-muted-foreground text-xs">
          Each run opens a new session with {employeeName}, in the DM like any
          other. You get the usual notifications.
        </p>
        <Button size="sm" onClick={onNew}>
          <PlusIcon />
          New task
        </Button>
      </div>
      {tasks.length === 0 && (
        <div className="rounded-xl border border-dashed p-5 text-center">
          <CalendarClockIcon className="mx-auto size-6 text-muted-foreground" />
          <div className="mt-2 font-medium">No scheduled tasks yet</div>
          <p className="mt-1 text-muted-foreground text-xs">
            For example: "Weekdays at 9:00, triage new GitHub issues".
          </p>
        </div>
      )}
      {tasks.map((t) => {
        const next = t.paused ? null : nextRun(t.schedule, now);
        const folder = folders.find((f) => f.id === t.folder);
        const run = t.lastRun && RUN[t.lastRun.result];
        const RunIcon = run?.icon;
        return (
          <div
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            data-task={t.id}
            data-paused={t.paused || undefined}
            className={cn(
              "rounded-xl border bg-background p-3 transition-colors",
              highlight === t.id && "border-primary outline-2 outline-primary/40",
            )}
          >
            <div className="flex items-center gap-2">
              <CalendarClockIcon
                className={cn(
                  "size-4 shrink-0",
                  t.paused ? "text-muted-foreground" : "text-tint-text",
                )}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate font-medium",
                  t.paused && "text-muted-foreground",
                )}
              >
                {t.name}
              </span>
              {t.paused && <Badge variant="secondary">Paused</Badge>}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`${t.name} actions`}
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    />
                  }
                >
                  <EllipsisIcon className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem onClick={() => onRunNow(t.id)}>
                    <PlayIcon />
                    Run now
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onPause(t.id, !t.paused)}>
                    {t.paused ? <PlayIcon /> : <PauseIcon />}
                    {t.paused ? "Resume" : "Pause"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onEdit(t)}>
                    <PencilIcon />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setConfirm(t.id)}
                  >
                    <Trash2Icon />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground leading-5">
              {t.prompt}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="font-medium">
                {describeSchedule(t.schedule)}
              </span>
              {folder && (
                <span className="flex items-center gap-1 text-muted-foreground">
                  <FolderIcon className="size-3" />
                  {folderLabel(folder, folders)}
                </span>
              )}
              {t.access === "full" && (
                <span className="flex items-center gap-1 text-orange-600 dark:text-orange-400">
                  <ShieldIcon className="size-3" />
                  Full access
                </span>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
              <span data-next-run>
                {t.paused
                  ? "Paused · won't run"
                  : next
                    ? `Next: ${whenText(next, now)}`
                    : "No more runs"}
              </span>
              {t.lastRun && run && RunIcon && (
                <button
                  type="button"
                  data-last-run={t.lastRun.result}
                  disabled={!t.lastRun.rootId || !onOpenRun}
                  onClick={() =>
                    t.lastRun?.rootId && onOpenRun?.(t.lastRun.rootId)
                  }
                  className={cn(
                    "flex items-center gap-1 rounded enabled:hover:underline",
                    run.className,
                  )}
                >
                  <RunIcon className="size-3" />
                  Last run {t.lastRun.at}: {run.label}
                </button>
              )}
            </div>
            {t.skipped && (
              <div
                data-skipped
                className="mt-1 flex items-center gap-1 text-amber-700 text-xs dark:text-amber-400"
              >
                <SkipForwardIcon className="size-3" />
                Skipped {t.skipped}: previous run still going
              </div>
            )}
            {confirm === t.id && (
              <div
                data-confirm-delete
                className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-red-900 text-xs dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200"
              >
                <span className="min-w-0 flex-1">
                  Delete "{t.name}"? Past runs stay in the DM.
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setConfirm(null)}
                >
                  Cancel
                </Button>
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => {
                    setConfirm(null);
                    onDelete(t.id);
                  }}
                >
                  Delete
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
