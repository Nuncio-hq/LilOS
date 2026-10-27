import type { RuntimeStatusRow } from "@lilos/contracts/app";
import type { ModelOption, ModelsListResult } from "@lilos/contracts/engine";
import type { ModelChoice, V3Runtime, V3Tone } from "@lilos/ui";
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
   now, so the key the attempt is remembered under carries them. */
const attempted = new Map<string, string>();

const signatureOf = (r: RuntimeStatusRow): string =>
  `${r.available ?? "?"}:${r.state ?? ""}:${r.detail ?? ""}`;

async function ask(r: RuntimeStatusRow): Promise<void> {
  const key = signatureOf(r);
  if (attempted.get(r.id) === key) return;
  attempted.set(r.id, key);
  try {
    const res: ModelsListResult = await relay.listModels({ runtime: r.id });
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
  }
}

onMount(catalogs, () => {
  const sync = () => {
    const rows = relay.status.get()?.result?.runtimes;
    if (!rows?.length) return;
    /* Only a runtime an agent actually runs on is asked — `models.list`
       lazy-starts the adapter (D-#761), so asking every registered row
       would spawn uninstalled hires' engines at boot. */
    const inUse = new Set(
      relay.employees.get().flatMap((e) => (e.runtime ? [e.runtime] : [])),
    );
    // The first row is the default engine — its catalog is the global one.
    for (const r of rows.slice(1))
      if (r.available !== false && inUse.has(r.id)) void ask(r);
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
          ...(i === 0 ? {} : { tone: runtimeTone(r.id) }),
        };
      }),
  );
  return store;
}

/** A coding runtime's avatar tone (#872): known ids keep their
    brand-adjacent colour, a new one hashes to a stable pastel — never
    "n" (that is the gone-agent look). */
const RUNTIME_TONE: Record<string, V3Tone> = {
  "acp:devin": "b",
  "acp:claude": "m",
};
const TONES: V3Tone[] = ["c", "b", "r", "m", "s", "d"];
export function runtimeTone(id: string): V3Tone {
  const known = RUNTIME_TONE[id];
  if (known) return known;
  let x = 0;
  for (const ch of id.toLowerCase())
    x = (Math.imul(x, 31) + ch.charCodeAt(0)) >>> 0;
  return TONES[x % TONES.length];
}

/** The runtime id `models.list`/`agents.*` route by, or undefined for the
    default engine — the roster's first row is the default (D-#761). */
export const defaultRuntimeId = (): string | undefined =>
  relay.status.get()?.result?.runtimes?.[0]?.id;

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

/** The profile fields a runtime lets the app write — the status row's
    `agentsUpdatable`; [] while the runtime hasn't been described. */
export function updatableFor(runtime: string | undefined): string[] {
  if (!runtime) return [];
  return (
    relay.status.get()?.result?.runtimes?.find((r) => r.id === runtime)
      ?.agentsUpdatable ?? []
  );
}

/** A model id's readable form when its runtime's catalog is unknown:
    "swe-2-high" reads "Swe-2-high" only as a last resort — the catalog
    almost always lands. */
function prettifyModelId(id: string): string {
  return id.slice(0, 1).toUpperCase() + id.slice(1);
}
