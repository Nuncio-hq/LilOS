import { CalendarClockIcon, FolderIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../lib/utils";
import { Btn } from "./v3-bits";
import type { V3Data, V3Schedule } from "./v3-data-types";
import { EscLayer } from "./v3-keys";
import { AgentAvatar, ProjectMark } from "./v3-marks";
import { agentOf, defaultAgent } from "./v3-model";
import type { V3Actions } from "./v3-page-types";
import {
  DAYS,
  describeWhen,
  KINDS,
  nextWords,
  pad,
  todayIso,
  validWhen,
  type When,
} from "./v3-schedule-text";
import { Switch } from "./v3-settings-bits";

/* Create or edit one schedule, inline on the page it was opened from. The
   plain-words line under "When" is exactly what the list will show. */

const FIELD =
  "h-8 rounded-[7px] border border-foreground/15 bg-background px-2.5 text-[14px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-foreground/40";
const LABEL = "mb-1 block text-[13px] text-muted-foreground";

function Chip({
  on,
  onClick,
  fixed,
  className,
  title,
  children,
}: {
  on: boolean;
  onClick?: () => void;
  /** Shown as chosen and not changeable (the agent whose page this is). */
  fixed?: boolean;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={fixed}
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border px-2 text-[13px] transition-colors disabled:cursor-default",
        on
          ? "border-foreground/40 bg-background font-medium text-foreground"
          : "border-[var(--v3-line)] text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function ScheduleEditor({
  data,
  initial,
  agentId,
  onDone,
  act,
}: {
  data: V3Data;
  /** Absent = a new schedule. */
  initial?: V3Schedule;
  /** The agent is fixed (its own page); absent = pick one. */
  agentId?: string;
  onDone: () => void;
  act: V3Actions;
}) {
  const [agent, setAgent] = useState(
    agentId ?? initial?.agentId ?? defaultAgent(data)?.id ?? "",
  );
  // A project is a folder: where a run opens is kept as both, so a schedule
  // that names only its folder shows the project that has it.
  const [place, setPlace] = useState<{ projectId?: string; folder?: string }>(
    () => ({
      projectId:
        initial?.projectId ??
        data.projects.find(
          (p) => initial?.folder && p.folder === initial.folder,
        )?.id,
      folder: initial?.folder,
    }),
  );
  const choices =
    data.projects.length > 0
      ? data.projects.map((p) => ({
          key: p.id,
          projectId: p.id,
          folder: p.folder,
          label: p.name,
          tone: p.tone,
        }))
      : (data.folders ?? []).map((f) => ({
          key: f.path,
          projectId: undefined,
          folder: f.path,
          label: f.label,
          tone: undefined,
        }));
  const isPicked = (c: (typeof choices)[number]) =>
    c.projectId ? c.projectId === place.projectId : c.folder === place.folder;
  const [title, setTitle] = useState(initial?.title ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [when, setWhen] = useState<When>(
    initial?.when ?? { kind: "weekdays", time: "09:00" },
  );
  const [fullAccess, setFullAccess] = useState(!!initial?.fullAccess);
  const set = (p: Partial<When>) => setWhen((w) => ({ ...w, ...p }));

  // Hourly keeps only a minute, so leaving it starts from a sensible hour.
  const pickKind = (kind: When["kind"]) =>
    setWhen((w) => ({
      ...w,
      kind,
      time: w.kind === "hourly" && kind !== "hourly" ? "09:00" : w.time,
      date: kind === "once" ? (w.date ?? todayIso()) : w.date,
    }));

  const valid = validWhen(when);
  const next = valid ? nextWords(when) : null;
  // A schedule whose agent left the team cannot be saved as it is: someone
  // on the team has to be picked first.
  const ready =
    !!agentOf(data, agent) && !!title.trim() && !!prompt.trim() && valid;
  const minute = Number(when.time.split(":")[1] ?? 0);

  const save = () => {
    if (!ready) return;
    const saved: When = {
      kind: when.kind,
      time: when.time,
      ...(when.kind === "weekly" && { day: when.day ?? 1 }),
      ...(when.kind === "once" && { date: when.date }),
      ...(when.kind === "cron" && { cron: when.cron?.trim() }),
    };
    act.scheduleSave({
      ...initial,
      id: initial?.id ?? `s-${Date.now().toString(36)}`,
      agentId: agent,
      projectId: place.projectId,
      folder: place.folder,
      title: title.trim(),
      prompt: prompt.trim(),
      fullAccess: fullAccess || undefined,
      when: saved,
      next: nextWords(saved) ?? "No more runs",
    });
    onDone();
  };

  return (
    <div className="space-y-4 rounded-lg border border-[var(--v3-line)] bg-[var(--v3-soft)] p-4">
      {/* Esc closes the editor, not the peek behind it. */}
      <EscLayer onEscape={onDone} />
      <div>
        <span className={LABEL}>Agent</span>
        <div className="flex flex-wrap gap-1.5">
          {data.agents
            .filter((a) => a.kind !== "outside")
            .filter((a) => !agentId || a.id === agentId)
            .map((a) => (
              <Chip
                key={a.id}
                on={a.id === agent}
                fixed={!!agentId}
                onClick={() => setAgent(a.id)}
              >
                <AgentAvatar data={data} agent={a} size={16} />
                {a.name}
              </Chip>
            ))}
        </div>
        {initial && !agentOf(data, agent) && (
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            This schedule's agent is no longer on the team. Pick who runs it.
          </p>
        )}
      </div>

      {(choices.length > 0 || place.folder !== undefined) && (
        <div>
          <span className={LABEL}>
            {data.projects.length > 0 ? "Project" : "Folder"}
          </span>
          <div className="flex flex-wrap gap-1.5">
            <Chip
              on={place.projectId === undefined && place.folder === undefined}
              onClick={() => setPlace({})}
            >
              {data.projects.length > 0 ? "No project" : "No folder"}
            </Chip>
            {choices.map((c) => (
              <Chip
                key={c.key}
                on={isPicked(c)}
                title={c.folder}
                onClick={() =>
                  setPlace({ projectId: c.projectId, folder: c.folder })
                }
              >
                {c.tone ? (
                  <ProjectMark
                    name={c.label}
                    tone={c.tone}
                    className="size-4"
                  />
                ) : (
                  <FolderIcon className="size-3.5" />
                )}
                {c.label}
              </Chip>
            ))}
            {/* A folder the schedule already has that no choice names stays
                chosen, so saving never drops it. */}
            {place.folder !== undefined && !choices.some(isPicked) && (
              <Chip on fixed title={place.folder}>
                <FolderIcon className="size-3.5" />
                {place.folder.split("/").filter(Boolean).pop() ?? place.folder}
              </Chip>
            )}
          </div>
        </div>
      )}

      <label className="block">
        <span className={LABEL}>Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Morning triage"
          className={cn(FIELD, "w-full")}
        />
      </label>

      <label className="block">
        <span className={LABEL}>What to do</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder={`What ${agentOf(data, agent)?.name ?? "the agent"} is told each time it runs.`}
          className={cn(
            FIELD,
            "block h-auto w-full resize-y py-1.5 leading-normal",
          )}
        />
      </label>

      <div>
        <span className={LABEL}>When</span>
        <div className="no-scrollbar flex w-fit max-w-full overflow-x-auto rounded-[7px] border border-[var(--v3-line)] bg-background p-0.5">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => pickKind(k.id)}
              className={cn(
                "h-[26px] shrink-0 whitespace-nowrap rounded-[5px] px-3 text-[13px] text-muted-foreground transition-colors hover:text-foreground",
                when.kind === k.id &&
                  "bg-[var(--v3-soft)] font-medium text-foreground",
              )}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {when.kind === "weekly" && (
            <div className="flex gap-1">
              {DAYS.map((d, i) => (
                <Chip
                  key={d}
                  title={d}
                  on={(when.day ?? 1) === i}
                  onClick={() => set({ day: i })}
                  className="w-8 justify-center px-0"
                >
                  {d.slice(0, 2)}
                </Chip>
              ))}
            </div>
          )}
          {when.kind === "once" && (
            <input
              type="date"
              aria-label="Date"
              min={todayIso()}
              value={when.date ?? ""}
              onChange={(e) => set({ date: e.target.value })}
              className={cn(FIELD, "w-40")}
            />
          )}
          {when.kind === "hourly" ? (
            <label className="flex items-center gap-2 text-[13.5px] text-muted-foreground">
              at minute
              <input
                type="number"
                min={0}
                max={59}
                value={minute}
                onChange={(e) =>
                  set({
                    time: `00:${pad(Math.max(0, Math.min(59, Number(e.target.value) || 0)))}`,
                  })
                }
                className={cn(FIELD, "w-16")}
              />
            </label>
          ) : when.kind === "cron" ? (
            <input
              aria-label="Cron"
              value={when.cron ?? ""}
              onChange={(e) => set({ cron: e.target.value })}
              placeholder="0 9 * * 1-5"
              spellCheck={false}
              className={cn(
                FIELD,
                "w-52 font-mono text-[13px]",
                when.cron && !valid && "border-red-400",
              )}
            />
          ) : (
            <input
              type="time"
              aria-label="Time"
              value={when.time}
              onChange={(e) => set({ time: e.target.value })}
              className={cn(FIELD, "w-28")}
            />
          )}
        </div>
        <div className="mt-2.5 flex items-center gap-2 text-[13.5px]">
          <CalendarClockIcon className="size-4 shrink-0 text-muted-foreground" />
          {valid ? (
            <span>
              <span className="font-medium text-foreground">
                {describeWhen(when)}
              </span>
              <span className="text-muted-foreground">
                {when.kind === "cron"
                  ? " · this Mac's time zone"
                  : next
                    ? ` · next ${next}`
                    : " · never runs again"}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">
              {when.kind === "cron"
                ? "Five fields: minute hour day month weekday"
                : "Pick a date and time"}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-start gap-3">
        <Switch
          on={fullAccess}
          onChange={setFullAccess}
          label="Run with full access"
        />
        <div className="min-w-0 text-[13.5px]">
          <div className="text-foreground">Run with full access</div>
          <div className="text-muted-foreground">
            Nobody is there to approve, so this run may use risky commands
            without asking.
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Btn
          primary
          onClick={save}
          className={cn(!ready && "pointer-events-none opacity-40")}
        >
          {initial ? "Save" : "Create schedule"}
        </Btn>
        <Btn onClick={onDone}>Cancel</Btn>
        {!ready && (
          <span className="text-[13px] text-muted-foreground/70">
            Give it a title, what to do and a time.
          </span>
        )}
      </div>
    </div>
  );
}
