import { isHidden, type ModelOption, type ModelProvider, type ModelVisibility, type V3Settings } from "@lilos/ui/v3-data"

/* ?v3 mock: the engine's model catalog, as the full picker in a new chat and
   Settings → Engine & models both read it. One source: what Edit models hides
   in the picker is what Settings shows switched off, and the other way round. */

export const MODEL_OPTIONS: ModelOption[] = [
  { id: "opus", name: "Opus 5.5", provider: "anthropic", efforts: ["low", "medium", "high"], defaultEffort: "high", fast: true },
  { id: "sonnet", name: "Sonnet 5", provider: "anthropic", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { id: "haiku", name: "Haiku 5", provider: "anthropic", fast: true },
  { id: "gpt", name: "GPT-6", provider: "openai", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  /* Helper runtimes' own models (D-#847): a Devin/Cursor/Antigravity helper
     thread's composer chip reads the model its agent actually runs — the
     shared catalog knows them so the chip can, but the picker hides them. */
  { id: "swe-2", name: "SWE-2", provider: "devin", efforts: ["low", "medium", "high"], defaultEffort: "high" },
  { id: "composer", name: "Composer 1", provider: "cursor", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { id: "gemini", name: "Gemini 3 Pro", provider: "google", efforts: ["low", "medium", "high"], defaultEffort: "high" },
]

export const MODEL_PROVIDERS: ModelProvider[] = [
  { id: "anthropic", name: "Anthropic" },
  { id: "openai", name: "OpenAI" },
  { id: "devin", name: "Devin" },
  { id: "cursor", name: "Cursor" },
  { id: "google", name: "Google" },
]

/** GPT-6 and the helper runtimes' models start hidden: the prototype's
   company runs on Anthropic models. */
export const MODEL_VISIBILITY: ModelVisibility = {
  providers: [],
  models: ["openai::gpt", "devin::swe-2", "cursor::composer", "google::gemini"],
}

/** A model's key in a visibility list (ids are unique only per provider). */
export const modelKey = (m: Pick<ModelOption, "id" | "provider">) => `${m.provider ?? ""}::${m.id}`

/** The catalog as Settings switches: one row per model, on unless hidden. */
export function settingsModels(options: ModelOption[], providers: ModelProvider[], visibility: ModelVisibility): V3Settings["models"] {
  return options.map((o) => ({
    id: modelKey(o),
    label: o.name ?? o.id,
    on: !isHidden(o, visibility),
    group: providers.find((p) => p.id === o.provider)?.name ?? o.provider,
  }))
}

/** The id of the catalog model a picker label names ("Opus 5.5 · High" → "opus"). */
export const modelIdOf = (options: ModelOption[], label: string) => options.find((o) => (o.name ?? o.id) === label.split(" · ")[0])?.id

/** The hide list that makes the catalog read as Settings' switches say. */
export const visibilityOf = (models: V3Settings["models"], options: ModelOption[]): ModelVisibility => ({
  providers: [],
  models: options.map(modelKey).filter((k) => models.some((m) => m.id === k && !m.on)),
})
