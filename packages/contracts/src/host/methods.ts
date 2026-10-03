import { type ZodType, z } from "zod";
import {
  ForgeCommentParams,
  ForgeCommentResult,
  ForgeCreateParams,
  ForgeCreateResult,
  ForgeMergeParams,
  ForgeMergeResult,
  ForgePrParams,
  ForgePrResult,
  ForgePrsParams,
  ForgePrsResult,
} from "./forge";
import {
  FsCompleteParams,
  FsCompleteResult,
  FsListParams,
  FsListResult,
  FsReadParams,
  FsReadResult,
  FsSearchParams,
  FsSearchResult,
  FsTreeParams,
  FsTreeResult,
} from "./fs";
import {
  GitBranchesParams,
  GitBranchesResult,
  GitCommitParams,
  GitCommitResult,
  GitCreateBranchParams,
  GitCreateBranchResult,
  GitDiffParams,
  GitDiffResult,
  GitDiscoverParams,
  GitDiscoverResult,
  GitIsRepoParams,
  GitIsRepoResult,
  GitLogParams,
  GitLogResult,
  GitPullParams,
  GitPullResult,
  GitPushParams,
  GitPushResult,
  GitStatusParams,
  GitStatusResult,
  GitWorktreesParams,
  GitWorktreesResult,
} from "./git";
import {
  OsEditorsParams,
  OsEditorsResult,
  OsOpenParams,
  OsOpenResult,
} from "./os";
import { HOST_API } from "./protocol";
import { HostUserParams, HostUserResult } from "./user";

/** One host method: request params, result shape, doc line. */
export interface HostMethodContract {
  params: ZodType;
  result: ZodType;
  doc: string;
}

const DescribeResult = z.object({
  api: z.object({
    name: z.literal(HOST_API.name),
    version: z.literal(HOST_API.version),
  }),
  /** Implemented method names — a caller diff-checks what it needs. */
  methods: z.array(z.string()),
});

export const HOST_METHODS = {
  "host.describe": {
    params: z.strictObject({}),
    result: DescribeResult,
    doc: "Protocol identity + implemented methods.",
  },
  "fs.list": {
    params: FsListParams,
    result: FsListResult,
    doc: "Directory children (dirs first) with git-repo marks.",
  },
  "fs.complete": {
    params: FsCompleteParams,
    result: FsCompleteResult,
    doc: "Directory-path autocomplete for a typed `word`.",
  },
  "fs.tree": {
    params: FsTreeParams,
    result: FsTreeResult,
    doc: "Recursive file listing of a folder (skips .git/node_modules; honors .gitignore in repos).",
  },
  "fs.search": {
    params: FsSearchParams,
    result: FsSearchResult,
    doc: "Fuzzy file/dir search inside a folder (gitignore-aware in repos) for `@`-mention picking.",
  },
  "fs.read": {
    params: FsReadParams,
    result: FsReadResult,
    doc: "UTF-8 file content with size/truncation/binary flags.",
  },
  "git.isRepo": {
    params: GitIsRepoParams,
    result: GitIsRepoResult,
    doc: "Whether a path sits inside a git work tree (and its root).",
  },
  "git.branches": {
    params: GitBranchesParams,
    result: GitBranchesResult,
    doc: "Local branches + current branch + origin URL of a repo.",
  },
  "git.status": {
    params: GitStatusParams,
    result: GitStatusResult,
    doc: "Working-tree status (tracked changes + untracked files).",
  },
  "git.commit": {
    params: GitCommitParams,
    result: GitCommitResult,
    doc: "Stage the listed paths (`git add -A --`) and commit them with the message — argv only, never a shell.",
  },
  "git.push": {
    params: GitPushParams,
    result: GitPushResult,
    doc: "Push the current branch to origin; sets `-u` on the first push. Never force, amend or rebase.",
  },
  "git.pull": {
    params: GitPullParams,
    result: GitPullResult,
    doc: "Fast-forward-only pull (`git pull --ff-only`, argv only — never merges, rebases or force-pushes); a diverged history answers reason 'diverged'.",
  },
  "git.createBranch": {
    params: GitCreateBranchParams,
    result: GitCreateBranchResult,
    doc: "Create + check out a branch (`check-ref-format` validated; fails when the name exists).",
  },
  "git.log": {
    params: GitLogParams,
    result: GitLogResult,
    doc: "Commits on the branch vs a base (fork point → remote default → upstream → local main; whole history when none).",
  },
  "git.diff": {
    params: GitDiffParams,
    result: GitDiffResult,
    doc: "Per-file working diff vs a base ref: stat + hunks-only patch (untracked files included).",
  },
  "git.worktrees": {
    params: GitWorktreesParams,
    result: GitWorktreesResult,
    doc: "`git worktree list`: every worktree of the repo (own checkout first) with branch + fork ref.",
  },
  "git.discoverRepos": {
    params: GitDiscoverParams,
    result: GitDiscoverResult,
    doc: "Scan roots for `.git` dirs; returns repo paths with head + remote.",
  },
  "forge.pr": {
    params: ForgePrParams,
    result: ForgePrResult,
    doc: "PR for the checkout's branch (title/body/checks/comments/state) via `gh`.",
  },
  "forge.prs": {
    params: ForgePrsParams,
    result: ForgePrsResult,
    doc: "Every PR for the checkout's branch(es) via `gh pr list` — badge facts + CI rollup (#159).",
  },
  "forge.create": {
    params: ForgeCreateParams,
    result: ForgeCreateResult,
    doc: "Open a PR for the checkout's branch via `gh pr create` — the signed-in user's auth, no stored token.",
  },
  "forge.comment": {
    params: ForgeCommentParams,
    result: ForgeCommentResult,
    doc: "Post a PR comment via `gh` — the signed-in user's auth, no stored token.",
  },
  "forge.merge": {
    params: ForgeMergeParams,
    result: ForgeMergeResult,
    doc: "Merge the PR via `gh` (squash|merge|rebase); returns the re-read PR, never stdout trust.",
  },
  "os.editors": {
    params: OsEditorsParams,
    result: OsEditorsResult,
    doc: "Editors detected on this Mac (VS Code, Cursor, Zed, Xcode by bundle id), preference order; first = default.",
  },
  "os.open": {
    params: OsOpenParams,
    result: OsOpenResult,
    doc: "Open a path inside the session folder in an editor (`code -g`/`cursor -g`/`zed` line syntax; Xcode file-only) or reveal it in Finder. argv exec, no shell.",
  },
  "host.user": {
    params: HostUserParams,
    result: HostUserResult,
    doc: "OS account name/full name — prefill source for the identity fields (#118).",
  },
} as const satisfies Record<string, HostMethodContract>;
