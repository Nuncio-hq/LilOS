import { z } from "zod";

/**
 * `models` capability — the model picker: list what the engine can run and
 * pin a session's model for its next turn.
 */
export const ModelOption = z.object({
  /** Model id accepted by `session.start.model` and `session.setModel`. An id
      may itself contain `/` (e.g. `devin/claude-opus-5`) — it is opaque, never
      split or rejoined into `provider/model`. */
  id: z.string().min(1),
  /** Display name, when the engine has a friendlier label than the id. */
  name: z.string().optional(),
  /** Provider slug, for engines that are multi-provider. */
  provider: z.string().optional(),
  /** Ordered low→high reasoning-effort levels the engine reports for THIS
      model; absent means no reasoning control. Engines that can't report a
      per-model list pass their full ladder when the model is reasoning-capable
      — the UI never probes or guesses. */
  efforts: z.array(z.string()).optional(),
  /** The model's default effort when the engine names one. */
  defaultEffort: z.string().optional(),
  /** The model has a fast/priority tier the engine can switch on. */
  fast: z.boolean().optional(),
  /** Engine-owned extras (context size, capabilities, pricing, ...). */
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type ModelOption = z.infer<typeof ModelOption>;

/** A provider row in a multi-provider engine's catalog (display data for
    grouped pickers; single-provider engines may omit the whole field). */
export const ModelProvider = z.object({
  /** Provider slug — the same value `ModelOption.provider` carries. */
  id: z.string().min(1),
  /** Display name ("Anthropic – CLIProxyAPI"), when the engine names it. */
  name: z.string().optional(),
});
export type ModelProvider = z.infer<typeof ModelProvider>;

const SessionId = z.string().min(1);

// ── models.list ─────────────────────────────────────────────────────────────
export const ModelsListParams = z.strictObject({
  /** Re-probe the engine's catalog instead of answering from its cache.
      Engines without a refresh path ignore it. */
  refresh: z.boolean().optional(),
});
export type ModelsListParams = z.infer<typeof ModelsListParams>;

export const ModelsListResult = z.object({
  models: z.array(ModelOption),
  /** The engine's default model id, when it has one. */
  default: z.string().optional(),
  /** The provider `default` belongs to — ids are only unique per provider
      on multi-provider engines (issue #92). */
  defaultProvider: z.string().optional(),
  /** Provider rows for grouped pickers, in the engine's own order. */
  providers: z.array(ModelProvider).optional(),
});
export type ModelsListResult = z.infer<typeof ModelsListResult>;

// ── session.setModel ────────────────────────────────────────────────────────
export const SessionSetModelParams = z.strictObject({
  sessionId: SessionId,
  /** Model id from `models.list`. */
  model: z.string().min(1),
  /** Provider slug when the same id exists under several providers. */
  provider: z.string().optional(),
  /** Reasoning-effort level from the model's `efforts` list. Absent = no
      effort override — the session keeps the engine's configured level. */
  effort: z.string().optional(),
  /** Fast/priority tier on (`true`) or off (`false`); absent keeps the
      session's current tier. */
  fast: z.boolean().optional(),
});
export type SessionSetModelParams = z.infer<typeof SessionSetModelParams>;

export const SessionSetModelResult = z.object({
  /** The model now pinned on the session (engines may canonicalize ids). */
  model: z.string().min(1),
  provider: z.string().optional(),
  effort: z.string().optional(),
  fast: z.boolean().optional(),
  /** True when the engine deferred the switch to the next turn (a turn is
      streaming); the pin still lands — the session just hasn't swapped yet. */
  deferred: z.boolean().optional(),
});
export type SessionSetModelResult = z.infer<typeof SessionSetModelResult>;
