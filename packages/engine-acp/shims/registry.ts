import type { AcpLaunchSpec } from "../src/launch.js";
import { probeExecutable, resolveExecutable } from "../src/launch.js";
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
 * binary on PATH, then run `<bin> <verifyArgs>`; exit 0 means hirable.
 * Returns the verify output for the status row's detail line.
 */
export async function probeAcpSpec(
  spec: AcpLaunchSpec,
  env?: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string }> {
  const [program] = spec.command;
  if (!program) return { ok: false, output: "empty launch command" };
  const bin = resolveExecutable(program, env);
  if (!bin) return { ok: false, output: `${program} not on PATH` };
  return probeExecutable(bin, spec.verify?.args ?? ["--version"], {
    ...(env ? { env } : {}),
    ...(spec.verify?.timeoutMs ? { timeoutMs: spec.verify.timeoutMs } : {}),
  });
}
