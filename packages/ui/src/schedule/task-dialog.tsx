import { CalendarClockIcon, ShieldIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { Field } from "../dialogs/field";
import { folderLabel } from "../lib/helpers";
import { cn } from "../lib/utils";
import type {
  ConversationAccess,
  Folder,
  Schedule,
  ScheduledTask,
} from "../types";
import {
  DAYS,
  describeSchedule,
  nextRun,
  SCHEDULE_KINDS,
  validSchedule,
  whenText,
} from "./schedule-text";

/* What New task / Edit report back; the app owns ids and run state. */
export type TaskDraft = Pick<
  ScheduledTask,
  "name" | "prompt" | "folder" | "schedule" | "access"
>;

const NO_FOLDER = "__none";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/* Create or edit one scheduled task (#136). Presets cover the usual cases;
   Custom takes a five-field cron. The plain-words line under the schedule
   is exactly what the task list will show. */
export function TaskDialog({
  task,
  employeeName,
  folders,
  defaultFolder,
  onClose,
  onSave,
}: {
  /** Absent = New task. */
  task?: ScheduledTask;
  employeeName: string;
  folders: Folder[];
  defaultFolder?: string;
  onClose: () => void;
  onSave: (d: TaskDraft) => void;
}) {
  const [name, setName] = useState(task?.name ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [folder, setFolder] = useState(
    task ? (task.folder ?? NO_FOLDER) : (defaultFolder ?? NO_FOLDER),
  );
  const [schedule, setSchedule] = useState<Schedule>(
    task?.schedule ?? { kind: "weekdays", time: "09:00", day: 1 },
  );
  const [access, setAccess] = useState<ConversationAccess>(
    task?.access ?? "ask",
  );
  const set = (p: Partial<Schedule>) => setSchedule((s) => ({ ...s, ...p }));
  const ok = validSchedule(schedule);
  const next = ok ? nextRun(schedule, new Date()) : null;
  const canSave = !!name.trim() && !!prompt.trim() && ok;
  const usable = folders.filter((f) => !f.missing);
  const save = () =>
    canSave &&
    onSave({
      name: name.trim(),
      prompt: prompt.trim(),
      folder: folder === NO_FOLDER ? undefined : folder,
      schedule,
      access,
    });

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={task ? "Edit scheduled task" : "New scheduled task"}
        data-task-dialog
        className="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-5 py-3">
          <CalendarClockIcon className="size-4" />
          <div className="font-semibold">
            {task ? "Edit scheduled task" : "New scheduled task"}
          </div>
          <span className="truncate text-muted-foreground text-xs">
            runs as a new session with {employeeName}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            onClick={onClose}
            aria-label="Close"
          >
            <XIcon />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <Field label="Name">
            <Input
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder="Morning triage"
              aria-label="Task name"
            />
          </Field>
          <Field label="Prompt">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Triage new GitHub issues and label what's ready."
              aria-label="Task prompt"
              className="min-h-24"
            />
          </Field>
          <Field label="Folder">
            <Select value={folder} onValueChange={(v) => setFolder(String(v))}>
              <SelectTrigger className="w-full" aria-label="Task folder">
                <SelectValue>
                  {(v: string) =>
                    v === NO_FOLDER
                      ? "No folder"
                      : (() => {
                          const f = usable.find((x) => x.id === v);
                          return f ? folderLabel(f, folders) : "No folder";
                        })()
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_FOLDER}>No folder</SelectItem>
                {usable.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {folderLabel(f, folders)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Schedule">
            <div className="flex flex-wrap gap-1.5" data-schedule-kinds>
              {SCHEDULE_KINDS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  aria-pressed={schedule.kind === k.id}
                  onClick={() => set({ kind: k.id })}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs hover:border-foreground/30",
                    schedule.kind === k.id &&
                      "border-foreground bg-foreground text-background hover:border-foreground",
                  )}
                >
                  {k.label}
                </button>
              ))}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {schedule.kind === "weekly" && (
                <div className="flex gap-1" data-schedule-days>
                  {DAYS.map((d, i) => (
                    <button
                      key={d}
                      type="button"
                      title={d}
                      aria-pressed={(schedule.day ?? 1) === i}
                      onClick={() => set({ day: i })}
                      className={cn(
                        "grid size-7 place-items-center rounded-full border text-xs",
                        (schedule.day ?? 1) === i &&
                          "border-foreground bg-foreground text-background",
                      )}
                    >
                      {d.slice(0, 2)}
                    </button>
                  ))}
                </div>
              )}
              {schedule.kind === "once" && (
                <Input
                  type="date"
                  aria-label="Date"
                  min={today()}
                  value={schedule.date ?? ""}
                  onChange={(e) => set({ date: e.target.value })}
                  className="h-8 w-40"
                />
              )}
              {schedule.kind === "hourly" ? (
                <div className="flex items-center gap-1.5 text-xs">
                  at minute
                  <Input
                    type="number"
                    aria-label="Minute"
                    min={0}
                    max={59}
                    value={Number(schedule.time.split(":")[1] ?? 0)}
                    onChange={(e) => {
                      const m = Math.max(
                        0,
                        Math.min(59, Number(e.target.value)),
                      );
                      set({ time: `00:${String(m).padStart(2, "0")}` });
                    }}
                    className="h-8 w-16"
                  />
                </div>
              ) : schedule.kind === "cron" ? (
                <Input
                  aria-label="Cron"
                  value={schedule.cron ?? ""}
                  onChange={(e) => set({ cron: e.target.value })}
                  placeholder="0 9 * * 1-5"
                  spellCheck={false}
                  className={cn(
                    "h-8 w-48 font-mono text-xs",
                    schedule.cron && !ok && "border-red-400",
                  )}
                />
              ) : (
                <Input
                  type="time"
                  aria-label="Time"
                  value={schedule.time}
                  onChange={(e) => set({ time: e.target.value })}
                  className="h-8 w-28"
                />
              )}
            </div>
            <div
              data-schedule-preview
              className="mt-2.5 flex items-center gap-1.5 rounded-md bg-muted/60 px-2.5 py-1.5 text-xs"
            >
              <CalendarClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
              {ok ? (
                <span>
                  <span className="font-medium">
                    {describeSchedule(schedule)}
                  </span>
                  <span className="text-muted-foreground">
                    {next
                      ? ` · next ${whenText(next, new Date())}`
                      : " · never runs again"}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">
                  {schedule.kind === "cron"
                    ? "Five fields: minute hour day month weekday"
                    : "Pick a date and time"}
                </span>
              )}
            </div>
            {schedule.kind === "cron" && (
              <p className="mt-1.5 text-muted-foreground text-xs">
                Uses this Mac's time zone. A run missed while the Mac slept runs
                once when it wakes.
              </p>
            )}
          </Field>

          <Field label="While nobody is watching">
            <div className="grid gap-1.5 sm:grid-cols-2">
              <AccessOption
                on={access === "ask"}
                onClick={() => setAccess("ask")}
                title="Ask"
                hint="Stops and waits for you on risky commands. You get a notification."
              />
              <AccessOption
                on={access === "full"}
                onClick={() => setAccess("full")}
                title={
                  <span className="flex items-center gap-1 text-orange-600 dark:text-orange-400">
                    <ShieldIcon className="size-3.5" />
                    Full access
                  </span>
                }
                hint="Never stops to ask, so runs always finish."
              />
            </div>
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {task ? "Save" : "Create task"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AccessOption({
  on,
  onClick,
  title,
  hint,
}: {
  on: boolean;
  onClick: () => void;
  title: React.ReactNode;
  hint: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "rounded-lg border p-2.5 text-left hover:border-foreground/30",
        on && "border-foreground ring-1 ring-foreground",
      )}
    >
      <div className="font-medium text-sm">{title}</div>
      <div className="mt-0.5 text-muted-foreground text-xs">{hint}</div>
    </button>
  );
}
