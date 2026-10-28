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

/* D-#899: runtimes with a screen open right now (count of mounted
   chats, threads and agent pages). Fills only from `openRuntimeScreen`,
   and each screen releases its count on unmount — so booting starts
   nothing (D-#866), and a screen that is gone never starts a runtime
   later (a crash returning the row to idle must not re-ask). */
const mounted = new Map<string, number>();
/* Automatic re-asks of a mounted screen whose ask failed while its
   runtime was already coming up (a cold start can outlive the engine
   call's deadline). Bounded; Retry is the user's own. */
const liveRetries = new Map<string, number>();
const LIVE_RETRY_MS = 4_000;
const LIVE_RETRY_MAX = 3;
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
  /* An unchanged phase writes nothing: the chips' open-effect re-runs on
     every new runtime row, and a fresh object here would re-render the row,
     re-run the effect and loop (#899 review). */
  const cur = catalogPhase.get()[runtime];
  if (cur?.state === v?.state && cur?.detail === v?.detail) return;
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
  { key: string; at: number; empty: boolean; error?: string }
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
  ) {
    /* #899: a refusal remembered from before the screen opened (a live
       runtime's sync ask) still owes the screen its "failed" chip —
       otherwise it would spin "Loading models…" with no ask in flight. */
    if (last.error !== undefined && mounted.has(r.id))
      setPhase(r.id, { state: "failed", detail: last.error });
    return;
  }
  inflight.add(r.id);
  /* #899: mark the ask in flight before it leaves — the chips read
     "loading" from the first render after the screen opened. A catalog
     that already landed (even empty) keeps its chip while re-asked. */
  if (!catalogs.get()[r.id]) setPhase(r.id, { state: "loading" });
  try {
    const res: ModelsListResult = await relay.listModels({ runtime: r.id });
    attempted.set(r.id, {
      key,
      at: Date.now(),
      empty: (res.models ?? []).length === 0,
    });
    land(r.id, res);
    liveRetries.delete(r.id);
    setPhase(r.id);
  } catch (e) {
    /* The runtime can't answer (not installed, down) — a screen that
       asked gets "failed" with the reason so its chip can offer Retry
       (#899 AC-4); a boot ask just stays an empty catalog. */
    const error = e instanceof Error ? e.message : String(e);
    attempted.set(r.id, { key, at: Date.now(), empty: false, error });
    const tries = liveRetries.get(r.id) ?? 0;
    if (mounted.has(r.id) && runtimeLive(r.id) && tries < LIVE_RETRY_MAX) {
      /* The runtime is up or coming up — a cold start that outlived the
         call's deadline. Stay "loading" and ask again shortly. */
      liveRetries.set(r.id, tries + 1);
      attempted.delete(r.id);
      setTimeout(() => {
        const row = relay.status
          .get()
          ?.result?.runtimes?.find((x) => x.id === r.id);
        if (row && mounted.has(r.id)) void ask(row);
      }, LIVE_RETRY_MS);
    } else if (mounted.has(r.id))
      setPhase(r.id, { state: "failed", detail: error });
    else setPhase(r.id);
  } finally {
    inflight.delete(r.id);
  }
}

/** D-#899: a screen that shows this runtime's agent asks its catalog even
   while the adapter sleeps — the ask is what lazy-starts it. Returns the
   screen's release (call it on unmount). A landed catalog is not
   re-asked; a refused one waits for Retry (`retryRuntimeCatalog`) or the
   runtime coming up on its own — never a loop of restarts. */
export function openRuntimeScreen(runtime: string): () => void {
  if (!runtime || runtime === defaultRuntimeId()) return () => {};
  mounted.set(runtime, (mounted.get(runtime) ?? 0) + 1);
  askForScreen(runtime);
  /* The agent page's editable fields come from the same lazy describe —
     asking it here lands `agentsUpdatable` while idle too. */
  const releaseProfile = openRuntimeProfile(runtime);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseProfile();
    const n = (mounted.get(runtime) ?? 1) - 1;
    if (n > 0) mounted.set(runtime, n);
    else mounted.delete(runtime);
  };
}

/* A mounted screen's first ask: once per runtime until it lands or is
   retried — whether or not the row says the runtime is installed (a
   refusal is what gives the chip its reason). */
function askForScreen(runtime: string): void {
  if (catalogs.get()[runtime]?.options.length) return;
  const row = relay.status
    .get()
    ?.result?.runtimes?.find((r) => r.id === runtime);
  if (!row) return;
  const last = attempted.get(runtime);
  if (last && !runtimeLive(runtime)) {
    if (last.error !== undefined)
      setPhase(runtime, { state: "failed", detail: last.error });
    return;
  }
  void ask(row);
}

/** The failed chip's Retry: forget the refusal and ask again. */
export function retryRuntimeCatalog(runtime: string): void {
  attempted.delete(runtime);
  liveRetries.delete(runtime);
  askForScreen(runtime);
}

const sync = () => {
  const rows = relay.status.get()?.result?.runtimes;
  if (!rows?.length) return;
  /* Only a runtime an agent runs on AND that is already running is
     asked — `models.list` lazy-starts the adapter (D-#761), so asking
     every hired row would spawn idle hires' engines at boot (D-#866).
     A runtime started by real work changes its status row, which asks
     again. A screen open on an idle runtime asks once (D-#899) — here
     only when its row arrived after the screen opened. */
  const inUse = new Set(
    relay.employees.get().flatMap((e) => (e.runtime ? [e.runtime] : [])),
  );
  // The first row is the default engine — its catalog is the global one.
  for (const r of rows.slice(1)) {
    if (r.available !== false && inUse.has(r.id) && runtimeLive(r.id))
      void ask(r);
    else if (mounted.has(r.id) && !attempted.has(r.id)) askForScreen(r.id);
  }
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
