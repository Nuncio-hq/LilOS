import type { CheckRun, Diff, FsDir, MergeMethod, OsApp, OsEditor, PullRequest } from "@lilos/ui"

/* Host API client for the prototype: POST /api/host carries one JSON-RPC frame to the
   dev middleware (vite.config.ts → host-plugin.ts), which runs packages/host on this
   machine. In the real app these calls ride the harness instead (issue #26/#27). */

let seq = 0
async function host<T>(method: string, params?: unknown): Promise<T> {
  const res = await fetch("/api/host", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
  })
  const frame = (await res.json()) as { result?: T; error?: { message: string } }
  if (frame.error) throw new Error(frame.error.message)
  return frame.result as T
}

type ListResult = {
  path: string
  entries: { name: string; kind: "dir" | "file" | "other"; repo?: { head: string | null; remote: string | null } }[]
}

/* In-flight dedupe only: a settled listing is never reused — reopening the
   picker or entering a folder re-reads the dir, so a folder created after
   the page loaded shows (issue #418). */
const dirInflight = new Map<string, Promise<Record<string, FsDir> | null>>()

/* fs.list → FsDir rows: the dir's children + a git-marked stub per repo child. The dir's
   own mark (branches) is fetched too, so picking it fills the folder card for real.
   The host collapses paths under its home to `~`, but the dialog looks rows up by the
   path it asked for — so the row is keyed by both the result path and the request path. */
export function hostDir(path: string): Promise<Record<string, FsDir> | null> {
  let p = dirInflight.get(path)
  if (!p) {
    p = (async () => {
      const r = await host<ListResult>("fs.list", { path })
      const out: Record<string, FsDir> = {}
      const children: string[] = []
      // Key everything by the requested path: the host may return the dir
      // `~`-collapsed, but the dialog looks rows up in the namespace it typed.
      const dir = path === "/" ? "" : path
      for (const e of r.entries) {
        if (e.kind !== "dir" || e.name.startsWith(".")) continue
        children.push(e.name)
        out[`${dir}/${e.name}`] = e.repo
          ? { git: { branches: [e.repo.head ?? "HEAD"], remote: e.repo.remote ?? undefined } }
          : {}
      }
      const self = await host<{ isRepo: boolean }>("git.isRepo", { path: r.path })
        .then((x) =>
          x.isRepo
            ? host<{ current: string | null; branches: string[]; remote: string | null }>("git.branches", { path: r.path })
            : null,
        )
        .catch(() => null)
      out[path] = {
        children,
        ...(self
          ? { git: { branches: self.branches.length ? self.branches : [self.current ?? "HEAD"], remote: self.remote ?? undefined } }
          : {}),
      }
      if (r.path !== path) out[r.path] = out[path]
      return out
    })()
      .catch(() => null)
      .finally(() => dirInflight.delete(path))
    dirInflight.set(path, p)
  }
  return p
}

/* git.isRepo + git.branches for a folder being attached (full branch list, not the mark stub). */
export async function hostPick(path: string): Promise<FsDir> {
  const { isRepo } = await host<{ isRepo: boolean }>("git.isRepo", { path })
  if (!isRepo) return {}
  const b = await host<{ current: string | null; branches: string[]; remote: string | null }>("git.branches", { path })
  return { git: { branches: b.branches.length ? b.branches : [b.current ?? "HEAD"], remote: b.remote ?? undefined } }
}

/* git.discoverRepos → "Found on this Mac" rows with their head branches. */
export async function hostDiscover(roots: string[]): Promise<{ list: string[]; stubs: Record<string, FsDir> }> {
  const r = await host<{ repos: { path: string; head: string | null; remote: string | null }[] }>(
    "git.discoverRepos", { roots, depth: 2 },
  )
  const stubs: Record<string, FsDir> = {}
  for (const x of r.repos) stubs[x.path] = { git: { branches: [x.head ?? "HEAD"], remote: x.remote ?? undefined } }
  return { list: r.repos.map((x) => x.path), stubs }
}

/* Forge wire shape (@lilos/contracts forge.pr result, minus {root,branch}). */
type WirePr = {
  number: number
  url: string
  repo: string
  title: string
  body: string
  state: "open" | "merged" | "closed"
  author: string
  base: string
  head: string
  openedAt: string
  merged?: { by: string; at: string; sha: string }
  mergeable: "mergeable" | "conflicting" | "unknown"
  checks: { name: string; status: CheckRun["status"] }[]
  comments: { author: string; at: string; body: string }[]
}

