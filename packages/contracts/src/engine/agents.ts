import { z } from "zod";

/**
 * `agents` capability — the engine's hireable personas (its profile/agent
 * concept). `id` is the stable handle `session.start.agent` and
 * `agents.describe.id` take. There is deliberately no delete method: LilOS
 * never removes an engine profile — "firing" only removes the LilOS
 * employee record, the engine's profile stays put.
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
   * `agents.list` may omit it to keep the roster light. Read-only over the
   * wire: editing personas is an engine surface, not a LilOS one.
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
