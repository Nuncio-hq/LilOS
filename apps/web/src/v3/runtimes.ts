import type { RuntimeStatusRow } from "@lilos/contracts/app";
import type { ModelOption, ModelsListResult } from "@lilos/contracts/engine";
import type { ModelChoice, V3Runtime } from "@lilos/ui";
import { runtimeLook } from "@lilos/ui";
import { atom, computed, onMount, type ReadableAtom } from "nanostores";
import { modelVisibility, relay } from "../lib/runtime";
import { type ModelRow, modelLabel, modelRows, pickOf } from "./models";
import { openRuntimeProfile } from "./profiles";
import { defaultRuntimeId, runtimeLive } from "./runtime-ids";

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

/* D-#899: runtimes an open screen asked for. Fills only from
   `openRuntimeScreen` — a status sync never adds one — so booting still
   starts nothing (D-#866), while a runtime agent's chat, thread or page
   asks the catalog even while the adapter sleeps (the ask itself
   lazy-starts it, D-#761). Leaving the screen keeps the row: a later
   open finds the catalog already landed. */
const screenOpened = new Set<string>();
/* The screen's own ask, in flight ("loading") or refused ("failed" +
   the row's reason) — the chips read it as "Loading models…" / "Models
   unavailable" instead of a model the catalog never named. */
const catalogPhase = atom<
  Record<string, { state: "loading" | "failed"; detail?: string }>
>({});
const setPhase = (
  runtime: string,
  v?: { state: "loading" | "failed"; detail?: string },
) => {
  const next = { ...catalogPhase.get() };
  if (v) next[runtime] = v;
  else delete next[runtime];
  catalogPhase.set(next);
};

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

const signatureOf = (r: RuntimeStatusRow): string =>
  `${r.available ?? "?"}:${r.state ?? ""}:${r.detail ?? ""}`;

function land(runtime: string, res: ModelsListResult): void {
  catalogs.set({
    ...catalogs.get(),
    [runtime]: {
      rows: modelRows(res.models ?? [], modelVisibility.get()),
      options: res.models ?? [],
      ...(res.default !== undefined ? { default: res.default } : {}),
      ...(res.defaultProvider !== undefined
        ? { defaultProvider: res.defaultProvider }
        : {}),
    },
  });
}

/** #895: Refresh in a runtime's thread re-asks THAT runtime
    (`models.list {runtime, refresh}`), never Hermes's. Throws on a failed
    ask (the caller toasts); an answered-empty keeps the rows already known,
    like the default engine's refresh does. */
export async function refreshRuntimeModels(runtime: string): Promise<void> {
  const res = await relay.listModels({ runtime, refresh: true });
  if (res.models?.length) land(runtime, res);
}

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
  /* #899: mark the ask in flight before it leaves — the chips read
     "loading" from the first render after the screen opened. */
  setPhase(r.id, { state: "loading" });
  try {
    const res: ModelsListResult = await relay.listModels({ runtime: r.id });
    attempted.set(r.id, {
      key,
      at: Date.now(),
      empty: (res.models ?? []).length === 0,
    });
    land(r.id, res);
    setPhase(r.id);
  } catch (e) {
    /* The runtime can't answer (not installed, down) — a screen that
       asked gets "failed" with the reason so its chip can offer Retry
       (#899 AC-4); a boot ask just stays an empty catalog. */
    attempted.set(r.id, { key, at: Date.now(), empty: false });
    if (screenOpened.has(r.id))
      setPhase(r.id, {
        state: "failed",
        detail: e instanceof Error ? e.message : String(e),
      });
    else setPhase(r.id);
  } finally {
    inflight.delete(r.id);
  }
}

/** D-#899: a screen that shows this runtime's agent asks its catalog even
   while the adapter sleeps — the ask is what lazy-starts it. A landed
   catalog is not re-asked; a refused one is deduped on the row's signature
   like every ask — the verdict changing (state/available/detail) is the
   only signal a retry may answer — a screen mounted across status polls
   must not spam the engine on each poll. `retryRuntimeCatalog` is the
   explicit forget-and-ask. */
export function openRuntimeScreen(runtime: string): void {
  if (!runtime || runtime === defaultRuntimeId()) return;
  screenOpened.add(runtime);
  const row = relay.status
    .get()
    ?.result?.runtimes?.find((r) => r.id === runtime);
  if (row && !catalogs.get()[runtime]?.options.length) void ask(row);
  /* The agent page's editable fields come from the same lazy describe —
       asking it here lands `agentsUpdatable` while idle too. */
  openRuntimeProfile(runtime);
}

/** The failed chip's Retry: forget the refusal and ask like the screen
    just opened. */
export function retryRuntimeCatalog(runtime: string): void {
  attempted.delete(runtime);
  openRuntimeScreen(runtime);
}

const sync = () => {
  const rows = relay.status.get()?.result?.runtimes;
  if (!rows?.length) return;
  /* Only a runtime an agent runs on AND that is already running is
     asked — `models.list` lazy-starts the adapter (D-#761), so asking
     every hired row would spawn idle hires' engines at boot (D-#866).
     An open screen's runtime is the exception (D-#899): it asks even
     idle, and the ask is what starts it. A runtime started by real work
     changes its status row, which asks again. */
  const inUse = new Set(
    relay.employees.get().flatMap((e) => (e.runtime ? [e.runtime] : [])),
  );
  // The first row is the default engine — its catalog is the global one.
  for (const r of rows.slice(1))
    if (
      r.available !== false &&
      inUse.has(r.id) &&
      (runtimeLive(r.id) || screenOpened.has(r.id))
    )
      void ask(r);
};

onMount(catalogs, () => {
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
    [relay.status, catalogs, catalogPhase],
    (s, cats, phases): V3Runtime[] | undefined =>
      s.result?.runtimes?.map((r, i) => {
        const cat = cats[r.id];
        const phase = phases[r.id];
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
          ...(phase ? { catalogState: phase.state } : {}),
          ...(phase?.detail ? { catalogDetail: phase.detail } : {}),
          ...(cat ? { catalogLanded: true } : {}),
          ...(i === 0 ? {} : { tone: runtimeLook(r.id).tone }),
        };
      }),
  );
  return store;
}

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