/* Relative time for comment headers ("2h", "3d") — keeps the panel quiet. */
const rel = (iso: string) => {
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (!(s >= 0)) return "just now"
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

const mapPr = (w: WirePr): PullRequest => ({
  number: w.number,
  repo: w.repo,
  title: w.title,
  body: w.body,
  author: w.author,
  base: w.base,
  head: w.head,
  status: w.state,
  mergeable: w.mergeable,
  merged: w.merged ? { by: w.merged.by, at: rel(w.merged.at), sha: w.merged.sha } : undefined,
  opened: rel(w.openedAt),
  checks: w.checks.map((c) => ({ name: c.name, status: c.status })),
  comments: w.comments.map((c) => ({ from: c.author, time: rel(c.at), text: c.body })),
})

/* Workbench accessors (null = host unreachable → fall back to the mock). */
export const hostAccessors = {
  tree: (cwd: string) =>
    host<{ files: string[] }>("fs.tree", { path: cwd }).then((r) => r.files).catch(() => null),
  diff: (cwd: string) =>
    host<{ files: Diff[] }>("git.diff", { path: cwd }).then((r) => r.files).catch(() => null),
  read: (cwd: string, path: string) =>
    host<{ content: string; binary: boolean; truncated: boolean }>("fs.read", { path: `${cwd}/${path}` }).catch(() => null),
  /* forge.pr → {pr} for the checkout's branch; outer null = host unreachable,
     pr: null = real checkout with no PR for its branch (issue #37). */
  pr: (cwd: string) =>
    host<{ pr: WirePr | null }>("forge.pr", { path: cwd })
      .then((r) => ({ pr: r.pr ? mapPr(r.pr) : null }))
      .catch(() => null),
  /* forge.comment → the new comment's URL (errors bubble to the panel). */
  prComment: (cwd: string, body: string) =>
    host<{ url: string }>("forge.comment", { path: cwd, body }).then((r) => r.url),
  /* forge.merge → the re-read PR (never stdout trust). */
  prMerge: (cwd: string, method: MergeMethod) =>
    host<{ pr: WirePr }>("forge.merge", { path: cwd, method }).then((r) => mapPr(r.pr)),
  /* os.editors / os.open (issue #110): editors detected on this Mac
     (preference order, first = default) + open/reveal inside a folder. */
  osEditors: () => host<{ editors: OsEditor[] }>("os.editors", {}).then((r) => r.editors),
  osOpen: (cwd: string, path: string, app: OsApp, line?: number) =>
    host<Record<string, never>>("os.open", { root: cwd, path, app, line }).then(() => undefined),
  /* Issue #107: the same git-write/forge surface the real app wires — the
     prototype drives the ship bar on mock handlers instead (App.tsx), but a
     live folder browsed here answers for real. */
  methods: () =>
    host<{ methods: string[] }>("host.describe")
      .then((r) => new Set(r.methods))
      .catch(() => new Set<string>()),
  status: (cwd: string) =>
    host<{ branch: string | null; clean: boolean; files: { path: string; status: string; origPath?: string }[] }>(
      "git.status", { path: cwd },
    ).catch(() => null),
  branches: (cwd: string) =>
    host<{ current: string | null; branches: string[]; remote: string | null; default: string | null }>(
      "git.branches", { path: cwd },
    ).catch(() => null),
  log: (cwd: string) =>
    host<{ commits: { sha: string; subject: string; files: { path: string; status: Diff["status"]; add: number; del: number }[] }[] }>(
      "git.log", { path: cwd },
    )
      .then((r) => r.commits.map((c) => ({ hash: c.sha, message: c.subject, files: c.files })))
      .catch(() => null),
  commit: (cwd: string, files: string[], message: string) =>
    host<Record<string, never>>("git.commit", { path: cwd, files, message }).then(() => undefined),
  push: (cwd: string) =>
    host<{ upstream: string | null }>("git.push", { path: cwd }),
  pull: (cwd: string) =>
    host<Record<string, never>>("git.pull", { path: cwd }).then(() => undefined),
  createBranch: (cwd: string, name: string) =>
    host<Record<string, never>>("git.createBranch", { path: cwd, name }).then(() => undefined),
  prCreate: (cwd: string, pr: { title: string; body: string; base?: string }) =>
    host<{ url: string }>("forge.create", { path: cwd, ...pr }).then((r) => r.url),
}
