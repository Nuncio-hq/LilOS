import { z } from "zod";

/**
 * Forge surface of the host API (issue #37): pull-request view / comment /
 * merge for the repo a session runs in. The host shells out to `gh`, so the
 * signed-in user's own GitHub auth applies and LilOS stores no token
 * (D-#37). `path` is a folder on the host machine; the PR is the one for that
 * checkout's current branch unless `number` pins an explicit PR.
 */

const Path = z.string().min(1);

/**
 * Which known `gh` failure a GH_FAILED error carries, in its error `data`.
 * Clients render plain per-reason copy with one next step — raw stderr never
 * becomes the headline (#114 AC-5). `no PR` is not a failure: `forge.pr`
 * answers `pr: null` for it.
 */
export const ForgeGhReason = z.enum(["missing", "unauthenticated", "other"]);
export type ForgeGhReason = z.infer<typeof ForgeGhReason>;

/** GH_FAILED error `data` (errors aren't schema-checked on the wire — clients
    `safeParse` this and fall back to "other"). */
export const ForgeGhErrorData = z.object({
  reason: ForgeGhReason,
  /** Raw stderr/exec detail — for a Details disclosure only. */
  detail: z.string(),
});
export type ForgeGhErrorData = z.infer<typeof ForgeGhErrorData>;

export const ForgeCheckStatus = z.enum([
  "pending",
  "passed",
  "failed",
  "skipped",
]);
export type ForgeCheckStatus = z.infer<typeof ForgeCheckStatus>;

/** One CI check or status context on the PR head commit. */
export const ForgeCheck = z.object({
  name: z.string().min(1),
  status: ForgeCheckStatus,
});
export type ForgeCheck = z.infer<typeof ForgeCheck>;

export const ForgePrComment = z.object({
  /** GitHub login of the commenter. */
  author: z.string(),
  /** ISO 8601 timestamp (`createdAt` from gh). */
  at: z.string(),
  body: z.string(),
});
export type ForgePrComment = z.infer<typeof ForgePrComment>;

export const ForgePrState = z.enum(["open", "merged", "closed"]);
export type ForgePrState = z.infer<typeof ForgePrState>;

export const ForgeMergeable = z.enum(["mergeable", "conflicting", "unknown"]);
export type ForgeMergeable = z.infer<typeof ForgeMergeable>;

/**
 * The pull-request view the Workbench PR tab renders. Timestamps stay ISO —
 * display formatting is the client's job.
 */
export const ForgePullRequest = z.object({
  number: z.int().min(1),
  /** Full PR URL (`https://<host>/<owner>/<repo>/pull/<n>`). */
  url: z.string().min(1),
  /** `owner/repo`, parsed from the PR URL (GHES-safe). */
  repo: z.string().min(1),
  title: z.string(),
  body: z.string(),
  state: ForgePrState,
  author: z.string(),
  base: z.string().min(1),
  head: z.string().min(1),
  /** ISO 8601 (`createdAt`). */
  openedAt: z.string(),
  /** Present only when `state` is "merged". */
  merged: z
    .object({ by: z.string().nullable(), at: z.string(), sha: z.string() })
    .optional(),
  mergeable: ForgeMergeable,
  checks: z.array(ForgeCheck),
  comments: z.array(ForgePrComment),
});
export type ForgePullRequest = z.infer<typeof ForgePullRequest>;

/** `path` plus an optional explicit PR number (default: the branch's PR). */
const PrRef = { number: z.int().min(1).optional() };

// ── forge.pr ────────────────────────────────────────────────────────────────
export const ForgePrParams = z.strictObject({ path: Path, ...PrRef });
export type ForgePrParams = z.infer<typeof ForgePrParams>;
export const ForgePrResult = z.object({
  root: z.string(),
  /** Branch the checkout sits on; null on detached HEAD. */
  branch: z.string().nullable(),
  /** The PR for that branch, or null when none exists. */
  pr: ForgePullRequest.nullable(),
});
export type ForgePrResult = z.infer<typeof ForgePrResult>;

// ── forge.comment ───────────────────────────────────────────────────────────
export const ForgeCommentParams = z.strictObject({
  path: Path,
  ...PrRef,
  body: z.string().min(1),
});
export type ForgeCommentParams = z.infer<typeof ForgeCommentParams>;
export const ForgeCommentResult = z.object({
  /** URL of the created comment (`gh pr comment` stdout). */
  url: z.string(),
});
export type ForgeCommentResult = z.infer<typeof ForgeCommentResult>;

// ── forge.merge ─────────────────────────────────────────────────────────────
export const ForgeMergeMethod = z.enum(["squash", "merge", "rebase"]);
export type ForgeMergeMethod = z.infer<typeof ForgeMergeMethod>;
export const ForgeMergeParams = z.strictObject({
  path: Path,
  ...PrRef,
  method: ForgeMergeMethod,
  /** Also delete the head branch (gh `--delete-branch`); default false. */
  deleteBranch: z.boolean().optional(),
});
export type ForgeMergeParams = z.infer<typeof ForgeMergeParams>;
export const ForgeMergeResult = z.object({
  /** True only when the post-merge re-read reports the PR as merged. */
  merged: z.boolean(),
  /** The PR re-read after merging — the real result, never gh's stdout. */
  pr: ForgePullRequest,
});
export type ForgeMergeResult = z.infer<typeof ForgeMergeResult>;
