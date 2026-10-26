import type { AcpLaunchSpec } from "../src/launch.js";
import { probeAgentCommand } from "../src/provision.js";
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
 * launch command (an installed binary on PATH, else the spec's
 * provisioned distribution per D-#866), then run it with the verify
 * args; exit 0 means hirable. A provisioning failure — offline, no
 * runtime, no installer — lands on the status row's detail line.
 */
export async function probeAcpSpec(
  spec: AcpLaunchSpec,
  env?: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string }> {
  return probeAgentCommand(spec, env);
}
