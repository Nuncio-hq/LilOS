import { z } from "zod";

/**
 * Git surface of the host API (issue #11). Answers "is this folder a repo,
 * what's in it, what changed" for folders on the machine the host runs on —
 * plus the Writes the Workbench's commit/push bar needs (issue #107):
 * `git.commit`/`git.push`/`git.createBranch`. Writes are argv `execFile`
 * only (never a shell string) and never force-push, amend or rebase; the
 * signed-in user's own git/gh auth applies and LilOS stores no token
 * (D-#11, D-#37).
 */

/**
 * Which known git-write failure a GIT_FAILED error carries in its error
 * `data` — clients render plain per-reason copy + one next step; raw stderr
 * never becomes the headline (same contract as `ForgeGhReason`, #114 AC-5).
 */
export const GitWriteReason = z.enum([
  /** Push rejected as non-fast-forward — the remote has newer commits. */
  "rejected",
  /** `git pull --ff-only` can't run — the branch and its upstream diverged. */
  "diverged",
  /** No remote named `origin` is configured (or it's unreachable). */
  "no-remote",
  /** The remote refused the push on auth (credential helper / SSH key). */
  "auth",
  /** The repo sits mid-merge with unresolved conflicts. */
  "conflict",
  /** Nothing staged for the requested files. */
  "nothing",
  /** A branch with that name already exists. */
  "exists",
  /** `git check-ref-format` rejected the branch name. */
  "invalid",
  "other",
]);
export type GitWriteReason = z.infer<typeof GitWriteReason>;

/** GIT_FAILED error `data` (errors aren't schema-checked on the wire —
    clients `safeParse` this and fall back to "other"). */
export const GitWriteErrorData = z.object({
  reason: GitWriteReason,
  /** Raw stderr — a Details disclosure only, never the headline. */
  detail: z.string(),
});
export type GitWriteErrorData = z.infer<typeof GitWriteErrorData>;

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
  /** Remote default branch's short name (`origin/HEAD` → e.g. `main`);
      null when there's no remote default — the "Create PR asks a branch
      name" check keys on this (issue #107). */
  default: z.string().nullable(),
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

// ── git.commit (issue #107) ─────────────────────────────────────────────────
export const GitCommitParams = z.strictObject({
  path: Path,
  /** Repo-relative paths to stage (`git add -A -- <files>` — a rename lists
      both the new path and its `origPath`). */
  files: z.array(z.string().min(1)).min(1),
  message: z.string().min(1),
});
export type GitCommitParams = z.infer<typeof GitCommitParams>;
export const GitCommitResult = z.object({
  root: z.string(),
  /** Current branch; null on detached HEAD. */
  branch: z.string().nullable(),
  /** Short sha of the new commit. */
  sha: z.string(),
  /** First line of the commit message. */
  subject: z.string(),
});
export type GitCommitResult = z.infer<typeof GitCommitResult>;

// ── git.push (issue #107) ───────────────────────────────────────────────────
export const GitPushParams = z.strictObject({ path: Path });
export type GitPushParams = z.infer<typeof GitPushParams>;
export const GitPushResult = z.object({
  root: z.string(),
  /** Pushed branch; null when HEAD was detached (push then never ran). */
  branch: z.string().nullable(),
  /** Upstream after the push (`origin/<branch>`); set with `-u` on the
      first push — never force. */
  upstream: z.string().nullable(),
});
export type GitPushResult = z.infer<typeof GitPushResult>;

// ── git.pull (issue #393 AC-5) ─────────────────────────────────────────────
export const GitPullParams = z.strictObject({ path: Path });
export type GitPullParams = z.infer<typeof GitPullParams>;
export const GitPullResult = z.object({
  root: z.string(),
  /** Pulled branch; null when HEAD was detached (pull then never ran). */
  branch: z.string().nullable(),
  /** Upstream the pull fast-forwarded to (`origin/<branch>`). */
  upstream: z.string().nullable(),
});
export type GitPullResult = z.infer<typeof GitPullResult>;

// ── git.createBranch (issue #107) ───────────────────────────────────────────
export const GitCreateBranchParams = z.strictObject({
  path: Path,
  name: z.string().min(1),
});
export type GitCreateBranchParams = z.infer<typeof GitCreateBranchParams>;
export const GitCreateBranchResult = z.object({
  root: z.string(),
  /** The new branch, now checked out. */
  branch: z.string(),
});
export type GitCreateBranchResult = z.infer<typeof GitCreateBranchResult>;

// ── git.log (issue #107) ────────────────────────────────────────────────────
export const GitLogParams = z.strictObject({
  path: Path,
  /** Base ref for `<base>..HEAD` (e.g. the PR's base branch). Omitted =
      resolved host-side: the branch's own "Created from" sha, then the
      remote default, then the upstream, then a local main/master — whole
      history (capped) when none of those resolves. */
  base: z.string().optional(),
  /** Max commits (default 20). */
  limit: z.int().min(1).max(200).optional(),
});
export type GitLogParams = z.infer<typeof GitLogParams>;

/** One commit as the Workbench's Commits section renders it. */
export const GitLogCommit = z.object({
  /** Short sha. */
  sha: z.string(),
  subject: z.string(),
  /** The commit's real git author name (`%an`) — the Workbench shows it on
      the row instead of crediting every commit to the employee (#587). */
  author: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      status: GitDiffFileStatus,
      add: z.int().min(0),
      del: z.int().min(0),
    }),
  ),
});
export type GitLogCommit = z.infer<typeof GitLogCommit>;

export const GitLogResult = z.object({
  root: z.string(),
  /** Current branch; null on detached HEAD. */
  branch: z.string().nullable(),
  /** The resolved base ref/sha, or null when the log covers all of HEAD. */
  base: z.string().nullable(),
  commits: z.array(GitLogCommit),
});
export type GitLogResult = z.infer<typeof GitLogResult>;

// ── git.worktrees ───────────────────────────────────────────────────────────
export const GitWorktreesParams = z.strictObject({ path: Path });
export type GitWorktreesParams = z.infer<typeof GitWorktreesParams>;

/**
 * One `git worktree` of a repo. The repo's own checkout is included (it is
 * the first entry of `git worktree list`); callers that want only linked
 * workstreams filter it out by `path !== root`.
 */
export const GitWorktree = z.object({
  /** Worktree directory (`~`-collapsed). */
  path: z.string(),
  /** HEAD commit sha at the worktree. */
  head: z.string().optional(),
  /** Checked-out branch; absent on a detached or bare entry. */
  branch: z.string().optional(),
  detached: z.boolean().optional(),
  bare: z.boolean().optional(),
  /**
   * Ref the branch was created from, best-effort read of the branch
   * reflog's "Created from <ref>" subject. Absent when the reflog doesn't
   * say (foreign branches, reflogs off) — display falls back to nothing.
   */
  from: z.string().optional(),
});
export type GitWorktree = z.infer<typeof GitWorktree>;

export const GitWorktreesResult = z.object({
  root: z.string(),
  worktrees: z.array(GitWorktree),
});
export type GitWorktreesResult = z.infer<typeof GitWorktreesResult>;

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
