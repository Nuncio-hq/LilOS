/* #157 — Row/format helpers for the mobile live thread: engine model rows
   (steps, plan, subagents, jobs) -> ui-native row props. Pure functions. */

import type {
  JobModel,
  SubagentModel,
  TurnPlan,
  TurnStep,
} from "@lilos/client-runtime";
import type { Job } from "@lilos/contracts/engine";
import type {
  BackgroundJobRow,
  PlanRow,
  SubagentRow,
  ToolStep,
} from "@lilos/ui-native";

const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The one argument worth showing on a step: a path, a command, a query. */
const argOf = (input: Record<string, unknown>): string | undefined => {
  const hit =
    input.command ?? input.path ?? input.query ?? input.pattern ?? input.url;
  if (typeof hit === "string" && hit) return hit;
  const first = Object.values(input).find((v) => typeof v === "string");
  return typeof first === "string" ? first : undefined;
};

export function toToolStep(s: TurnStep): ToolStep {
  return {
    id: s.id,
    tool: s.tool,
    arg: argOf(s.input),
    output: s.output,
    running: s.status === "running",
    add: s.diff?.add,
    del: s.diff?.del,
    patch: s.diff?.patch,
  };
}

/* #180: a tasks list under 2 items is noise and never maps (web rule). */
export function toPlanRow(p: TurnPlan): PlanRow | undefined {
  if (p.kind === "tasks" && p.steps.length < 2) return undefined;
  return {
    id: p.planId,
    kind: p.kind,
    version: p.version,
    ...(p.goal !== undefined ? { goal: p.goal } : {}),
    steps: p.steps.map((s) => ({
      text: s.text,
      ...(s.files ? { files: s.files } : {}),
      status: s.status,
    })),
    ...(p.risks ? { risks: p.risks } : {}),
    status: p.status,
  };
}

/** `SubagentRow.dur` reads seconds; the model tracks ms. */
export function toSubagentRow(
  s: SubagentModel,
  /* #181: the engine reports a helper's profile ref + session ref; LilOS
     links speak in employee ids + conversation ids, so the caller maps both
     (an unresolvable one keeps the ref as a plain label, like web). */
  resolveEmployee?: (link: {
    employeeRef: string;
    sessionRef: string;
  }) => SubagentRow["employee"],
): SubagentRow {
  return {
    id: s.subagentId,
    name: s.name,
    task: s.task,
    status: s.status,
    steps: s.steps.map(toToolStep),
    ...(s.result !== undefined ? { result: s.result } : {}),
    ...(s.durationMs !== undefined
      ? { dur: Math.round(s.durationMs / 10) / 100 }
      : {}),
    ...(s.employee
      ? {
          employee: resolveEmployee?.(s.employee) ?? {
            id: s.employee.employeeRef,
            name: s.employee.employeeRef,
            tone: "stone" as const,
          },
        }
      : {}),
  };
}

/** One `jobs.list` row as a JobModel so it merges under the event stream
   (job.* wins when both list a jobId — web rule, dm.tsx). */
export function listedJobModel(j: Job): JobModel {
  return {
    jobId: j.jobId,
    command: j.command,
    status: j.status,
    ...(j.startedAt !== undefined ? { startedAt: j.startedAt } : {}),
    ...(j.endedAt !== undefined ? { endedAt: j.endedAt } : {}),
    ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}),
    ...(j.url !== undefined ? { url: j.url } : {}),
    ...(j.by !== undefined ? { by: j.by } : {}),
    tail: j.tail ?? "",
  };
}

/** "38s" / "14m" / "1h 5m" — the Background tab's uptime column. */
export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function toJobRow(j: JobModel, now = Date.now()): BackgroundJobRow {
  return {
    id: j.jobId,
    command: j.command,
    status: j.status,
    started: j.startedAt ? clock(j.startedAt) : "",
    uptime: j.startedAt
      ? formatUptime(((j.endedAt ?? now) - j.startedAt) / 1000)
      : "0s",
    ...(j.url ? { url: j.url } : {}),
    ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}),
    log: j.tail,
    ...(j.by ? { by: j.by } : {}),
  };
}

/** "22.4k in · 1.8k out · 15k cached" — the session sheet's usage row. */
export function usageLabel(u: {
  input: number;
  output: number;
  reasoning?: number;
  cache?: number;
}): string {
  const k = (n: number) =>
    n < 1000 ? `${n}` : `${Math.round((n / 1000) * 10) / 10}k`;
  const bits = [`${k(u.input)} in`, `${k(u.output + (u.reasoning ?? 0))} out`];
  if (u.cache) bits.push(`${k(u.cache)} cached`);
  return bits.join(" · ");
}
