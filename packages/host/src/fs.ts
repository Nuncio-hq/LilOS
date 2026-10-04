import { existsSync, promises as fsp } from "node:fs";
import { join } from "node:path";
import type {
  FsCompleteResult,
  FsEntry,
  FsListResult,
  FsReadResult,
  FsSearchResult,
  FsTreeResult,
} from "@lilos/contracts/host";
import { HOST_ERRORS, HostError } from "./errors.js";
import { run } from "./exec.js";
import { repoMark, repoRoot } from "./git.js";
import { collapsePath, expandPath } from "./paths.js";

const SKIP = new Set([".git", "node_modules", ".DS_Store"]);
const COMPLETE_CAP = 50;
const TREE_CAP = 5000;
const READ_CAP = 256 * 1024;
const MARK_POOL = 16;
const SEARCH_LIMIT = 20;
/** Non-repo enumeration bound — search never walks deeper than this many entries. */
const SEARCH_WALK_CAP = 200_000;
/** Per-folder enumeration cache lifetime; root mtime bumps invalidate earlier. */
const SEARCH_CACHE_TTL_MS = 1500;

/** `.git` is a dir in a plain checkout, a file in a worktree/submodule. */
const hasGitDir = (abs: string) => existsSync(join(abs, ".git"));

function pathNotFound(path: string, kind: "folder" | "file"): HostError {
  return new HostError(HOST_ERRORS.PATH_NOT_FOUND, `no such ${kind}: ${path}`);
}

export async function fsList(params: { path: string }): Promise<FsListResult> {
  const abs = expandPath(params.path);
  const dirents = await fsp
    .readdir(abs, { withFileTypes: true })
    .catch((e: NodeJS.ErrnoException) => {
      throw e.code === "ENOENT" || e.code === "ENOTDIR"
        ? pathNotFound(params.path, "folder")
        : e;
    });
  const entries: FsEntry[] = dirents.map((d) => ({
    name: d.name,
    kind: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other",
  }));
  // Mark repo children with a bounded pool: one `git` round-trip per repo,
  // serially, turned a big folder (e.g. $TMPDIR, ~900 repos) into 15s+.
  const repos = entries.filter(
    (e) => e.kind === "dir" && hasGitDir(join(abs, e.name)),
  );
  let next = 0;
  const worker = async () => {
    while (next < repos.length) {
      const e = repos[next++] as FsEntry;
      const mark = await repoMark(join(abs, e.name));
      if (mark) e.repo = mark;
    }
  };
  await Promise.all(Array.from({ length: MARK_POOL }, worker));
  entries.sort(
    (a, b) =>
      (a.kind === "dir" ? 0 : 1) - (b.kind === "dir" ? 0 : 1) ||
      a.name.localeCompare(b.name),
  );
  return { path: collapsePath(abs), entries };
}

export async function fsComplete(params: {
  word: string;
}): Promise<FsCompleteResult> {
  const word = params.word;
  // Split into the directory being listed and the fragment being typed.
  const slash = word.lastIndexOf("/");
  const dirPart = slash === -1 ? "" : word.slice(0, slash + 1);
  const frag = slash === -1 ? word : word.slice(slash + 1);
  const abs = expandPath(slash === -1 ? "~" : dirPart);
  const dirents = await fsp
    .readdir(abs, { withFileTypes: true })
    .catch(() => [] as import("node:fs").Dirent[]);
  const suggestions = dirents
    .filter(
      (d) =>
        d.isDirectory() &&
        !SKIP.has(d.name) &&
        // An empty fragment shows non-hidden dirs; type a dot to reach them.
        (frag !== "" ? true : !d.name.startsWith(".")) &&
        d.name.toLowerCase().startsWith(frag.toLowerCase()),
    )
    .map((d) => `${dirPart}${d.name}`)
    .sort()
    .slice(0, COMPLETE_CAP);
  return { word, suggestions };
}

export async function fsTree(params: {
  path: string;
  max?: number;
}): Promise<FsTreeResult> {
  const abs = expandPath(params.path);
  const cap = params.max ?? TREE_CAP;
  const st = await fsp.stat(abs).catch((e: NodeJS.ErrnoException) => {
    throw e.code === "ENOENT" ? pathNotFound(params.path, "folder") : e;
  });
  if (!st.isDirectory()) {
    throw new HostError(
      HOST_ERRORS.PATH_NOT_FOUND,
      `not a folder: ${params.path}`,
    );
  }
  // In a repo, `git ls-files -co --exclude-standard` gives the visible file
  // set (tracked + untracked, .gitignore honored, .git/vendor dirs excluded)
  // and paths relative to `abs`. Outside a repo, walk and skip the SKIP set.
  const root = await repoRoot(abs);
  const files: string[] = [];
  let truncated = false;
  if (root) {
    const { stdout } = await run(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z"],
      { cwd: abs, maxBuffer: 64 * 1024 * 1024 },
    );
    for (const p of stdout.split("\0")) {
      if (p === "") continue;
      files.push(p);
      if (files.length >= cap) {
        truncated = true;
        break;
      }
    }
  } else {
    async function walk(dir: string, rel: string): Promise<void> {
      if (truncated) return;
      const dirents = await fsp.readdir(dir, { withFileTypes: true });
      for (const d of dirents) {
        if (truncated) return;
        if (SKIP.has(d.name)) continue;
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) await walk(join(dir, d.name), r);
        else if (d.isFile()) {
          files.push(r);
          if (files.length >= cap) {
            truncated = true;
            return;
          }
        }
      }
    }
    await walk(abs, "");
  }
  files.sort();
  return { path: collapsePath(abs), files, truncated };
}

