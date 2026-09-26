import { z } from "zod";

/**
 * `models` capability — the model picker: list what the engine can run and
 * pin a session's model for its next turn.
 */
export const ModelOption = z.object({
  /** Model id accepted by `session.start.model` and `session.setModel`. */
  id: z.string().min(1),
  /** Display name, when the engine has a friendlier label than the id. */
  name: z.string().optional(),
  /** Provider slug, for engines that are multi-provider. */
  provider: z.string().optional(),
  /** Engine-owned extras (context size, capabilities, pricing, ...). */
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type ModelOption = z.infer<typeof ModelOption>;

const SessionId = z.string().min(1);

// ── models.list ─────────────────────────────────────────────────────────────
export const ModelsListParams = z.strictObject({});
export type ModelsListParams = z.infer<typeof ModelsListParams>;

export const ModelsListResult = z.object({
  models: z.array(ModelOption),
  /** The engine's default model id, when it has one. */
  default: z.string().optional(),
});
export type ModelsListResult = z.infer<typeof ModelsListResult>;

// ── session.setModel ────────────────────────────────────────────────────────
export const SessionSetModelParams = z.strictObject({
  sessionId: SessionId,
  /** Model id from `models.list`. */
  model: z.string().min(1),
});
export type SessionSetModelParams = z.infer<typeof SessionSetModelParams>;

export const SessionSetModelResult = z.object({
  /** The model now pinned on the session (engines may canonicalize ids). */
  model: z.string().min(1),
});
export type SessionSetModelResult = z.infer<typeof SessionSetModelResult>;
