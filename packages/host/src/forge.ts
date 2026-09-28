import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ForgeCommentResult,
  ForgeMergeParams,
  ForgeMergeResult,
  ForgePrParams,
  ForgePrResult,
  ForgePullRequest,
} from "@lilos/contracts/host";
import { HOST_ERRORS, HostError } from "./errors.js";
import { repoRoot } from "./git.js";
import { collapsePath, expandPath } from "./paths.js";

const run = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;

/** Fields of `gh pr view --json` the PR tab consumes. */
const PR_FIELDS = [
  "number",
  "title",
  "body",
  "url",
  "state",
  "author",
  "baseRefName",
  "headRefName",
  "createdAt",
  "mergedAt",
  "mergedBy",
  "mergeCommit",
  "mergeable",
  "statusCheckRollup",
  "comments",
].join(",");

/** The "no PR for this branch" signal in gh's stderr (matched, never parsed). */
const NO_PR = /no pull requests found|no open pull requests|not found/i;

function ghFailed(e: unknown): HostError {
  const err = e as { stderr?: string; message?: string };
  // Bun attaches stderr:"" on ENOENT (Node doesn't) — an empty stderr must
  // fall back to err.message or the failure reads "gh failed:" blank.
  const detail = (err.stderr?.trim() || err.message || String(e)).trim();
  return new HostError(HOST_ERRORS.GH_FAILED, `gh failed: ${detail}`, {
    detail,
  });
}

async function gh(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("gh", args, { cwd, maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (e) {
    throw ghFailed(e);
  }
}

/** `gh pr view` mapped to the wire type; null when the branch has no PR. */
async function viewPr(
  root: string,
  number?: number,
): Promise<ForgePullRequest | null> {
  const args = [
    "pr",
    "view",
    ...(number ? [String(number)] : []),
    "--json",
    PR_FIELDS,
  ];
  let out: string;
  try {
    out = await gh(root, args);
  } catch (e) {
    if (e instanceof HostError && NO_PR.test(e.message)) return null;
    throw e;
  }
  return mapPr(JSON.parse(out) as GhPrView);
}

/** Same, but the caller expects a PR to exist (comment/merge targets). */
async function requirePr(
  root: string,
  number?: number,
): Promise<ForgePullRequest> {
  const pr = await viewPr(root, number);
  if (!pr) {
    throw new HostError(
      HOST_ERRORS.PR_NOT_FOUND,
      number
        ? `pull request #${number} not found`
        : "no pull request for the checkout's branch",
    );
  }
  return pr;
}

/** Loose shape of `gh pr view --json …` output (fields requested in PR_FIELDS). */
type GhPrView = {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  author?: { login?: string };
  baseRefName: string;
  headRefName: string;
  createdAt: string;
  mergedAt?: string | null;
  mergedBy?: { login?: string } | null;
  mergeCommit?: { oid?: string } | null;
  mergeable?: string;
  statusCheckRollup?: {
    __typename?: string;
    name?: string;
    context?: string;
    status?: string;
    state?: string;
    conclusion?: string | null;
  }[];
  comments?: {
    author?: { login?: string } | null;
    body?: string;
    createdAt?: string;
  }[];
};

function mapCheck(c: NonNullable<GhPrView["statusCheckRollup"]>[number]) {
  const name = c.name ?? c.context ?? "check";
  // statusCheckRollup mixes CheckRun (status+conclusion) and StatusContext (state).
  if (c.conclusion !== undefined || c.status !== undefined) {
    if (c.status !== "COMPLETED") return { name, status: "pending" as const };
    switch (c.conclusion) {
      case "SUCCESS":
        return { name, status: "passed" as const };
      case "SKIPPED":
      case "NEUTRAL":
        return { name, status: "skipped" as const };
      default:
        return { name, status: "failed" as const };
    }
  }
  switch (c.state) {
    case "SUCCESS":
      return { name, status: "passed" as const };
    case "PENDING":
    case "EXPECTED":
      return { name, status: "pending" as const };
    default:
      return { name, status: "failed" as const };
  }
}

function mapPr(v: GhPrView): ForgePullRequest {
  const state =
    v.state === "MERGED" ? "merged" : v.state === "CLOSED" ? "closed" : "open";
  return {
    number: v.number,
    url: v.url,
    repo: v.url.match(/\/([^/]+\/[^/]+)\/pull\/\d+/)?.[1] ?? "",
    title: v.title,
    body: v.body,
    state,
    author: v.author?.login ?? "ghost",
    base: v.baseRefName,
    head: v.headRefName,
    openedAt: v.createdAt,
    ...(state === "merged" && v.mergedAt
      ? {
          merged: {
            by: v.mergedBy?.login ?? null,
            at: v.mergedAt,
            sha: v.mergeCommit?.oid ?? "",
          },
        }
      : {}),
    mergeable:
      v.mergeable === "MERGEABLE"
        ? "mergeable"
        : v.mergeable === "CONFLICTING"
          ? "conflicting"
          : "unknown",
    checks: (v.statusCheckRollup ?? []).map(mapCheck),
    comments: (v.comments ?? []).map((c) => ({
      author: c.author?.login ?? "ghost",
      at: c.createdAt ?? "",
      body: c.body ?? "",
    })),
  };
}

export async function forgePr(params: ForgePrParams): Promise<ForgePrResult> {
  const abs = expandPath(params.path);
  const root = await repoRoot(abs);
  if (!root) {
    throw new HostError(
      HOST_ERRORS.NOT_A_REPO,
      `not a git repo: ${params.path}`,
    );
  }
  const [branch, pr] = await Promise.all([
    run("git", ["symbolic-ref", "--short", "HEAD"], { cwd: root })
      .then(({ stdout }) => stdout.trim())
      .catch(() => null),
    viewPr(root, params.number),
  ]);
  return { root: collapsePath(root), branch, pr };
}

export async function forgeComment(params: {
  path: string;
  body: string;
  number?: number;
}): Promise<ForgeCommentResult> {
  const root = await repoOrThrow(params.path);
  // Resolve first so "no PR" reports PR_NOT_FOUND, not a raw gh error.
  const pr = await requirePr(root, params.number);
  const out = await gh(root, [
    "pr",
    "comment",
    String(pr.number),
    "--body",
    params.body,
  ]);
  return { url: out.trim() };
}

export async function forgeMerge(
  params: ForgeMergeParams,
): Promise<ForgeMergeResult> {
  const root = await repoOrThrow(params.path);
  const before = await requirePr(root, params.number);
  if (before.state === "merged") return { merged: true, pr: before };
  if (before.state === "closed") {
    throw new HostError(
      HOST_ERRORS.PR_NOT_FOUND,
      `pull request #${before.number} is closed`,
    );
  }
  await gh(root, [
    "pr",
    "merge",
    String(before.number),
    `--${params.method}`,
    ...(params.deleteBranch ? ["--delete-branch"] : []),
  ]);
  // Report the re-read state, not gh's exit code.
  const after = await viewPr(root, before.number);
  return { merged: after?.state === "merged", pr: after ?? before };
}

async function repoOrThrow(path: string): Promise<string> {
  const root = await repoRoot(expandPath(path));
  if (!root) {
    throw new HostError(HOST_ERRORS.NOT_A_REPO, `not a git repo: ${path}`);
  }
  return root;
}
