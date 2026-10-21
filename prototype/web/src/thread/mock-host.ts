import type {
  Diff,
  GitCommit,
  HostAccessors,
  MergeMethod,
  PullRequest,
  V3Thread,
} from "@lilos/ui"
import { diffsOf } from "./thread-steps"

/* The host seam (files, diff, git, forge) over a thread's mock workbench: the
   same accessors the app backs with the Mac's folder and `gh`. The folder is
   the mock's, so commit, push and Open PR change it the way the real ones
   would: the diff empties, the branch gets a commit, the PR tab appears. */

const METHODS = [
  "git.commit",
  "git.push",
  "git.pull",
  "git.createBranch",
  "forge.create",
]

export function mockHost(
  t: V3Thread,
  pr: PullRequest | undefined,
  say: (text: string) => void,
): HostAccessors {
  const wb = t.workbench
  const repo = (t.folder ?? "").split("/").filter(Boolean).pop() ?? "repo"
  let diffs: Diff[] = diffsOf(wb)
  let branch = t.branch ?? "main"
  let pushed: string | null = null
  let current = pr
  let commits: GitCommit[] = []
  const comments: PullRequest["comments"] = []
  const withComments = (p: PullRequest): PullRequest => ({ ...p, comments: [...p.comments, ...comments] })

  return {
    tree: async () => (wb ? wb.files.map((f) => f.replace(/\/$/, "")) : []),
    diff: async () => diffs,
    read: async (_cwd, path) => {
      const content = wb?.fileText[path]
      return content === undefined ? null : { content, binary: false, truncated: false }
    },
    pr: async () =>
      current
        ? { pr: withComments(current), branch }
        : { pr: null, branch },
    prComment: async (_cwd, body) => {
      comments.push({ from: "you", time: "now", text: body })
      return `https://example.invalid/${repo}/pull/${current?.number ?? 0}#comment`
    },
    prMerge: async (_cwd, _method: MergeMethod) => {
      if (!current) throw new Error("No pull request")
      current = {
        ...current,
        status: "merged",
        merged: { by: "you", at: "now", sha: "a1b2c3d" },
      }
      return withComments(current)
    },
    osEditors: async () => [{ id: "cursor", name: "Cursor" }],
    osOpen: async (_cwd, path, app) => say(`Opened ${path} in ${app}`),
    methods: async () => new Set(METHODS),
    status: async () => ({
      branch,
      clean: diffs.length === 0,
      files: diffs.map((d) => ({ path: d.path, status: d.status === "added" ? "A" : "M" })),
    }),
    branches: async () => ({
      current: branch,
      branches: [...new Set([branch, "main"])],
      remote: `git@example.invalid:${repo}.git`,
      default: "main",
    }),
    log: async () => commits,
    commit: async (_cwd, files, message) => {
      const done = diffs.filter((d) => files.includes(d.path))
      commits = [
        {
          hash: Math.random().toString(16).slice(2, 9),
          message,
          files: done.map((d) => ({ path: d.path, status: d.status, add: d.add, del: d.del })),
        },
        ...commits,
      ]
      diffs = diffs.filter((d) => !files.includes(d.path))
    },
    push: async () => {
      pushed = `origin/${branch}`
      return { upstream: pushed }
    },
    pull: async () => {},
    createBranch: async (_cwd, name) => {
      branch = name
    },
    prCreate: async (_cwd, p) => {
      current = {
        number: 100 + Math.floor(Math.random() * 100),
        repo,
        title: p.title,
        body: p.body,
        status: "open",
        author: "you",
        base: p.base ?? "main",
        head: branch,
        opened: "now",
        checks: [{ name: "CI", status: "pending" }],
        comments: [],
      }
      return `https://example.invalid/${repo}/pull/${current.number}`
    },
  }
}