type SearchItem = { path: string; kind: "file" | "dir" };

/** Folder enumeration for fs.search, cached per path (issue #105, AC-5):
 * re-`stat` the root each call — an mtime bump invalidates — plus a short TTL
 * so keystrokes never re-spawn `git ls-files`. */
const searchCache = new Map<
  string,
  { at: number; mtime: number; items: SearchItem[] }
>();

async function searchEnumerate(abs: string, inputPath: string) {
  const st = await fsp.stat(abs).catch((e: NodeJS.ErrnoException) => {
    throw e.code === "ENOENT" ? pathNotFound(inputPath, "folder") : e;
  });
  if (!st.isDirectory()) {
    throw new HostError(
      HOST_ERRORS.PATH_NOT_FOUND,
      `not a folder: ${inputPath}`,
    );
  }
  const hit = searchCache.get(abs);
  if (
    hit &&
    hit.mtime === st.mtimeMs &&
    Date.now() - hit.at < SEARCH_CACHE_TTL_MS
  ) {
    return hit.items;
  }
  const items: SearchItem[] = [];
  const root = await repoRoot(abs);
  if (root) {
    // Same visible set as fs.tree: tracked + untracked, .gitignore honored.
    const { stdout } = await run(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z"],
      { cwd: abs, maxBuffer: 64 * 1024 * 1024 },
    );
    const dirs = new Set<string>();
    for (const p of stdout.split("\0")) {
      if (!p) continue;
      if (p.endsWith("/")) {
        // untracked dir collapsed by -o (e.g. an embedded repo)
        dirs.add(p.slice(0, -1));
        continue;
      }
      items.push({ path: p, kind: "file" });
      let slash = p.indexOf("/");
      while (slash !== -1) {
        dirs.add(p.slice(0, slash));
        slash = p.indexOf("/", slash + 1);
      }
    }
    for (const d of dirs) items.push({ path: d, kind: "dir" });
  } else {
    let count = 0;
    async function walk(dir: string, rel: string): Promise<void> {
      if (count >= SEARCH_WALK_CAP) return;
      const dirents = await fsp
        .readdir(dir, { withFileTypes: true })
        .catch(() => [] as import("node:fs").Dirent[]);
      for (const d of dirents) {
        if (count >= SEARCH_WALK_CAP) return;
        if (SKIP.has(d.name)) continue;
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) {
          count++;
          items.push({ path: r, kind: "dir" });
          await walk(join(dir, d.name), r);
        } else if (d.isFile()) {
          count++;
          items.push({ path: r, kind: "file" });
        }
      }
    }
    await walk(abs, "");
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  searchCache.set(abs, { at: Date.now(), mtime: st.mtimeMs, items });
  return items;
}

const hasDotSegment = (p: string) =>
  p.split("/").some((s) => s.startsWith("."));

/** Fuzzy score: substring hit (basename > earlier > shorter), else in-order
 * subsequence (tighter span > shorter). `null` = no match. */
function searchScore(path: string, query: string): number | null {
  if (!query) return 0;
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  const at = p.indexOf(q);
  if (at !== -1) {
    const base = p.lastIndexOf("/") + 1;
    return 2000 + (at === base ? 100 : 0) - at - p.length / 100;
  }
  let qi = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < p.length && qi < q.length; i++) {
    if (p[i] === q[qi]) {
      if (first === -1) first = i;
      last = i;
      qi++;
    }
  }
  if (qi < q.length) return null;
  return 1000 - (last - first) - p.length / 100;
}

export async function fsSearch(params: {
  path: string;
  query: string;
  limit?: number;
}): Promise<FsSearchResult> {
  const abs = expandPath(params.path);
  const limit = params.limit ?? SEARCH_LIMIT;
  const items = await searchEnumerate(abs, params.path);
  const query = params.query;
  const dotOk = query.startsWith(".");
  const scored: { item: SearchItem; score: number }[] = [];
  for (const item of items) {
    // Dot-segmented entries (`.env`, `.github/…`) only surface when the query
    // asks for them — same affordance fs.complete gives dir names.
    if (!dotOk && hasDotSegment(item.path)) continue;
    const score = searchScore(item.path, query);
    if (score !== null) scored.push({ item, score });
  }
  // Stable sort: score ties keep the alphabetical enumeration order.
  scored.sort((a, b) => b.score - a.score);
  return {
    path: collapsePath(abs),
    files: scored.slice(0, limit).map((s) => s.item),
  };
}

export async function fsRead(params: {
  path: string;
  maxBytes?: number;
}): Promise<FsReadResult> {
  const abs = expandPath(params.path);
  const cap = params.maxBytes ?? READ_CAP;
  const st = await fsp.stat(abs).catch((e: NodeJS.ErrnoException) => {
    throw e.code === "ENOENT" ? pathNotFound(params.path, "file") : e;
  });
  if (!st.isFile()) {
    throw new HostError(
      HOST_ERRORS.PATH_NOT_FOUND,
      `not a file: ${params.path}`,
    );
  }
  const fh = await fsp.open(abs, "r");
  try {
    const buf = Buffer.alloc(Math.min(cap + 1, st.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    let data = buf.subarray(0, bytesRead);
    const truncated = bytesRead < st.size;
    if (truncated) data = data.subarray(0, cap);
    // Binary sniff: a NUL in the sample means don't send text.
    const binary = data.subarray(0, 8192).includes(0);
    return {
      path: collapsePath(abs),
      size: st.size,
      content: binary ? "" : data.toString("utf8"),
      truncated,
      binary,
    };
  } finally {
    await fh.close();
  }
}
