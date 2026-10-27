import { existsSync, promises as fsp, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { bounded, exists } from "./access.js";

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
 * The canonical spelling a path compares under (D-#854): the filesystem's
 * own — symlink segments resolved (`realpath`), so `~/link` and `~/real`
 * name the same folder. A not-yet-created tail resolves through its
 * nearest existing ancestor, like `resolveUnderHome`; a path nothing under
 * can resolve (a deleted folder, a test's fake home) keeps its literal
 * normalized form — matching degrades to the lexical compare that already
 * ran. The result is `~`-collapsed under the LITERAL home when it lands
 * under it, even where `home` is itself a symlink (same rule
 * `resolveUnderHome` keeps).
 */
export function canonicalPath(p: string, home = HOME): string {
  const abs = normalize(expandPath(p, home));
  /* The whole path, or its nearest existing ancestor + the lexical tail —
     `~/link/new-sub` still resolves `link` and rejoins `new-sub`. */
  let real = realpathOr(abs);
  let probe = abs;
  const tail: string[] = [];
  while (!real) {
    tail.unshift(basename(probe));
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
    real = realpathOr(probe);
  }
  if (!real) return collapsePath(abs, home);
  const joined = tail.length ? join(real, ...tail) : real;
  const realHome = realpathOr(normalize(home));
  if (realHome && (joined === realHome || joined.startsWith(`${realHome}/`))) {
    const rel = joined === realHome ? "" : joined.slice(realHome.length + 1);
    return collapsePath(
      rel ? join(normalize(home), rel) : normalize(home),
      home,
    );
  }
  return joined;
}

/**
 * Resolve a caller path to a REAL absolute path under `home` — `undefined`
 * when it escapes: `..` above home, an absolute path outside home, a symlink
 * pointing outside, or a dot-dir segment anywhere below home (hidden folders
 * are never device-visible, D-#238). A non-existent tail resolves through its
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

/** Async `resolveUnderHome` — same walk, same rules, but the stat and
 *  realpath syscalls are bounded (D-#875): a path under a protected folder
 *  the app can't read yet reports FOLDER_ACCESS instead of parking the
 *  caller in a consent wait it can't answer. Sync callers below the probe
 *  layer keep `resolveUnderHome`. */
export async function resolveUnderHomeAsync(
  p: string,
  home = HOME,
): Promise<string | undefined> {
  const realHome = await bounded(fsp.realpath(home), home).catch(
    () => undefined,
  );
  if (!realHome) return undefined;
  const abs = normalize(expandPath(p, home));
  let probe = abs;
  const tail: string[] = [];
  while (!(await exists(probe))) {
    tail.unshift(basename(probe));
    const parent = dirname(probe);
    if (parent === probe) return undefined;
    probe = parent;
  }
  const ancestor = await bounded(fsp.realpath(probe), probe).catch(
    () => undefined,
  );
  if (!ancestor) return undefined;
  if (ancestor !== realHome && !ancestor.startsWith(`${realHome}/`)) {
    return undefined;
  }
  const rel =
    ancestor === realHome
      ? tail.join("/")
      : [ancestor.slice(realHome.length + 1), ...tail].join("/");
  if (rel.split("/").some((s) => s.startsWith("."))) return undefined;
  const homeBase = normalize(expandPath("~", home));
  return rel ? join(homeBase, rel) : homeBase;
}
