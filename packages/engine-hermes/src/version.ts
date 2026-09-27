/**
 * The minimum Hermes version LilOS can drive — declared once here (AC-3,
 * #95). The gateway handshake calls `client.capabilities` (gateway.ts),
 * which older Hermes builds answer with -32601 "unknown method": v0.20.2
 * dies on it, v0.21.5 works end to end.
 *
 * Two enforcement points read this: the harness probes `hermes --version`
 * before spawning (launcher.ts) and the adapter exits
 * `HERMES_TOO_OLD_EXIT_CODE` when the handshake itself reports -32601
 * (scripts/serve.ts) — both surface `hermesTooOldMessage` verbatim.
 */

export const MIN_HERMES_VERSION = "0.21.5";

/**
 * Reserved adapter exit code: "this Hermes is too old, retrying won't help".
 * Deliberately not a signal-shaped or generic-crash code so the launcher can
 * mark the start fatal rather than counting it toward the restart budget.
 */
export const HERMES_TOO_OLD_EXIT_CODE = 86;

/** First x.y.z in the string — tolerates `Hermes Agent v0.21.5+build (date)`. */
export function parseHermesVersion(output: string): string | undefined {
  // No \b — it fails after a letter prefix (v0.21.5). Delimit on digits/dots
  // instead so build metadata and parenthesized dates don't win over the
  // real version.
  return /(?<![\d.])[vV]?(\d+\.\d+\.\d+)(?![\d.])/.exec(output)?.[1];
}

const semverParts = (v: string): [number, number, number] => {
  const [a, b, c] = v.split(".").map((n) => Number.parseInt(n, 10));
  return [a ?? 0, b ?? 0, c ?? 0];
};

export function isHermesVersionSupported(version: string): boolean {
  const found = semverParts(version);
  const min = semverParts(MIN_HERMES_VERSION);
  for (let i = 0; i < 3; i++) {
    if (found[i] !== min[i]) return found[i] > min[i];
  }
  return true;
}

/**
 * The exact sentence the status dialog and DM composer show (AC-1). Plain on
 * purpose — it surfaces verbatim, so it names the found version, the
 * minimum, and the one command that fixes it.
 */
export function hermesTooOldMessage(found: string | undefined): string {
  return `Hermes ${found ?? "(unrecognized version)"} is too old — LilOS needs ${MIN_HERMES_VERSION} or newer. Run \`hermes update\`.`;
}
