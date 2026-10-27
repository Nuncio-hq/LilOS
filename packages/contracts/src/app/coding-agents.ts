import { z } from "zod";

import type { Employee } from "./domain.js";

/**
 * The user's default model + effort per outside coding agent (#835, D-#835):
 * the **Employee record** (`model`, `effort`) of the agent that runs it is
 * the one source — the agent page edits it, sessions and task hand-offs
 * read it, and agents read it through `coding_agents` and propose changes
 * through `coding_agents_set` (approval-gated like every write beyond the
 * session's own thread, D-#341). A missing agent or field means "the
 * runtime's own default". The legacy `codingAgents` KV row is migrated onto
 * the records once (relay migration) and never read again.
 */

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

/** Per-agent defaults as `coding_agents` reports them; absent entries mean the runtime default. */
export const CodingAgentsSetting = z.strictObject({
  claude: CodingAgentDefaults.optional(),
  cursor: CodingAgentDefaults.optional(),
  devin: CodingAgentDefaults.optional(),
  antigravity: CodingAgentDefaults.optional(),
});
export type CodingAgentsSetting = z.infer<typeof CodingAgentsSetting>;

/** The coding agent an employee is, by its engine handle (`profile`, else
 *  its name) — "devin" for a Devin hire. Anyone else gets undefined. */
export function codingAgentOf(
  employee: Pick<Employee, "profile" | "name">,
): CodingAgentId | undefined {
  const id = CodingAgentId.safeParse(
    (employee.profile || employee.name).toLowerCase(),
  );
  return id.success ? id.data : undefined;
}

/** The roster's coding agents with a pin, as the tool reports them. */
export function codingAgentsOf(
  employees: readonly Employee[],
): CodingAgentsSetting {
  const out: CodingAgentsSetting = {};
  for (const e of employees) {
    const id = codingAgentOf(e);
    if (!id || out[id]) continue;
    const d: CodingAgentDefaults = {
      ...(e.model ? { model: e.model } : {}),
      ...(e.effort ? { effort: e.effort } : {}),
    };
    if (d.model || d.effort) out[id] = d;
  }
  return out;
}
