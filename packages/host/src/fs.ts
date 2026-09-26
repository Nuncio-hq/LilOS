import { execFile } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  FsCompleteResult,
  FsEntry,
  FsListResult,
  FsReadResult,
  FsTreeResult,
} from "@lilos/contracts/host";
import { HOST_ERRORS, HostError } from "./errors.js";
import { repoMark, repoRoot } from "./git.js";
import { collapsePath, expandPath } from "./paths.js";

const run = promisify(execFile);
const SKIP = new Set([".git", "node_modules", ".DS_Store"]);
const COMPLETE_CAP = 50;
const TREE_CAP = 5000;
const READ_CAP = 256 * 1024;
const MARK_POOL = 16;

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
