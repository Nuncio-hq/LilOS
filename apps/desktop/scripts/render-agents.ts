import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LILOS_AGENTS,
  plistFileName,
  renderLaunchAgentPlist,
} from "@lilos/background";

/**
 * Emits the launch-agent plists the bundle registers. Single source of truth:
 * the specs in @lilos/background (labels, BundleProgram, log paths) — the
 * plists are generated, never hand-edited.
 */

const outDir =
  process.argv[2] ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "build", "launchagents");

mkdirSync(outDir, { recursive: true });
for (const agent of LILOS_AGENTS) {
  const file = join(outDir, plistFileName(agent));
  writeFileSync(file, renderLaunchAgentPlist(agent));
  console.log(`wrote ${file}`);
}
