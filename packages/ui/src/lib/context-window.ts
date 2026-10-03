import { sessionChoice } from "../chat/model-picker";
import type { ModelOption, Thread, Usage } from "../types";

/* The context meter's one source of truth (issue #294): every surface —
   the DM thread panel, Focus, and the phone's mirror in
   packages/ui-native — resolves the session's model and its window through
   the same rules, so one session can never show two percentages. The
   window itself is ENGINE-REPORTED: on the turn's usage (the resolved
   window, config pins already folded in) or the model's catalog row. Only
   when an engine reports neither does a clearly-labelled estimate show
   (`~`, `estimated: true`) — the last-resort guess from before #294, kept
   for engines that say nothing. */

/** The window shown when the engine reports nothing and the id gives no hint. */
export const FALLBACK_CONTEXT_WINDOW = 200_000;

/** The session's model id, resolved exactly like the composer picker
    (`sessionChoice`): the session's own pick, then the lead employee's,
    then the engine default / catalog head. */
export function sessionModelId(
  thread: Pick<Thread, "model" | "provider" | "effort" | "fast">,
  leadModel: string | undefined,
  models?: ModelOption[],
  defaultModel?: string,
  defaultProvider?: string,
): string | undefined {
  return (
    sessionChoice(
      thread,
      leadModel,
      models ?? [],
      defaultModel,
      defaultProvider,
    ).model || undefined
  );
}

/** The meter's numerator (issue #415): the engine's CURRENT occupancy
    report when it sends one (Hermes `context_used`), else the pre-#415
    sum of the last turn's in+out — the only context signal those engines
    emit. `input`/`output` alone are lifetime throughput: summed over every
    tool-loop call they outgrow the window (the 123.2% bug). */
export function contextUsedOf(
  usage: Pick<Usage, "input" | "output" | "context"> | undefined,
): number {
  return usage?.context ?? (usage?.input ?? 0) + (usage?.output ?? 0);
}

/** The share of the window the meter fills — clamped: a stale or estimated
    numerator can overshoot the window, but the UI never reads past 100%
    (#415 AC-3). */
export function contextShare(used: number, max: number): number {
  return max > 0 ? Math.min(1, Math.max(0, used / max)) : 0;
}

/** True when the context is at/over the window — the meter's "Full" state. */
export function contextFull(used: number, max: number): boolean {
  return max > 0 && used >= max;
}

/** The window a session's meter divides by: the engine's report on the
    turn's usage first (it is the resolved window — a config pin or variant
    can differ from the catalog row), then the session model's catalog row,
    then the pre-#294 prefix heuristic, flagged `estimated` so the meter
    labels it `~` rather than presenting a guess as engine truth. */
export function contextWindowOf(
  usage: Usage | undefined,
  model: string | undefined,
  models?: ModelOption[],
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
