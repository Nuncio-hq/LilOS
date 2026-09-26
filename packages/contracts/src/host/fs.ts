import { z } from "zod";

/**
 * Filesystem surface of the host API (issue #11). Every path is interpreted on
 * the machine the host runs on: absolute, or `~`/`~/...` for that machine's
 * home. Results echo paths `~`-collapsed when they sit under the host's home,
 * absolute otherwise. Params are strict; unknown keys are the caller's bug.
 */

const Path = z.string().min(1);

/** One directory entry. `repo` is present only on directories that are git work-tree roots. */
export const RepoMark = z.object({
  /** Current HEAD branch name; null when detached or unborn. */
  head: z.string().nullable(),
  /** Origin URL (as configured); null when the repo has no remote. */
  remote: z.string().nullable(),
});
export type RepoMark = z.infer<typeof RepoMark>;

export const FsEntry = z.object({
  name: z.string().min(1),
  kind: z.enum(["dir", "file", "other"]),
  repo: RepoMark.optional(),
});
export type FsEntry = z.infer<typeof FsEntry>;

// ── fs.list ─────────────────────────────────────────────────────────────────
export const FsListParams = z.strictObject({ path: Path });
export type FsListParams = z.infer<typeof FsListParams>;
export const FsListResult = z.object({
  path: Path,
  /** Direct children, directories first then files, name-sorted. */
  entries: z.array(FsEntry),
});
export type FsListResult = z.infer<typeof FsListResult>;

// ── fs.complete ─────────────────────────────────────────────────────────────
/** Path autocomplete for pickers: directories only, prefix match on the last segment. */
export const FsCompleteParams = z.strictObject({ word: z.string() });
export type FsCompleteParams = z.infer<typeof FsCompleteParams>;
export const FsCompleteResult = z.object({
  word: z.string(),
  /** Directory paths completing `word` (max 50, sorted). */
  suggestions: z.array(z.string()),
});
export type FsCompleteResult = z.infer<typeof FsCompleteResult>;

// ── fs.tree ─────────────────────────────────────────────────────────────────
export const FsTreeParams = z.strictObject({
  path: Path,
  /** Hard cap on returned file count (default 5000). */
  max: z.int().min(1).optional(),
});
export type FsTreeParams = z.infer<typeof FsTreeParams>;
export const FsTreeResult = z.object({
  path: Path,
  /**
   * Files under `path`, relative, "/" separated, sorted. Generated/vendor
   * noise is skipped on the host side: `.git`, `node_modules`, `.DS_Store`,
   * and entries a repo's `.gitignore` marks ignored are not returned.
   */
  files: z.array(z.string()),
  truncated: z.boolean(),
});
export type FsTreeResult = z.infer<typeof FsTreeResult>;

// ── fs.read ─────────────────────────────────────────────────────────────────
export const FsReadParams = z.strictObject({
  path: Path,
  /** Cap on returned bytes (default 256 KiB). */
  maxBytes: z.int().min(1).optional(),
});
export type FsReadParams = z.infer<typeof FsReadParams>;
export const FsReadResult = z.object({
  path: Path,
  /** Total file size in bytes. */
  size: z.int().min(0),
  /** UTF-8 text content, "" for binary files or when truncated before any data. */
  content: z.string(),
  truncated: z.boolean(),
  /** True when the file looks binary (NUL byte in the sample); content is empty then. */
  binary: z.boolean(),
});
export type FsReadResult = z.infer<typeof FsReadResult>;
