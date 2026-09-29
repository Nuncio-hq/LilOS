import { execFile } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  GitBranchesResult,
  GitDiffFile,
  GitDiffResult,
  GitDiscoverResult,
  GitIsRepoResult,
  GitStatusResult,
  GitWorktree,
  GitWorktreesResult,
} from "@lilos/contracts/host";
import { HOST_ERRORS, HostError } from "./errors.js";
import { collapsePath, expandPath } from "./paths.js";

const run = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;
const DISCOVER_CAP = 200;
const PATCH_CAP = 200 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout;
}

/** stdout, or null when git exits non-zero (non-repo, missing ref, unborn HEAD). */
async function gitOr(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

/** Work-tree root for `abs`, or null when outside any repo. */
export async function repoRoot(abs: string): Promise<string | null> {
  const out = await gitOr(abs, ["rev-parse", "--show-toplevel"]);
  return out === null ? null : resolve(abs, out.trim());
}

const headOf = (cwd: string) =>
  gitOr(cwd, ["symbolic-ref", "--short", "HEAD"]).then(
    (o) => o?.trim() || null,
  );
const remoteOf = (cwd: string) =>
  gitOr(cwd, ["config", "--get", "remote.origin.url"]).then(
    (o) => o?.trim() || null,
  );

/** RepoMark for a directory that is a repo root; null otherwise. */
export async function repoMark(
  abs: string,
): Promise<{ head: string | null; remote: string | null } | null> {
  const root = await repoRoot(abs);
  // git resolves symlinks in --show-toplevel (e.g. /var → /private/var);
  // compare against the canonicalized input path.
  if (!root || resolve(root) !== resolve(await fsp.realpath(abs))) return null;
  const [head, remote] = await Promise.all([headOf(root), remoteOf(root)]);
  return { head, remote };
}

async function rootOrThrow(path: string): Promise<string> {
  const abs = expandPath(path);
  const root = await repoRoot(abs);
  if (!root) {
    throw new HostError(HOST_ERRORS.NOT_A_REPO, `not a git repo: ${path}`);
  }
  return root;
}

export async function gitIsRepo(params: {
  path: string;
}): Promise<GitIsRepoResult> {
  const abs = expandPath(params.path);
  const root = await repoRoot(abs);
  return root ? { isRepo: true, root: collapsePath(root) } : { isRepo: false };
}

export async function gitBranches(params: {
  path: string;
}): Promise<GitBranchesResult> {
  const root = await rootOrThrow(params.path);
  const [current, list, remote] = await Promise.all([
    headOf(root),
    git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    remoteOf(root),
  ]);
  const branches = list
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
  if (current) {
    const i = branches.indexOf(current);
    if (i !== -1) branches.splice(i, 1);
    branches.unshift(current);
  }
  return { root: collapsePath(root), current, branches, remote };
}

type StatusFile = GitStatusResult["files"][number];

function parseStatus(raw: string): StatusFile[] {
  // `status --porcelain=v1 -z`: `XY <path>\0`; renames emit `XY <to>\0<from>\0`.
  const files: StatusFile[] = [];
  const tokens = raw.split("\0").filter((t) => t !== "");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const xy = t.slice(0, 2);
    const path = t.slice(3);
    if (xy === "??") {
      files.push({ path, status: "untracked" });
    } else if (xy.includes("R") || xy.includes("C")) {
      const origPath = tokens[++i];
      files.push({ path, status: "renamed", origPath });
    } else if (xy.includes("A")) {
      files.push({ path, status: "added" });
    } else if (xy.includes("D")) {
      files.push({ path, status: "deleted" });
    } else {
      files.push({ path, status: "modified" });
    }
  }
  return files;
}

