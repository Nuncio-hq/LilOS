import type { AcpLaunchSpec } from "../src/launch.js";
import { probeAgentCommand, resolveAgentCommand } from "../src/provision.js";
import { claudeSpec } from "./claude.js";
import { devinSpec } from "./devin.js";

/**
 * D-#845: the curated registry (the local stand-in for T3's remote ACP
 * registry): known agents the launcher can name — verified install recipe
 * + shim, no credential storage. The remote ACP registry is a later slice;
 * the table is where its entries will land.
 *
 * D-#761: lives under `shims/` (never `src/` — the no-agent-branch guard
 * holds) and is exported so the harness's runtime catalog can enumerate
 * the same ids `--agent` accepts and probe each install before offering
 * it as a hirable runtime — one table, two readers.
 */
export const ACP_AGENTS: Record<string, AcpLaunchSpec> = {
  devin: devinSpec,
  claude: claudeSpec,
};

/**
 * D-#761: install check for the runtime catalog — resolve the recipe's
 * launch command from what is already usable (a PATH binary at/above
 * the pin, or an already-provisioned cache entry), then run it with
 * the verify args; exit 0 means hirable. The probe NEVER fetches
 * (r10 — a boot probe that provisioned acp:claude into every e2e
 * stack's scratch HOME filled the runner's quota): a not-installed
 * recipe reports unavailable until a real launch provisions it.
 */
export async function probeAcpSpec(
  spec: AcpLaunchSpec,
  env?: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string }> {
  return probeAgentCommand(spec, env);
}

/**
 * D-#866 r6: resolve + provision WITHOUT the verify probe — the harness
 * runs it in its own process BEFORE launching the engine child, so a
 * cold npm install eats the harness's demand wait rather than the
 * launcher/startup timeout inside serve.ts (whose own resolve then
 * hits a warm cache). The engine child's launch check stays — this is
 * the budget fix, not a skip.
 */
export async function resolveAcpSpec(
  spec: AcpLaunchSpec,
  env?: NodeJS.ProcessEnv,
) {
  return resolveAgentCommand(spec, env);
}
