import type { AcpLaunchSpec } from "../src/launch.js";

/**
 * D-#845 — the Devin shim: everything the generic ACP seam needs to run
 * `devin acp`, kept out of src/ so the no-agent-branch guard stays green.
 *
 * Devin's CLI is installed and signed in by the user (`~/.local/bin/devin`
 * on this Mac) — LilOS stores no credentials; the CLI's own login carries
 * the session. Commands run through client-side terminals: Devin sends
 * shell source in `command` (no argv), so `shellCommands` is on and the
 * client advertises `terminal: true` (T3's devinAcp.ts does the same).
 *
 * Modes the agent advertises: `accept-edits` (Code), `smart`, `ask`,
 * `plan`, `bypass` (Bypass Permissions). LilOS access maps onto that
 * vocabulary here — `ask` keeps coding but routes permission asks to
 * LilOS (`accept-edits`); `full` runs unattended (`bypass`).
 */
export const devinSpec: AcpLaunchSpec = {
  id: "devin",
  command: ["devin", "acp"],
  verify: { args: ["--version"], timeoutMs: 15_000 },
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: true,
  },
  terminals: { shellCommands: true },
  modeForAccess: (access, modes) => {
    const ids = new Set(modes.map((m) => m.id));
    const prefer =
      access === "ask"
        ? ["accept-edits", "smart", "ask"]
        : ["bypass", "smart", "accept-edits"];
    return (
      prefer.find((id) => ids.has(id)) ?? modes[0]?.id ?? undefined
    );
  },
};
