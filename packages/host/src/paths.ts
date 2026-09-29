import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

const HOME = homedir();

/**
 * Resolve a caller path to an absolute one: `~`, `~/x`, or already-absolute.
 * Relative paths resolve under the host's home (the machine's user), matching
 * how a person navigates a folder picker.
 */
export function expandPath(p: string, home = HOME): string {
  if (p === "~") return normalize(home);
  if (p.startsWith("~/")) return normalize(join(home, p.slice(2)));
  if (isAbsolute(p)) return normalize(p);
  return normalize(join(home, p));
}

/** Collapse an absolute path to `~/x` when it sits under the host's home. */
export function collapsePath(p: string, home = HOME): string {
  const n = normalize(p);
  const h = normalize(home);
  if (n === h) return "~";
  if (n.startsWith(`${h}/`)) return `~/${n.slice(h.length + 1)}`;
  return n;
}

const realpathOr = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

/**
 * Resolve a caller path to a REAL absolute path under `home` — `undefined`
 * when it escapes: `..` above home, an absolute path outside home, a symlink
 * pointing outside, or a dot-dir segment anywhere below home (hidden folders
 * are never device-visible, #238). A non-existent tail resolves through its
 * nearest existing ancestor, so a not-yet-created folder still checks its
 * parents.
 */
export function resolveUnderHome(p: string, home = HOME): string | undefined {
  const realHome = realpathOr(home);
  if (!realHome) return undefined;
  const abs = normalize(expandPath(p, home));
  /* Nearest existing ancestor → canonicalize it; the rest rejoins
     lexically (`abs` is already `..`-free after normalize). */
  let probe = abs;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    tail.unshift(basename(probe));
    const parent = dirname(probe);
    if (parent === probe) return undefined;
    probe = parent;
  }
  const ancestor = realpathOr(probe);
  if (!ancestor) return undefined;
  if (ancestor !== realHome && !ancestor.startsWith(`${realHome}/`)) {
    return undefined;
  }
  const rel =
    ancestor === realHome
      ? tail.join("/")
      : [ancestor.slice(realHome.length + 1), ...tail].join("/");
  if (rel.split("/").some((s) => s.startsWith("."))) return undefined;
  /* Returned under the LITERAL home so callers' `collapsePath(abs, home)`
     still folds to `~/x` even when `home` is itself a symlink. */
  const homeBase = normalize(expandPath("~", home));
  return rel ? join(homeBase, rel) : homeBase;
}