export async function gitStatus(params: {
  path: string;
}): Promise<GitStatusResult> {
  const root = await rootOrThrow(params.path);
  const [branch, raw] = await Promise.all([
    headOf(root),
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);
  const files = parseStatus(raw);
  return { root: collapsePath(root), branch, clean: files.length === 0, files };
}

type DiffSection = {
  patch: string;
  status: GitDiffFile["status"];
  path: string;
};

/** Split a `git diff` stream into per-file sections; hunks only (`@@` onward). */
function splitDiff(raw: string): DiffSection[] {
  const out: DiffSection[] = [];
  const sections = raw.split(/^diff --git /m).slice(1);
  for (const sec of sections) {
    const body = `diff --git ${sec}`;
    const from = body.match(/^--- (.+)$/m)?.[1];
    const to = body.match(/^\+\+\+ (.+)$/m)?.[1];
    const status: GitDiffFile["status"] =
      from === "/dev/null"
        ? "added"
        : to === "/dev/null"
          ? "deleted"
          : "modified";
    const path =
      (status === "deleted" ? from : to)?.replace(/^[ab]\//, "") ?? "";
    if (!path) continue;
    const at = body.indexOf("@@");
    const patch = at === -1 ? "" : body.slice(at).replace(/\n+$/, "");
    out.push({ patch, status, path });
  }
  return out;
}

function countPatch(patch: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return { add, del };
}

/** `--no-index` exits 1 when it prints a diff; keep the stdout either way. */
async function untrackedDiff(root: string, path: string): Promise<string> {
  let out = "";
  try {
    out = await git(root, [
      "diff",
      "--no-index",
      "--no-color",
      "--",
      "/dev/null",
      path,
    ]);
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? "";
  }
  const at = out.indexOf("@@");
  return at === -1 ? "" : out.slice(at).replace(/\n+$/, "");
}

function capped(patch: string): { patch: string; truncated?: true } {
  return patch.length > PATCH_CAP
    ? { patch: patch.slice(0, PATCH_CAP), truncated: true }
    : { patch };
}

export async function gitDiff(params: {
  path: string;
  base?: string;
}): Promise<GitDiffResult> {
  const root = await rootOrThrow(params.path);
  const hasHead =
    (await gitOr(root, ["rev-parse", "--verify", "HEAD"])) !== null;
  const base = params.base ?? "HEAD";
  const files: GitDiffFile[] = [];
  if (hasHead) {
    const raw = await git(root, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      base,
      "--",
      ".",
    ]);
    for (const f of splitDiff(raw)) {
      const { add, del } = countPatch(f.patch);
      files.push({
        path: f.path,
        status: f.status,
        add,
        del,
        ...capped(f.patch),
      });
    }
  }
  // Untracked files belong to the working tree's change set; synthesize each
  // as an `added` diff (no `git add -N` — that would dirty the index).
  const status = await gitStatus({ path: root });
  for (const f of status.files) {
    if (f.status !== "untracked") continue;
    const patch = await untrackedDiff(root, f.path);
    const { add, del } = countPatch(patch);
    files.push({ path: f.path, status: "added", add, del, ...capped(patch) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root: collapsePath(root), base: hasHead ? base : null, files };
}

/** Reflog "branch: Created from <ref>" — the fork point, best-effort. */
async function forkRef(root: string, branch: string): Promise<string | null> {
  const out = await gitOr(root, ["reflog", "show", "--format=%gs", branch]);
  const last = out?.trim().split("\n").at(-1);
  return last ? (/Created from (.+)$/.exec(last)?.[1] ?? null) : null;
}

export async function gitWorktrees(params: {
  path: string;
}): Promise<GitWorktreesResult> {
  const root = await rootOrThrow(params.path);
  const raw = await git(root, ["worktree", "list", "--porcelain"]);
  /* Blocks separated by blank lines:
       worktree /abs/path
       HEAD <sha>
       branch refs/heads/<name>   (or `detached`, and `bare` on bare repos) */
  const worktrees: GitWorktree[] = [];
  for (const block of raw.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines
      .find((l) => l.startsWith("worktree "))
      ?.slice("worktree ".length)
      .trim();
    if (!path) continue;
    const wt: GitWorktree = { path: collapsePath(path) };
    const head = lines
      .find((l) => l.startsWith("HEAD "))
      ?.slice(5)
      .trim();
    if (head) wt.head = head;
    const branchRef = lines.find((l) => l.startsWith("branch "));
    if (lines.includes("bare")) wt.bare = true;
    if (lines.includes("detached")) wt.detached = true;
    if (branchRef) {
      wt.branch = branchRef.slice(7).replace(/^refs\/heads\//, "");
      const from = await forkRef(root, wt.branch);
      if (from) wt.from = from;
    }
    worktrees.push(wt);
  }
  return { root: collapsePath(root), worktrees };
}

/**
 * `git worktree add <dir> -b <branch> <base>` — LilOS's one mutating git op
 * (#156's "new workstream" mode): it only ever ADDS a worktree+branch, never
 * removes/checks out. Called by the harness in-process; deliberately not on
 * the loopback HTTP surface, which stays read-only (D-#11). When `dir` sits
 * inside the repo's `.lilos/` we write `.lilos/.gitignore = *` first — the
 * dir then renders no untracked entries in the parent checkout's `git
 * status`, without touching `.git/info/exclude` or the user's .gitignore.
 */
export async function worktreeAdd(params: {
  /** Repo the worktree belongs to (any dir inside its work tree). */
  path: string;
  /** New worktree directory (absolute or `~/`). */
  dir: string;
  /** Branch to create at the worktree (`ws/<slug>` convention is the caller's). */
  branch: string;
  /** Start point: branch, ref or commit. */
  base: string;
}): Promise<{ dir: string; branch: string }> {
  const root = await rootOrThrow(params.path);
  const dir = resolve(expandPath(params.dir));
  const lilos = join(root, ".lilos");
  if (dir.startsWith(`${lilos}/`)) {
    await fsp.mkdir(lilos, { recursive: true });
    const gi = join(lilos, ".gitignore");
    if (!existsSync(gi)) await fsp.writeFile(gi, "*\n");
  }
  await git(root, ["worktree", "add", "-b", params.branch, dir, params.base]);
  return { dir: collapsePath(dir), branch: params.branch };
}

export async function gitDiscoverRepos(params: {
  roots: string[];
  depth?: number;
}): Promise<GitDiscoverResult> {
  const depth = params.depth ?? 2;
  const repos: { path: string; head: string | null; remote: string | null }[] =
    [];
  async function scan(dir: string, d: number): Promise<void> {
    if (repos.length >= DISCOVER_CAP) return;
    if (existsSync(join(dir, ".git"))) {
      const [head, remote] = await Promise.all([headOf(dir), remoteOf(dir)]);
      repos.push({ path: collapsePath(dir), head, remote });
      return; // don't descend into a repo
    }
    if (d === 0) return;
    const dirents = await fsp
      .readdir(dir, { withFileTypes: true })
      .catch(() => [] as import("node:fs").Dirent[]);
    for (const de of dirents) {
      if (
        !de.isDirectory() ||
        de.name.startsWith(".") ||
        de.name === "node_modules"
      ) {
        continue;
      }
      await scan(join(dir, de.name), d - 1);
    }
  }
  for (const r of params.roots) {
    await scan(expandPath(r), depth);
  }
  repos.sort((a, b) => a.path.localeCompare(b.path));
  return { repos };
}
