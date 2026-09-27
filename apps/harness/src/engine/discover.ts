import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Find the Hermes binary without a shell PATH (AC-2, #85): a launchd-started
 * harness gets a minimal PATH that misses `~/.local/bin`, so discovery checks
 * — in order — the `HERMES_BIN` env, a saved override file
 * `~/.lilos/hermes-bin`, the known install locations, then every PATH dir.
 *
 * Errors are deliberately plain sentences ("Hermes not found at …"): they
 * surface verbatim in the status dialog and DM composer.
 */

export interface HermesDiscoveryOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  /** Executable check — injectable for tests. */
  exists?: (path: string) => boolean;
}

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Ordered candidates after the two explicit pointers (env, saved file). */
export function hermesSearchPaths(home: string, pathEnv: string): string[] {
  return [
    join(home, ".local", "bin", "hermes"),
    join(home, ".hermes", "bin", "hermes"),
    "/opt/homebrew/bin/hermes",
    "/usr/local/bin/hermes",
    ...pathEnv
      .split(":")
      .filter(Boolean)
      .map((dir) => join(dir, "hermes")),
  ];
}

/**
 * Absolute path to `hermes`, or a thrown plain-language error. An explicit
 * pointer (HERMES_BIN, the saved file) that names a missing path is an error
 * by itself — never a silent sweep elsewhere, so a typo'd override tells the
 * user exactly what it said.
 */
export function resolveHermesBin(options: HermesDiscoveryOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const exists = options.exists ?? isExecutable;

  const envBin = env.HERMES_BIN?.trim();
  if (envBin) {
    if (exists(envBin)) return envBin;
    throw new Error(
      `Hermes not found at ${envBin} (HERMES_BIN is set to it). Fix the path or unset it.`,
    );
  }

  const overrideFile = join(home, ".lilos", "hermes-bin");
  if (existsSync(overrideFile)) {
    const saved = readFileSync(overrideFile, "utf8").trim();
    if (exists(saved)) return saved;
    throw new Error(
      `Hermes not found at ${saved} (saved in ${overrideFile}). Fix the file or delete it.`,
    );
  }

  const paths = hermesSearchPaths(home, env.PATH ?? "");
  const found = paths.find(exists);
  if (found) return found;

  throw new Error(
    `Hermes not found — looked in ${paths.join(", ")}. Install Hermes, or point LilOS at it with HERMES_BIN or ${overrideFile}.`,
  );
}
