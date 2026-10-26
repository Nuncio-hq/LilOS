import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { WorkspaceIntent } from "@lilos/contracts/app";
import {
  collapsePath,
  expandPath,
  gitBranches,
  gitIsRepo,
  gitWorktrees,
} from "@lilos/host";

/**
 * D-#848: a coding hand-off forks the calling thread's checkout into its
 * own worktree by default — resolved HERE, in the harness, the only
 * process allowed to run git (D-#11). The result is the same
 * `workspace.mode:"new"` intent a workstream open already carries
 * (#156): `ensureWorktree` materializes it at bind before
 * `session.start`, and `workspace.repoPath` files the child under the
 * repo's project (D-#771). No second worktree mechanism.
 *
 * `isolation:"shared"` and a parent with no folder keep the old
 * inherit-the-`cwd` behavior; a non-repo folder only refuses when the
 * caller asked for a worktree by name (the default just shares). The
 * fork's start point is the parent checkout's committed HEAD — the
 * issue's "parent commit not in the repo" case reduces to an unborn or
 * unplaceable checkout, which refuses for both spellings. Uncommitted
 * edits never ride along: `git worktree add <dir> -b <branch> <sha>`
 * copies the commit, not the working tree.
 */

export interface TaskIsolation {
  /** The child's `cwd` — the new worktree dir. */
  cwd?: string;
  workspace?: WorkspaceIntent;
}

export async function resolveTaskIsolation(p: {
  /** The calling thread's stored folder/workstream pick. */
  cwd?: string;
  workspace?: WorkspaceIntent;
  /** `undefined` = default: worktree when the folder is a git repo. */
  isolation?: "worktree" | "shared";
  /** Text the `ws/<slug>` branch/dir derives from (title else prompt). */
  seed: string;
  /* `~` in a stored path means THIS directory — the harness home the
     relay's `projectFolderOf` collapsed against, never process HOME. */
  home: string;
}): Promise<TaskIsolation> {
  if (p.isolation === "shared") return {};
  const explicit = p.isolation === "worktree";
  const folder = p.cwd ?? p.workspace?.repoPath;
  if (!folder) {
    if (explicit) {
      throw new Error(
        `isolation "worktree" needs this thread to have a git folder — it has none; drop the pick or pass "shared"`,
      );
    }
    return {};
  }
  const probe = await gitIsRepo({ path: expandPath(folder, p.home) });
  const root = probe.root ? resolve(expandPath(probe.root, p.home)) : undefined;
  if (!probe.isRepo || !root) {
    if (explicit) {
      throw new Error(
        `isolation "worktree" needs this thread's folder to be a git repo — pass "shared" to work in it directly`,
      );
    }
    return {};
  }
  const { worktrees } = await gitWorktrees({ path: root });
  const own = worktrees.find(
    (w) => resolve(expandPath(w.path, p.home)) === root,
  );
  /* `worktree list --porcelain` prints the null OID for an unborn HEAD —
     "no commit" is missing OR all-zero. A worktree git can't place in
     its own list never yields a sha at all. Either way there is no
     commit to fork, so both spellings refuse rather than guess. */
  const base = own?.head;
  if (!base || /^0+$/.test(base)) {
    throw new Error(
      `task_create can't fork this checkout — it has no commit to work from; commit first or pass isolation "shared"`,
    );
  }
  /* The fork lives under the repo's main checkout — `worktree list`'s
     first non-bare entry — never inside another linked worktree, so the
     child's `repoPath` matches the folder the parent's project files
     under. Git's own list is the truth here: a stored `repoPath` goes
     stale the day the repo moves. */
  const repoPath = resolve(
    expandPath(worktrees.find((w) => !w.bare)?.path ?? root, p.home),
  );
  const slug = uniqueWorkSlug(
    repoPath,
    slugOf(p.seed) || "task",
    worktrees,
    (await gitBranches({ path: root })).branches,
  );
  const dir = join(repoPath, ".lilos", "wt", slug);
  return {
    cwd: collapsePath(dir, p.home),
    workspace: {
      mode: "new",
      repoPath: collapsePath(repoPath, p.home),
      branch: `ws/${slug}`,
      base,
    },
  };
}

/* The picker's own naming (apps/mobile dm-model `slugOf`/`folderLeaf` —
   duplicated: apps never import apps). */
const slugOf = (text: string): string =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (w) =>
        w &&
        !["a", "an", "the", "with", "on", "for", "of", "to", "and"].includes(w),
    )
    .slice(0, 2)
    .join("-");

/** A slug free as both `.lilos/wt/<slug>` and `ws/<slug>` — against the
    repo's branches, its registered worktrees, and a stale dir left on
    disk. */
function uniqueWorkSlug(
  repoPath: string,
  base: string,
  worktrees: { path: string; branch?: string }[],
  branches: string[],
): string {
  const taken = new Set<string>([
    ...branches,
    ...worktrees.flatMap((w) => [w.branch ?? "", basename(w.path)]),
  ]);
  const dir = (s: string) => join(repoPath, ".lilos", "wt", s);
  let slug = base;
  for (
    let n = 1;
    taken.has(slug) || taken.has(`ws/${slug}`) || existsSync(dir(slug));
    n++
  ) {
    slug = `${base}-${n}`;
  }
  return slug;
}
