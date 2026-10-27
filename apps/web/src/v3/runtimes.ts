import type { RuntimeStatusRow } from "@lilos/contracts/app";
import type { ModelOption, ModelsListResult } from "@lilos/contracts/engine";
import type { ModelChoice, V3Runtime } from "@lilos/ui";
import { runtimeLook } from "@lilos/ui";
import { atom, computed, onMount, type ReadableAtom } from "nanostores";
import { modelVisibility, relay } from "../lib/runtime";
import { type ModelRow, modelLabel, modelRows, pickOf } from "./models";

/* D-#761/#872 — what the app knows about each runtime beyond the status
   row: its own model catalog (`models.list` routed to that engine, never
   the default's) and the profile fields it lets LilOS write (the status
   row's `agentsUpdatable`, which the harness fills once it has described
   the runtime). A runtime agent's page reads only its own runtime's
   catalog and field list — Hermes's list on a Devin agent was the bug. */

/** One runtime's catalog as picker rows plus its default, for labels. */
type RuntimeCatalog = {
  rows: ModelRow[];
  options: ModelOption[];
  default?: string;
  defaultProvider?: string;
};

const catalogs = atom<Record<string, RuntimeCatalog>>({});

/* A row gets asked once per supervisor verdict — `state`/`available`
   changing is the only signal a runtime that failed to answer may answer
   now, so the key the attempt is remembered under carries them. An EMPTY
   catalog is asked again on the next tick: adapters that fill their model
   list after `initialize` (the Claude adapter answers, then learns its
   options on the first session probe) must not pin the picker empty
   forever (#872). */
const attempted = new Map<
  string,
  { key: string; at: number; empty: boolean }
>();
const EMPTY_RETRY_MS = 15_000;
/* Runtimes with an ask in flight: a cold start fires several status and
   employee ticks before the first answer lands, and each would otherwise
   start its own `models.list` (D-#866). */
const inflight = new Set<string>();

/** A runtime whose engine is up or already coming up — asking one of ITS
    models or profiles adds nothing to the launch cost. Everything else
    (idle, stopped, failed, never reported) must not be started just to
    read a page (D-#866). */
export const runtimeLive = (runtime: string | undefined): boolean => {
  const row = relay.status
    .get()
    ?.result?.runtimes?.find((r) => r.id === runtime);
  return (
    row?.state === "running" ||
    row?.state === "starting" ||
    row?.state === "restarting"
  );
};

const signatureOf = (r: RuntimeStatusRow): string =>
  `${r.available ?? "?"}:${r.state ?? ""}:${r.detail ?? ""}`;

async function ask(r: RuntimeStatusRow): Promise<void> {
  if (inflight.has(r.id)) return;
  const key = signatureOf(r);
  const last = attempted.get(r.id);
  if (
    last &&
    last.key === key &&
    (!last.empty || Date.now() - last.at < EMPTY_RETRY_MS)
  )
    return;
  inflight.add(r.id);
  try {
    const res: ModelsListResult = await relay.listModels({ runtime: r.id });
    attempted.set(r.id, {
      key,
      at: Date.now(),
      empty: (res.models ?? []).length === 0,
    });
    catalogs.set({
      ...catalogs.get(),
      [r.id]: {
        rows: modelRows(res.models ?? [], modelVisibility.get()),
        options: res.models ?? [],
        ...(res.default !== undefined ? { default: res.default } : {}),
        ...(res.defaultProvider !== undefined
          ? { defaultProvider: res.defaultProvider }
          : {}),
      },
    });
  } catch {
    /* The runtime can't answer (not installed, down) — its agents' pages
       show the model as text until a changed status row re-asks. */
    attempted.set(r.id, { key, at: Date.now(), empty: false });
  } finally {
    inflight.delete(r.id);
  }
}

onMount(catalogs, () => {
  const sync = () => {
    const rows = relay.status.get()?.result?.runtimes;
    if (!rows?.length) return;
    /* Only a runtime an agent runs on AND that is already running is
       asked — `models.list` lazy-starts the adapter (D-#761), so asking
       every hired row would spawn idle hires' engines at boot (D-#866).
       A runtime started by real work changes its status row, which asks
       again. */
    const inUse = new Set(
      relay.employees.get().flatMap((e) => (e.runtime ? [e.runtime] : [])),
    );
    // The first row is the default engine — its catalog is the global one.
    for (const r of rows.slice(1))
      if (r.available !== false && inUse.has(r.id) && runtimeLive(r.id))
        void ask(r);
  };
  const stops = [relay.status.listen(sync), relay.employees.listen(sync)];
  sync();
  return () => {
    for (const stop of stops) stop();
  };
});

