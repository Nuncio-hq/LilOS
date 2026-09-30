import type { ModelPick, ModelRow, ModelVisibility } from "./types";

export type { ModelPick, ModelRow, ModelVisibility } from "./types";

const EFFORT: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
export const effortLabel = (e: string) =>
  EFFORT[e] ?? e.charAt(0).toUpperCase() + e.slice(1);

/* The mobile model picker's rules — the twins of the web's
   (packages/ui/src/chat/model-picker.tsx + model-visibility-dialog.tsx),
   held pure (no react-native) so apps can unit-test them and the sheet
   stays a renderer. */

/** The hide-list key the Mac's "Edit models" writes: `${provider}::${id}`. */
export function modelKeyOf(m: { id: string; provider?: string }): string {
  return `${m.provider ?? ""}::${m.id}`;
}

/** A hidden provider hides every model it owns; a hidden key hides one
    (web `isHidden`). Absent list = nothing hidden. */
export function isModelHidden(
  m: { id: string; provider?: string },
  v?: ModelVisibility,
): boolean {
  if (!v) return false;
  return (
    (!!m.provider && v.providers.includes(m.provider)) ||
    v.models.includes(modelKeyOf(m))
  );
}

/** Provider-aware row lookup (web `findModel`): a bare pick matches the
    first row with the id; a pinned provider narrows it. */
export function findModel(
  models: readonly ModelRow[],
  pick: { model: string; provider?: string },
): ModelRow | undefined {
  return models.find(
    (m) =>
      m.id === pick.model &&
      (pick.provider === undefined || m.provider === pick.provider),
  );
}

/**
 * The rows the picker may show (web `shown`): the engine catalog minus the
 * shared hide list, plus the session's own pick kept visible even when it's
 * hidden or absent from the catalog (merged in as `notInList` like
 * `withSessionModel` — the picker always shows the model the session runs).
 */
export function pickableModels(
  models: readonly ModelRow[],
  visibility?: ModelVisibility,
  current?: ModelPick,
): ModelRow[] {
  const merged = [...models];
  if (current?.model && !findModel(merged, current)) {
    merged.push({
      id: current.model,
      name: current.model,
      provider: current.provider ?? "",
      notInList: true,
    });
  }
  const cur = current ? findModel(merged, current) : undefined;
  return merged.filter(
    (m) => m.notInList || !isModelHidden(m, visibility) || m === cur,
  );
}

/**
 * The effort in effect (web `defaultEffort` + the pick's validated value):
 * the pick's rung when the ladder has it, else the model's own declared
 * default — also validated, never a level the engine didn't report. A model
 * with a ladder but nothing valid picked shows "Engine default" — LilOS
 * doesn't invent a rung.
 */
export function effortOf(
  pick: { effort?: string },
  row?: ModelRow,
): string | undefined {
  const efforts = row?.efforts ?? [];
  if (pick.effort && efforts.includes(pick.effort)) return pick.effort;
  return row?.defaultEffort && efforts.includes(row.defaultEffort)
    ? row.defaultEffort
    : undefined;
}

/**
 * The slider's thumb index (web `idx`): the picked rung, or parked at the
 * middle of the ladder while "Engine default" is in effect — a display
 * position only, no effort is implied.
 */
export function effortIndex(
  effort: string | undefined,
  efforts: readonly string[],
): number {
  return effort && efforts.includes(effort)
    ? efforts.indexOf(effort)
    : Math.floor(Math.max(efforts.length - 1, 0) / 2);
}

/**
 * Tapping a model row -> the next pick (web `applyPick`): provider stamped
 * so a shared id under two providers pins the right one, the current effort
 * kept when the new ladder has it (else the target's own default), and an
 * explicit `fast: false` — not a dropped field — when the target has no
 * fast tier, since engines that retain the tier across a switch must be
 * told it's off (#92 AC-3).
 */
export function nextModelPick(
  cur: { effort?: string; fast?: boolean },
  row: ModelRow,
): ModelPick {
  const effort = effortOf(cur, row);
  return {
    model: row.id,
    ...(row.provider ? { provider: row.provider } : {}),
    ...(effort !== undefined ? { effort } : {}),
    fast: !!(row.fast && cur.fast),
  };
}

/** Composer chip: "Opus 5.5 · High". The rung shown is the effort in effect
   (validated against the row's ladder, declared default included) — not a
   stale rung the pick may carry; an off-catalog pick keeps its raw effort
   since there's no ladder to check it against. */
export function modelLabel(models: readonly ModelRow[], p: ModelPick) {
  const m = findModel(models, p);
  const name = (m?.name ?? p.model).replace(/^Claude /, "");
  const effort = m ? effortOf(p, m) : p.effort;
  return effort ? `${name} · ${effortLabel(effort)}` : name;
}

/** The window shown when the engine reports nothing and the id gives no hint
    (web `FALLBACK_CONTEXT_WINDOW`). */
export const FALLBACK_CONTEXT_WINDOW = 200_000;

/**
 * The window a session's meter divides by — the twin of the web's
 * `contextWindowOf` (packages/ui/src/lib/context-window.ts, #294): the
 * engine's report on the session's usage first (the resolved window — a
 * config pin can differ from the catalog row), then the session model's
 * catalog row, then the pre-#294 prefix heuristic, flagged `estimated` so
 * the meter labels it `~` rather than showing a guess as engine truth.
 */
export function contextWindowOf(
  usage: { contextWindow?: number } | undefined,
  model: string | undefined,
  models?: readonly ModelRow[],
): { tokens: number; estimated: boolean } {
  if (usage?.contextWindow)
    return { tokens: usage.contextWindow, estimated: false };
  const row = models?.find((m) => m.id === model);
  if (row?.contextWindow)
    return { tokens: row.contextWindow, estimated: false };
  return {
    tokens: model?.startsWith("qwen") ? 262_000 : FALLBACK_CONTEXT_WINDOW,
    estimated: true,
  };
}
