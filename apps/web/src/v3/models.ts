import {
  isHidden,
  type ModelChoice,
  type ModelOption,
  type ModelVisibility,
} from "@lilos/ui";
import { computed, type ReadableAtom } from "nanostores";
import {
  engineDefaultModel,
  engineDefaultProvider,
  engineModels,
  modelVisibility,
} from "../lib/runtime";

/* The pickers show a model as one label ("Opus 5.5"); the engine needs
   `{provider?, id}` (D-#8, an id is opaque and unique only per provider).
   This module is the one place that turns a label back into a real pick, so
   no screen keeps its own table: the catalog the engine reports, minus what
   Settings hides, is the whole truth (D-#85: LilOS names no model). */

const nameOf = (m: ModelOption): string => m.name ?? m.id;

export interface ModelRow {
  label: string;
  option: ModelOption;
}

/** The visible catalog as picker rows; a label two models share gets its
    provider appended so each row stays one distinct choice. */
export function modelRows(
  catalog: readonly ModelOption[],
  visibility: ModelVisibility,
): ModelRow[] {
  const shown = catalog.filter((m) => !isHidden(m, visibility));
  const count = new Map<string, number>();
  for (const m of shown) count.set(nameOf(m), (count.get(nameOf(m)) ?? 0) + 1);
  return shown.map((option) => ({
    option,
    label:
      (count.get(nameOf(option)) ?? 0) > 1 && option.provider
        ? `${nameOf(option)} · ${option.provider}`
        : nameOf(option),
  }));
}

export const pickOf = (o: ModelOption): ModelChoice => ({
  model: o.id,
  ...(o.provider !== undefined ? { provider: o.provider } : {}),
});

let rows: ReadableAtom<ModelRow[]> | undefined;
/** The picker rows as a store (built on first read: the catalog atoms are
    plain module atoms, but readers mount after boot). */
export function modelRowStore(): ReadableAtom<ModelRow[]> {
  rows ??= computed([engineModels, modelVisibility], modelRows);
  return rows;
}

/** The label a stored model id shows as: the picker's own label for it
    (`modelRows`, so a name two providers share carries its provider here
    too, or the page's model field would match no picker option). An id the
    catalog doesn't know shows as itself; one Settings hides shows its bare
    name. An empty id is the engine's default: its label when the catalog
    names one, else "Engine default". `provider` disambiguates ids shared by
    providers. */
export function modelLabel(id: string | undefined, provider?: string): string {
  const catalog = engineModels.get();
  const want = id || engineDefaultModel.get();
  if (!want) return "Engine default";
  const defaultProvider = id ? provider : engineDefaultProvider.get();
  const hit =
    catalog.find((m) => m.id === want && m.provider === defaultProvider) ??
    catalog.find((m) => m.id === want);
  if (!hit) return want;
  return (
    modelRowStore()
      .get()
      .find((r) => r.option === hit)?.label ?? nameOf(hit)
  );
}

/** The real pick behind a picker label; undefined = the engine's default
    (a label that names no catalog row, such as "Engine default"). */
export function pickFromLabel(label: string): ModelChoice | undefined {
  const row = modelRows(engineModels.get(), modelVisibility.get()).find(
    (r) => r.label === label,
  );
  return row ? pickOf(row.option) : undefined;
}