let store: ReadableAtom<V3Runtime[] | undefined> | undefined;

/** The status roster as V3Runtime rows — each runtime's `updatable`,
    model labels and avatar tone folded in (built on first read: `relay`
    binds at boot). */
export function runtimeRows(): ReadableAtom<V3Runtime[] | undefined> {
  store ??= computed(
    [relay.status, catalogs],
    (s, cats): V3Runtime[] | undefined =>
      s.result?.runtimes?.map((r, i) => {
        const cat = cats[r.id];
        return {
          id: r.id,
          label: r.label,
          ...(r.available !== undefined ? { available: r.available } : {}),
          ...(r.state ? { state: r.state } : {}),
          ...(r.detail ? { detail: r.detail } : {}),
          ...(i === 0 ? { isDefault: true } : {}),
          ...(r.agentsUpdatable ? { updatable: r.agentsUpdatable } : {}),
          ...(cat && cat.rows.length > 0
            ? { models: cat.rows.map((x) => x.label) }
            : {}),
          ...(i === 0 ? {} : { tone: runtimeLook(r.id).tone }),
        };
      }),
  );
  return store;
}

/** The runtime id `models.list`/`agents.*` route by, or undefined for the
    default engine — the roster's first row is the default (D-#761). */
export const defaultRuntimeId = (): string | undefined =>
  relay.status.get()?.result?.runtimes?.[0]?.id;

/** Absent, the literals "default"/"hermes", or the roster's first row all
    name the default engine (the harness's `normalizeRuntime`, D-#761) —
    the literals hold even before the status roster has loaded. */
export const isDefaultRuntime = (runtime: string | undefined): boolean =>
  !runtime ||
  runtime === "default" ||
  runtime === "hermes" ||
  runtime === defaultRuntimeId();

/* #872: the composer's picker reads the SELECTED agent's catalog — this
   exposes each asked runtime's raw options (effort ladders and Fast tiers
   included), keyed by runtime id. The default engine's catalog is not
   here; `data.modelCatalog` already carries it. */
type RuntimeCatalogSlice = {
  options: ModelOption[];
  defaultModel?: string;
  defaultProvider?: string;
};
let catalogStore: ReadableAtom<Record<string, RuntimeCatalogSlice>> | undefined;
export function runtimeCatalogs(): ReadableAtom<
  Record<string, RuntimeCatalogSlice>
> {
  catalogStore ??= computed(catalogs, (cats) =>
    Object.fromEntries(
      Object.entries(cats).map(([id, c]) => [
        id,
        {
          options: c.options,
          ...(c.default !== undefined ? { defaultModel: c.default } : {}),
          ...(c.defaultProvider !== undefined
            ? { defaultProvider: c.defaultProvider }
            : {}),
        },
      ]),
    ),
  );
  return catalogStore;
}

/** The label a runtime-owned model id shows as — the owning catalog's own
    words. A catalog that hasn't landed falls back to the tidied id ("the
    engine's own words"), never a guess from the default list (#872). */
export function modelLabelFor(
  runtime: string | undefined,
  id: string | undefined,
  provider?: string,
): string {
  if (!runtime || runtime === defaultRuntimeId())
    return modelLabel(id, provider);
  const cat = catalogs.get()[runtime];
  if (!cat) return id ? prettifyModelId(id) : "Engine default";
  const want = id || cat.default;
  if (!want) return "Engine default";
  const prov = id ? provider : cat.defaultProvider;
  const hit =
    cat.rows.find((r) => r.option.id === want && r.option.provider === prov) ??
    cat.rows.find((r) => r.option.id === want);
  return hit?.label ?? want;
}

/** The real pick behind a label on this runtime's picker; undefined = a
    label its catalog can't name — the write is then dropped, never sent
    through the default engine's ids (#872). */
export function pickForRuntime(
  runtime: string,
  label: string,
): ModelChoice | undefined {
  const row = catalogs.get()[runtime]?.rows.find((r) => r.label === label);
  return row ? pickOf(row.option) : undefined;
}

/** A model id's readable form when its runtime's catalog is unknown:
    "swe-2-high" reads "Swe-2-high" only as a last resort — the catalog
    almost always lands. */
function prettifyModelId(id: string): string {
  return id.slice(0, 1).toUpperCase() + id.slice(1);
}
