import { z } from "zod";

/**
 * Git surface of the host API (issue #11). Answers "is this folder a repo,
 * what's in it, what changed" for folders on the machine the host runs on.
 * Everything is read-only: no fetch, no checkout, no index mutation
 * (`git.diff` reports untracked files without `git add -N`).
 */

const Path = z.string().min(1);

// ── git.isRepo ──────────────────────────────────────────────────────────────
export const GitIsRepoParams = z.strictObject({ path: Path });
export type GitIsRepoParams = z.infer<typeof GitIsRepoParams>;
export const GitIsRepoResult = z.object({
  isRepo: z.boolean(),
  /** Work-tree root (absolute, or `~`-collapsed) when isRepo. */
  root: z.string().optional(),
});
export type GitIsRepoResult = z.infer<typeof GitIsRepoResult>;

// ── git.branches ────────────────────────────────────────────────────────────
export const GitBranchesParams = z.strictObject({ path: Path });
export type GitBranchesParams = z.infer<typeof GitBranchesParams>;
export const GitBranchesResult = z.object({
  root: z.string(),
  /** Current branch; null on detached HEAD or an unborn HEAD. */
  current: z.string().nullable(),
  /** Local branches, current first then name-sorted. */
  branches: z.array(z.string()),
  /** `origin` fetch URL as configured; null when absent. */
  remote: z.string().nullable(),
});
export type GitBranchesResult = z.infer<typeof GitBranchesResult>;

// ── git.status ──────────────────────────────────────────────────────────────
export const GitFileStatus = z.enum([
  "modified",
  "added",
  "deleted",
  "renamed",
  "untracked",
]);
export type GitFileStatus = z.infer<typeof GitFileStatus>;

export const GitStatusParams = z.strictObject({ path: Path });
export type GitStatusParams = z.infer<typeof GitStatusParams>;
export const GitStatusResult = z.object({
  root: z.string(),
  /** Current branch; null on detached/unborn HEAD. */
  branch: z.string().nullable(),
  clean: z.boolean(),
  /** Working-tree + index changes vs HEAD, repo-relative paths. */
  files: z.array(
    z.object({
      path: z.string().min(1),
      status: GitFileStatus,
      /** Rename source path when status is "renamed". */
      origPath: z.string().optional(),
    }),
  ),
});
export type GitStatusResult = z.infer<typeof GitStatusResult>;

// ── git.diff ────────────────────────────────────────────────────────────────
export const GitDiffFileStatus = z.enum(["added", "modified", "deleted"]);
export type GitDiffFileStatus = z.infer<typeof GitDiffFileStatus>;

/**
 * Per-file working diff: stat plus a unified patch (hunks only — the `diff
 * --git`/`---`/`+++` headers are stripped so a viewer can render `patch`
 * directly). `truncated` marks a patch cut at the host's per-file limit.
 */
export const GitDiffFile = z.object({
  path: z.string().min(1),
  status: GitDiffFileStatus,
  add: z.int().min(0),
  del: z.int().min(0),
  patch: z.string(),
  truncated: z.boolean().optional(),
});
export type GitDiffFile = z.infer<typeof GitDiffFile>;

export const GitDiffParams = z.strictObject({
  path: Path,
  /**
   * Base ref to compare the working tree against (`git diff <base>`);
   * omitted = `HEAD` (staged + unstaged tracked changes). Untracked files are
   * always appended as `added` entries with their content as the patch.
   */
  base: z.string().optional(),
});
export type GitDiffParams = z.infer<typeof GitDiffParams>;
export const GitDiffResult = z.object({
  root: z.string(),
  /** Resolved base ref ("HEAD" when omitted; null on an unborn HEAD). */
  base: z.string().nullable(),
  files: z.array(GitDiffFile),
});
export type GitDiffResult = z.infer<typeof GitDiffResult>;

// ── git.discoverRepos ───────────────────────────────────────────────────────
export const GitDiscoverParams = z.strictObject({
  /** Roots to scan (e.g. `~/Desktop`, `~/repos`). Missing roots are skipped. */
  roots: z.array(Path).min(1),
  /** How deep below each root to look for `.git` (default 2). */
  depth: z.int().min(0).max(6).optional(),
});
export type GitDiscoverParams = z.infer<typeof GitDiscoverParams>;
export const GitDiscoverResult = z.object({
  /** Repo work-tree roots found, sorted, capped at 200. */
  repos: z.array(
    z.object({
      path: z.string(),
      head: z.string().nullable(),
      remote: z.string().nullable(),
    }),
  ),
});
export type GitDiscoverResult = z.infer<typeof GitDiscoverResult>;
