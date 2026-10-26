import { z } from "zod";

/**
 * Oscar's default model + effort per outside coding agent (#835, D-#835):
 * one LilOS-owned record in the settings KV so it survives plugin recopies
 * and is shared by every session and surface. Agents read it through
 * `coding_agents` and propose changes through `coding_agents_set`
 * (approval-gated like every write beyond the session's own thread,
 * D-#341); the generic `settings.*` KV stays non-agent-facing. A missing
 * agent or field means "the CLI's own default" — the hand-off skills ship
 * in the `lilos` engine plugin and pass flags only for values stored here.
 */
export const CODING_AGENTS_SETTING_KEY = "codingAgents";

export const CODING_AGENT_IDS = [
  "claude",
  "cursor",
  "devin",
  "antigravity",
] as const;
export const CodingAgentId = z.enum(CODING_AGENT_IDS);
export type CodingAgentId = z.infer<typeof CodingAgentId>;

/** One agent's stored choice — the CLI flag values verbatim. */
export const CodingAgentDefaults = z.strictObject({
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
});
export type CodingAgentDefaults = z.infer<typeof CodingAgentDefaults>;

/** The `codingAgents` KV value; absent entries mean CLI defaults. */
export const CodingAgentsSetting = z.strictObject({
  claude: CodingAgentDefaults.optional(),
  cursor: CodingAgentDefaults.optional(),
  devin: CodingAgentDefaults.optional(),
  antigravity: CodingAgentDefaults.optional(),
});
export type CodingAgentsSetting = z.infer<typeof CodingAgentsSetting>;

/** A raw KV value into the stored shape; junk yields the empty map rather
 *  than leaking a malformed row to the hand-off skills. */
export function parseCodingAgents(value: unknown): CodingAgentsSetting {
  const parsed = CodingAgentsSetting.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/** One agent's patch: `null` clears a field, absent leaves it. An entry
 *  with no fields left is dropped so the stored map stays sparse. */
export function applyCodingAgentPatch(
  current: CodingAgentsSetting,
  agent: CodingAgentId,
  patch: { model?: string | null; effort?: string | null },
): CodingAgentsSetting {
  const next: CodingAgentDefaults = { ...(current[agent] ?? {}) };
  if (patch.model !== undefined) {
    if (patch.model === null) delete next.model;
    else next.model = patch.model;
  }
  if (patch.effort !== undefined) {
    if (patch.effort === null) delete next.effort;
    else next.effort = patch.effort;
  }
  const out = { ...current };
  if (!next.model && !next.effort) delete out[agent];
  else out[agent] = next;
  return out;
}
