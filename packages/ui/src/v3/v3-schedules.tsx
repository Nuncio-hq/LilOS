import {
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  ShieldIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { Btn, Section } from "./v3-bits";
import type { V3Schedule } from "./v3-data-types";
import { AgentAvatar, CeoMark, StatusPill } from "./v3-marks";
import { agentOf, FORMER_AGENT, projectOf } from "./v3-model";
import type { V3PageProps } from "./v3-page-types";
import { ScheduleEditor } from "./v3-schedule-editor";
import { describeWhen, PER_CRON } from "./v3-schedule-text";

export { ScheduleEditor } from "./v3-schedule-editor";

/* Jobs an agent runs by itself. Each row says what, when in plain words, when
   next and how the last run went; a run is a normal thread, so its pill opens
   it. Edit swaps the row for the editor; Delete asks in place. */

const RUN: Record<
  NonNullable<V3Schedule["last"]>["result"],
  { status: "working" | "done" | "failed"; label: string }
> = {
  running: { status: "working", label: "Running" },
  finished: { status: "done", label: "Finished" },
  failed: { status: "failed", label: "Failed" },
};

const GHOST =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] px-2 text-[13px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground [&_svg]:size-3.5";

function Row({
  s,
  data,
  go,
  act,
  agentId,
  onEdit,
}: V3PageProps & {
  s: V3Schedule;
  agentId?: string;
  onEdit: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const agent = agentOf(data, s.agentId);
  // A project is a folder: a schedule that names only the folder still
  // belongs to the project that has it.
  const project = s.projectId
    ? projectOf(data, s.projectId)
    : data.projects.find((p) => s.folder && p.folder === s.folder);
  const run = s.last && RUN[s.last.result];
  const { threadId } = s.last ?? {};

  return (
    <div className="flex flex-col gap-2 border-[var(--v3-line)] border-b py-3 @min-[560px]:flex-row @min-[560px]:items-start @min-[560px]:gap-4">
      <div
        className={cn(
          "flex min-w-0 flex-1 items-start gap-3",
          s.paused && "text-muted-foreground",
        )}
      >
        {!agentId &&
          (agent ? (
            <button
              type="button"
              title={`Open ${agent.name}`}
              onClick={() => go({ page: "agent", id: agent.id })}
              className={cn("mt-px shrink-0", s.paused && "opacity-60")}
            >
              <AgentAvatar data={data} agent={agent} size={24} />
            </button>
          ) : (
            // A fired agent has no page to open.
            <span className={cn("mt-px shrink-0", s.paused && "opacity-60")}>
              <AgentAvatar data={data} agent={undefined} size={24} />
            </span>
          ))}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14.5px]">
            <span
              className={cn(
                "min-w-0 truncate font-medium",
                !s.paused && "text-foreground",
              )}
            >
              {s.title}
            </span>
            {s.paused && <StatusPill status="idle" label="Paused" />}
            {s.fullAccess && (
              <span
                title="Runs without asking before risky commands"
                className="inline-flex h-[20px] shrink-0 items-center gap-1 rounded-full border border-[var(--v3-line)] px-2 text-[12px] text-muted-foreground [&_svg]:size-3"
              >
                <ShieldIcon /> Full access
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px] text-muted-foreground">
            {!agentId && (
              <span className="inline-flex items-center gap-1.5">
                {agent?.name ?? FORMER_AGENT}
                {agent && agent.id === data.ceoId && <CeoMark />}
              </span>
            )}
            {project ? (
              <span>{project.name}</span>
            ) : (
              s.folder && (
                <span title={s.folder}>
                  {s.folder.split("/").filter(Boolean).pop() ?? s.folder}
                </span>
              )
            )}
            <span className={cn(!s.paused && "text-foreground")}>
              {describeWhen(s.when)}
            </span>
            <span>
              {s.paused
                ? "Won't run while paused"
                : s.next === PER_CRON || s.next === "No more runs"
                  ? s.next
                  : `Next ${s.next}`}
            </span>
          </div>
          {s.last && run && (
            <div className="mt-1 flex items-center gap-2 text-[13px] text-muted-foreground">
              Last run {s.last.at}
              {threadId ? (
                <button
                  type="button"
                  title="Open this run"
                  onClick={() => go({ page: "thread", id: threadId })}
                  className="rounded-full transition-opacity hover:opacity-70"
                >
                  <StatusPill status={run.status} label={run.label} />
                </button>
              ) : (
                <StatusPill status={run.status} label={run.label} />
              )}
            </div>
          )}
          {s.skipped && (
            <div className="mt-1 text-[13px] text-amber-700 dark:text-amber-300">
              Skipped {s.skipped}: previous run still going
            </div>
          )}
          <p className="mt-1.5 line-clamp-2 text-[13px] text-muted-foreground/70 leading-relaxed">
            {s.prompt}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1 @min-[560px]:justify-end">
        {confirm ? (
          <>
            <span className="mr-1 text-[13px] text-muted-foreground">
              Delete?
            </span>
            <Btn
              small
              primary
              onClick={() => act.scheduleDelete(s.id)}
              title="Past runs stay in Threads"
            >
              Delete
            </Btn>
            <Btn small onClick={() => setConfirm(false)}>
              Cancel
            </Btn>
          </>
        ) : (
          <>
            {/* A fired agent cannot run it: reassign it first (Edit). */}
            {agent && (
              <Btn small onClick={() => act.scheduleRunNow(s.id)}>
                <PlayIcon className="size-3.5" /> Run now
              </Btn>
            )}
            <button
              type="button"
              onClick={() => act.scheduleToggle(s.id)}
              className={GHOST}
            >
              {s.paused ? <PlayIcon /> : <PauseIcon />}
              {s.paused ? "Resume" : "Pause"}
            </button>
            <button type="button" onClick={onEdit} className={GHOST}>
              <PencilIcon />
              Edit
            </button>
            <button
              type="button"
              aria-label={`Delete ${s.title}`}
              title="Delete"
              onClick={() => setConfirm(true)}
              className={cn(GHOST, "px-1.5")}
            >
              <Trash2Icon />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Every schedule, in the order the app keeps them. `agentId` limits the
    list to one agent (its own page) and fixes the agent in the editor. */
export function ScheduleList({
  data,
  go,
  act,
  agentId,
}: V3PageProps & { agentId?: string }) {
  const [editing, setEditing] = useState<string>();
  const list = data.schedules.filter((s) => !agentId || s.agentId === agentId);

  return (
    // Its own container, so rows reflow to the pane they are in.
    <div className="@container border-[var(--v3-line)] border-t">
      {list.length === 0 && (
        <p className="py-3 text-[14px] text-muted-foreground">
          No schedules yet. For example: weekdays at 09:00, triage what came in
          overnight.
        </p>
      )}
      {list.map((s) =>
        editing === s.id ? (
          <div key={s.id} className="border-[var(--v3-line)] border-b py-3">
            <ScheduleEditor
              data={data}
              initial={s}
              agentId={agentId}
              act={act}
              onDone={() => setEditing(undefined)}
            />
          </div>
        ) : (
          <Row
            key={s.id}
            s={s}
            data={data}
            go={go}
            act={act}
            agentId={agentId}
            onEdit={() => setEditing(s.id)}
          />
        ),
      )}
    </div>
  );
}

/** An agent page's Schedules section: its jobs, and a way to add one. */
export function AgentSchedules(
  p: V3PageProps & {
    agentId: string;
    /* Why the agent's runtime can't run a job right now (#872): the
       records still show — they're real — but nothing new gets planned
       while it can't fire. */
    unavailable?: string;
  },
) {
  const [creating, setCreating] = useState(false);
  const count = p.data.schedules.filter((s) => s.agentId === p.agentId).length;
  return (
    <>
      <Section
        title="Schedules"
        count={count}
        link={
          creating || p.unavailable !== undefined ? undefined : "New schedule"
        }
        onLink={() => setCreating(true)}
      />
      {p.unavailable !== undefined && (
        <p className="mb-3 text-[13px] text-muted-foreground/80">
          Can't run right now — {p.unavailable}
        </p>
      )}
      {creating && (
        <div className="mb-3">
          <ScheduleEditor
            data={p.data}
            agentId={p.agentId}
            act={p.act}
            onDone={() => setCreating(false)}
          />
        </div>
      )}
      <ScheduleList {...p} />
    </>
  );
}

/** Threads → Scheduled: every agent's jobs in one place. */
export function ScheduledView(p: V3PageProps) {
  const [creating, setCreating] = useState(false);
  return (
    <div className="mt-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <p className="text-[14px] text-muted-foreground">
          Agents run these by themselves; each run is a new thread.
        </p>
        {!creating && (
          <Btn small primary onClick={() => setCreating(true)}>
            <PlusIcon className="size-3.5" /> New schedule
          </Btn>
        )}
      </div>
      {creating && (
        <div className="mb-4">
          <ScheduleEditor
            data={p.data}
            act={p.act}
            onDone={() => setCreating(false)}
          />
        </div>
      )}
      <ScheduleList {...p} />
    </div>
  );
}
