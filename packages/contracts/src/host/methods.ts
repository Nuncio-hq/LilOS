import { type ZodType, z } from "zod";
import {
  FsCompleteParams,
  FsCompleteResult,
  FsListParams,
  FsListResult,
  FsReadParams,
  FsReadResult,
  FsTreeParams,
  FsTreeResult,
} from "./fs";
import {
  GitBranchesParams,
  GitBranchesResult,
  GitDiffParams,
  GitDiffResult,
  GitDiscoverParams,
  GitDiscoverResult,
  GitIsRepoParams,
  GitIsRepoResult,
  GitStatusParams,
  GitStatusResult,
} from "./git";
import { HOST_API } from "./protocol";

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
  "git.diff": {
    params: GitDiffParams,
    result: GitDiffResult,
    doc: "Per-file working diff vs a base ref: stat + hunks-only patch (untracked files included).",
  },
  "git.discoverRepos": {
    params: GitDiscoverParams,
    result: GitDiscoverResult,
    doc: "Scan roots for `.git` dirs; returns repo paths with head + remote.",
  },
} as const satisfies Record<string, HostMethodContract>;
