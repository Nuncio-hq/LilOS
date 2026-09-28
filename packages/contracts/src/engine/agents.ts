import { z } from "zod";

/**
 * `agents` capability — the engine's hireable personas (its profile/agent
 * concept). `id` is the stable handle `session.start.agent` and
 * `agents.describe.id` take. There is deliberately no delete method: LilOS
 * never removes an engine profile — "firing" only removes the LilOS
 * employee record, the engine's profile stays put.
 *
 * `agents.update` writes persona fields back to the engine. Which fields an
 * engine accepts is declared on the capability descriptor as
 * `detail.updatable` — a list of `AgentDescriptor` field names like
 * `["soul", "model"]`; the Edit dialog renders only those controls (D-#19).
 * Engines reject a field they did not list with INVALID_PARAMS.
 */
export const AgentDescriptor = z.object({
  /** Stable engine-side id. */
  id: z.string().min(1),
  /** Display name for the hire dialog / employee card. */
  name: z.string().min(1),
  description: z.string().optional(),
  /** The agent's engine-pinned default model id, when it sets one. */
  model: z.string().optional(),
  /** Installed skill count, when the engine tracks skills per agent. */
  skillCount: z.int().min(0).optional(),
  /**
   * Persona text (the agent's charter). `agents.describe` carries it —
   * `agents.list` may omit it to keep the roster light. Writable over the
   * wire via `agents.update` when the capability lists `"soul"` in
   * `detail.updatable` (#123).
   */
  soul: z.string().optional(),
  /** Engine-owned extras (provider, avatar flags, ...); opaque to clients. */
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type AgentDescriptor = z.infer<typeof AgentDescriptor>;

// ── agents.list ─────────────────────────────────────────────────────────────
export const AgentsListParams = z.strictObject({});
export type AgentsListParams = z.infer<typeof AgentsListParams>;

export const AgentsListResult = z.object({
  agents: z.array(AgentDescriptor),
});
export type AgentsListResult = z.infer<typeof AgentsListResult>;

// ── agents.describe ─────────────────────────────────────────────────────────
export const AgentsDescribeParams = z.strictObject({
  /** Agent id from `agents.list` / `agents.create`. */
  id: z.string().min(1),
});
export type AgentsDescribeParams = z.infer<typeof AgentsDescribeParams>;

export const AgentsDescribeResult = z.object({
  agent: AgentDescriptor,
});
export type AgentsDescribeResult = z.infer<typeof AgentsDescribeResult>;

// ── agents.create ───────────────────────────────────────────────────────────
export const AgentsCreateParams = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  /** Persona text to seed the profile with. */
  soul: z.string().optional(),
  /** Model id to pin on the new agent (from `models.list`). */
  model: z.string().optional(),
  /** Engine-specific create options (clone sources, provider ids, ...). */
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type AgentsCreateParams = z.infer<typeof AgentsCreateParams>;

export const AgentsCreateResult = z.object({
  /** The registered agent as `agents.list` now reports it. */
  agent: AgentDescriptor,
});
export type AgentsCreateResult = z.infer<typeof AgentsCreateResult>;

// ── agents.update ───────────────────────────────────────────────────────────
export const AgentsUpdateParams = z.strictObject({
  /** Agent id from `agents.list` / `agents.create` / `agents.describe`. */
  id: z.string().min(1),
  /** New display name — only where `detail.updatable` lists "name". */
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  /** New persona text. An empty string clears the persona. */
  soul: z.string().optional(),
  /**
   * New default model id (from `models.list`) — applies to sessions started
   * AFTER this call; running sessions keep the model they started with.
   * `provider/model` refs are allowed for multi-provider engines.
   */
  model: z.string().optional(),
  /** Provider slug for multi-provider engines, paired with `model`. */
  provider: z.string().optional(),
  /**
   * Force a guarded model pin: when the engine answers `confirmModel`, the
   * client re-sends the same update with this set once the user confirms.
   */
  confirmModel: z.boolean().optional(),
  /** Engine-specific update options; opaque to generic clients. */
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type AgentsUpdateParams = z.infer<typeof AgentsUpdateParams>;

export const AgentsUpdateResult = z.object({
  /** The agent as `agents.describe` now reports it. */
  agent: AgentDescriptor,
  /**
   * Set when the engine declined the model pin pending a user confirm — the
   * value is the engine's own warning/question text. Other fields may have
   * been written already; re-send the same params plus `confirmModel: true`
   * to force the model write.
   */
  confirmModel: z.string().optional(),
});
export type AgentsUpdateResult = z.infer<typeof AgentsUpdateResult>;
