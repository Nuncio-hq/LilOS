import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

const HOME = homedir();

/**
 * Resolve a caller path to an absolute one: `~`, `~/x`, or already-absolute.
 * Relative paths resolve under the host's home (the machine's user), matching
 * how a person navigates a folder picker.
 */
export function expandPath(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return normalize(join(HOME, p.slice(2)));
  if (isAbsolute(p)) return normalize(p);
  return normalize(join(HOME, p));
}

/** Collapse an absolute path to `~/x` when it sits under the host's home. */
export function collapsePath(p: string): string {
  const n = normalize(p);
  if (n === HOME) return "~";
  if (n.startsWith(`${HOME}/`)) return `~/${n.slice(HOME.length + 1)}`;
  return n;
}
