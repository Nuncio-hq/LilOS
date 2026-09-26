import type { Diff, FsDir } from "@lilos/ui"

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

const dirCache = new Map<string, Promise<Record<string, FsDir> | null>>()

/* fs.list → FsDir rows: the dir's children + a git-marked stub per repo child. The dir's
   own mark (branches) is fetched too, so picking it fills the folder card for real.
   The host collapses paths under its home to `~`, but the dialog looks rows up by the
   path it asked for — so the row is keyed by both the result path and the request path. */
export function hostDir(path: string): Promise<Record<string, FsDir> | null> {
  let p = dirCache.get(path)
  if (!p) {
    p = (async () => {
      const r = await host<ListResult>("fs.list", { path })
      const out: Record<string, FsDir> = {}
      const children: string[] = []
      for (const e of r.entries) {
        if (e.kind !== "dir" || e.name.startsWith(".")) continue
        children.push(e.name)
        out[`${r.path}/${e.name}`] = e.repo
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
      out[r.path] = {
        children,
        ...(self
          ? { git: { branches: self.branches.length ? self.branches : [self.current ?? "HEAD"], remote: self.remote ?? undefined } }
          : {}),
      }
      if (r.path !== path) out[path] = out[r.path]
      return out
    })().catch(() => null)
    dirCache.set(path, p)
    // A failed listing is not cached — the next onNeedDir retries.
    void p.then((m) => {
      if (m === null) dirCache.delete(path)
    })
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

/* Workbench accessors (null = host unreachable → fall back to the mock). */
export const hostAccessors = {
  tree: (cwd: string) =>
    host<{ files: string[] }>("fs.tree", { path: cwd }).then((r) => r.files).catch(() => null),
  diff: (cwd: string) =>
    host<{ files: Diff[] }>("git.diff", { path: cwd }).then((r) => r.files).catch(() => null),
  read: (cwd: string, path: string) =>
    host<{ content: string; binary: boolean; truncated: boolean }>("fs.read", { path: `${cwd}/${path}` }).catch(() => null),
}
