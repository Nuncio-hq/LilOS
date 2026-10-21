import type { ModelChoice, V3Data } from "@lilos/ui"
import { modelIdOf } from "../fake-v3-models"

/* A thread's model is a picker label in the mock ("Opus 5.5 · High"); the real
   view reads the pick as a model id, a provider, an effort and Fast. */

/** The pick a label names, in the catalog's terms; empty fields when it names none. */
export function modelPick(data: V3Data, label: string | undefined): Partial<ModelChoice> {
  const options = data.modelCatalog?.options ?? []
  const id = label ? modelIdOf(options, label) : undefined
  const option = options.find((o) => o.id === id)
  const effort = (label ?? "").split(" · ")[1]
  const lower = effort?.toLowerCase()
  return {
    model: id,
    provider: option?.provider,
    effort: lower && option?.efforts?.includes(lower) ? lower : undefined,
    fast: effort === "Fast" || undefined,
  }
}

/** The label a pick shows: the model's name, its effort and Fast. */
export function pickLabel(data: V3Data, c: ModelChoice): string {
  const o = data.modelCatalog?.options.find((x) => x.id === c.model && (c.provider === undefined || x.provider === c.provider))
  const effort = c.effort ? c.effort.charAt(0).toUpperCase() + c.effort.slice(1) : undefined
  return [o?.name ?? c.model, effort, c.fast && "Fast"].filter(Boolean).join(" · ")
}
