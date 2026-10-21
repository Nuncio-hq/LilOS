import type { StatusRow } from "@lilos/client-runtime";
import {
  nextRunAt,
  type ScheduledTask,
  type SystemStatusResult,
} from "@lilos/contracts/app";
import type { ModelOption, ModelProvider } from "@lilos/contracts/engine";
import {
  isHidden,
  type ModelVisibility,
  type V3Device,
  type V3Schedule,
  type V3Settings,
  whenWords,
} from "@lilos/ui";
import { modelRows } from "./models";

/* Pure shapes: how the relay's records read as v3 view models, and (for the
   model switches) back. No stores here, so each rule stays testable. */

/** The catalog's own identity for a model (what the visibility list stores);
    an id is unique only per provider. */
const keyOf = (m: Pick<ModelOption, "id" | "provider">) =>
  `${m.provider ?? ""}::${m.id}`;

/* ------------------------------- engine / relay ----------------------------- */

const plain = (row: StatusRow) =>
  [row.reason, row.hint].filter(Boolean).join("\n");

/** The engine leg of `system.status`, in the states Settings and first run
    draw. The engine's own plain words (reason + next step) ride along;
    classifying uses the raw text (`detail`) when the display rewrote it. */
export function engineOf(
  rows: StatusRow[],
  result: SystemStatusResult | undefined,
): V3Settings["engine"] {
  const row = rows.find((r) => r.id === "engine");
  const given = result?.engine?.name;
  const name = given ?? "engine";
  const shown = name.charAt(0).toUpperCase() + name.slice(1);
  const version = result?.engine?.version;
  const base = {
    name: shown,
    ...(given ? {} : { unnamed: true as const }),
    ...(version ? { version } : {}),
  };
  if (!row || row.state === "connecting" || row.state === "blocked")
    return { ...base, state: "starting" };
  if (row.state === "ok") return { ...base, state: "ok" };
  const raw = row.detail ?? row.reason;
  const state = /too old/i.test(raw)
    ? "old"
    : /not found/i.test(raw)
      ? "missing"
      : "down";
  return { ...base, state, problem: plain(row) };
}

export function relayOf(rows: StatusRow[]): V3Settings["relay"] {
  const row = rows.find((r) => r.id === "relay");
  if (!row || row.state === "connecting" || row.state === "blocked")
    return { state: "starting" };
  if (row.state === "ok") return { state: "ok" };
  return { state: "down", problem: plain(row) };
}

/* --------------------------------- models ---------------------------------- */

/** The catalog as Settings switches: one row per model, on unless hidden. */
export function modelsOf(
  catalog: ModelOption[],
  providers: ModelProvider[],
  visibility: ModelVisibility,
): V3Settings["models"] {
  const named = new Map(providers.map((p) => [p.id, p.name ?? p.id]));
  return modelRows(catalog, { providers: [], models: [] }).map((r) => {
    const group = r.option.provider
      ? (named.get(r.option.provider) ?? r.option.provider)
      : undefined;
    return {
      id: keyOf(r.option),
      label: r.label,
      on: !isHidden(r.option, visibility),
      ...(group ? { group } : {}),
    };
  });
}

/** The hide list that makes the catalog read as `models` says. A provider
    stays hidden (so models it adds later start hidden) only while every one
    of its models is still off; turning one on lifts the provider and lists
    the rest of its hidden models one by one. */
export function visibilityOf(
  models: V3Settings["models"],
  catalog: ModelOption[],
  current: ModelVisibility,
): ModelVisibility {
  const off = new Set(models.filter((m) => !m.on).map((m) => m.id));
  const providers = current.providers.filter((p) =>
    catalog.filter((o) => o.provider === p).every((o) => off.has(keyOf(o))),
  );
  const known = new Set(catalog.map(keyOf));
  return {
    providers,
    models: [
      // A hide the catalog no longer lists stays: the model may come back.
      ...current.models.filter((k) => !known.has(k)),
      ...catalog
        .filter(
          (o) =>
            off.has(keyOf(o)) &&
            !(o.provider && providers.includes(o.provider)),
        )
        .map(keyOf),
    ],
  };
}

/* --------------------------- devices and schedules --------------------------- */

/** "4m ago": coarse on purpose; the clock ticks the slice once a minute. */
export function agoWords(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export const deviceOf = (
  d: { id: string; name: string; lastSeenAt: number },
  now: number,
): V3Device => ({
  id: d.id,
  name: d.name,
  lastSeen: agoWords(d.lastSeenAt, now),
});

/** A relay task as a v3 schedule, losslessly: `when` is the same record,
    `next` is the real next run in words and `nextAt` is that same instant
    (cron walked, a past "once" is over — words are not an order, D-#774),
    and a run opens its thread by the conversation it made (only when that
    conversation is known here: `knownThreads` holds the ids of the ones that
    are). */
export function scheduleOf(
  task: ScheduledTask,
  knownThreads: ReadonlySet<string>,
  now: Date,
): V3Schedule {
  const next = nextRunAt(task.schedule, now);
  const run = task.lastRun;
  const threadId =
    run && knownThreads.has(run.conversationId)
      ? run.conversationId
      : undefined;
  return {
    id: task.id,
    agentId: task.employeeId,
    title: task.name,
    prompt: task.prompt,
    when: task.schedule,
    next: next ? whenWords(next, now) : "No more runs",
    ...(next ? { nextAt: next.getTime() } : {}),
    ...(task.folder !== undefined ? { folder: task.folder } : {}),
    ...(task.paused ? { paused: true } : {}),
    ...(task.access === "full" ? { fullAccess: true } : {}),
    ...(run
      ? {
          last: {
            at: whenWords(new Date(run.at), now),
            result: run.result,
            ...(threadId ? { threadId } : {}),
          },
        }
      : {}),
    ...(task.skippedAt !== undefined
      ? { skipped: whenWords(new Date(task.skippedAt), now) }
      : {}),
  };
}
