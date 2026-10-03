import { execFile } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  GitBranchesResult,
  GitCommitResult,
  GitCreateBranchResult,
  GitDiffFile,
  GitDiffResult,
  GitDiscoverResult,
  GitIsRepoResult,
  GitLogCommit,
  GitLogResult,
  GitPullResult,
  GitPushResult,
  GitStatusResult,
  GitWorktree,
  GitWorktreesResult,
  GitWriteReason,
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
/** First configured remote's *name* — the push target; repos don't always
    call it `origin`. */
const remoteNameOf = (cwd: string) =>
  gitOr(cwd, ["remote"]).then((o) => o?.trim().split("\n")[0] || null);
/** `origin/HEAD`'s short name — the remote's default branch (`main`), or
    null with no remote/no default. */
const remoteDefaultOf = (cwd: string) =>
  gitOr(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).then(
    (o) => o?.trim().replace(/^origin\//, "") || null,
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
  const [current, list, remote, remoteDefault] = await Promise.all([
    headOf(root),
    git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    remoteOf(root),
    remoteDefaultOf(root),
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
  return {
    root: collapsePath(root),
    current,
    branches,
    remote,
    default: remoteDefault,
  };
}

// ── Writes (issue #107) ─────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noControlCharactersInRegex: git colors stderr on a TTY — strip ANSI for display
const ANSI = /\u001B\[[0-9;]*m/g;

type GitOp = "commit" | "push" | "pull" | "createBranch";

/** stderr/exec detail → a typed GitWriteReason the client maps to plain copy
    (same contract as forge's ghFailed — raw stderr only in `detail`). */
function gitWriteFailed(op: GitOp, e: unknown): HostError {
  const err = e as { stderr?: string; stdout?: string; message?: string };
  /* `git commit` prints "nothing added to commit" on *stdout* while real
     push/checkout errors ride stderr — take both so the reason classifier
     sees the signal whichever stream git picked. */
  const detail = (
    err.stderr?.trim() ||
    err.stdout?.trim() ||
    err.message ||
    String(e)
  )
    .replace(ANSI, "")
    .trim();
  let reason: GitWriteReason = "other";
  if (op === "push") {
    if (
      /non-fast-forward|fetch first|stale info|!\s*\[rejected\]/i.test(detail)
    ) {
      reason = "rejected";
    } else if (
      /permission denied|authentication failed|could not read username|terminal prompts disabled|could not read from remote repository/i.test(
        detail,
      )
    ) {
      reason = "auth";
    } else if (
      /no configured push destination|does not appear to be a git repository|could not resolve host|repository not found|no such remote|failed to connect/i.test(
        detail,
      )
    ) {
      reason = "no-remote";
    }
  } else if (op === "commit") {
    if (
      /unmerged|you need to resolve|merge conflict|cannot commit|not possible because you have unmerged|fix conflicts/i.test(
        detail,
      )
    ) {
      reason = "conflict";
    } else if (
      /nothing to commit|nothing added to commit|no changes added/i.test(detail)
    ) {
      reason = "nothing";
    }
  } else if (op === "pull") {
    if (
      /not possible to fast-forward|cannot fast-forward|you have divergent|diverged/i.test(
        detail,
      )
    ) {
      reason = "diverged";
    } else if (
      /unmerged|merge conflict|not possible because you have unmerged|fix conflicts|would be overwritten/i.test(
        detail,
      )
    ) {
      reason = "conflict";
    } else if (
      /permission denied|authentication failed|could not read username|terminal prompts disabled|could not read from remote repository/i.test(
        detail,
      )
    ) {
      reason = "auth";
    } else if (
      /could not resolve host|no such remote|failed to connect|does not appear to be a git repository|no tracking information/i.test(
        detail,
      )
    ) {
      reason = "no-remote";
    }
  } else {
    if (/already exists/i.test(detail)) reason = "exists";
    else if (/not a valid|invalid/i.test(detail)) reason = "invalid";
  }
  return new HostError(HOST_ERRORS.GIT_FAILED, `git ${op} failed: ${detail}`, {
    reason,
    detail,
  });
}

/** `git add -A -- <files>` then `git commit --only -- <files>` (issue #107).
    Stages only the listed paths and commits only them: `--only` keeps a
    bare `git commit` from sweeping in files someone else already staged
    (an agent's `git add`, an IDE). Never `-am`. */
export async function gitCommit(params: {
  path: string;
  files: string[];
  message: string;
}): Promise<GitCommitResult> {
  const root = await rootOrThrow(params.path);
  if (params.files.some((f) => f.startsWith("-"))) {
    throw new HostError(
      HOST_ERRORS.INVALID_PARAMS,
      "file paths must not start with '-'",
    );
  }
  try {
    await git(root, ["add", "-A", "--", ...params.files]);
  } catch (e) {
    throw gitWriteFailed("commit", e);
  }
  try {
    await git(root, [
      "commit",
      "--only",
      "-m",
      params.message,
      "--",
      ...params.files,
    ]);
  } catch (e) {
    throw gitWriteFailed("commit", e);
  }
  const sha = (await git(root, ["rev-parse", "--short", "HEAD"])).trim();
  const branch = await headOf(root);
  return {
    root: collapsePath(root),
    branch,
    sha,
    subject: params.message.split("\n")[0].trim(),
  };
}

/** `git push` — `-u origin <branch>` on the first push; rejected /
    no-remote / auth failures carry the typed reason (issue #107 AC-3).
    Never force. */
export async function gitPush(params: {
  path: string;
}): Promise<GitPushResult> {
  const root = await rootOrThrow(params.path);
  const branch = await headOf(root);
  if (!branch) {
    throw new HostError(
      HOST_ERRORS.GIT_FAILED,
      "git push failed: detached HEAD — nothing to push",
      { reason: "other", detail: "HEAD is detached" },
    );
  }
  const remote = await remoteNameOf(root);
  if (!remote) {
    throw new HostError(
      HOST_ERRORS.GIT_FAILED,
      "git push failed: no remote is configured",
      { reason: "no-remote", detail: "no remote is configured" },
    );
  }
  const upstream = await gitOr(root, [
    "rev-parse",
    "--abbrev-ref",
    "@{upstream}",
  ]).then((o) => o?.trim() || null);
  try {
    if (upstream) {
      await git(root, ["push"]);
    } else {
      await git(root, ["push", "-u", remote, branch]);
    }
  } catch (e) {
    throw gitWriteFailed("push", e);
  }
  const after = await gitOr(root, [
    "rev-parse",
    "--abbrev-ref",
    "@{upstream}",
  ]).then((o) => o?.trim() || null);
  return { root: collapsePath(root), branch, upstream: after };
}

/** `git pull --ff-only` — the push-rejected fix (issue #393 AC-5). Argv
    only; a diverged history answers 'diverged' plainly — never merges,
    rebases or resolves anything itself. */
export async function gitPull(params: {
  path: string;
}): Promise<GitPullResult> {
  const root = await rootOrThrow(params.path);
  const branch = await headOf(root);
  if (!branch) {
    throw new HostError(
      HOST_ERRORS.GIT_FAILED,
      "git pull failed: detached HEAD — nothing to pull into",
      { reason: "other", detail: "HEAD is detached" },
    );
  }
  const remote = await remoteNameOf(root);
  if (!remote) {
    throw new HostError(
      HOST_ERRORS.GIT_FAILED,
      "git pull failed: no remote is configured",
      { reason: "no-remote", detail: "no remote is configured" },
    );
  }
  const upstream = await gitOr(root, [
    "rev-parse",
    "--abbrev-ref",
    "@{upstream}",
  ]).then((o) => o?.trim() || null);
  if (!upstream) {
    throw new HostError(
      HOST_ERRORS.GIT_FAILED,
      "git pull failed: the branch has no upstream to pull from",
      { reason: "other", detail: "no upstream configured" },
    );
  }
  try {
    await git(root, ["pull", "--ff-only"]);
  } catch (e) {
    throw gitWriteFailed("pull", e);
  }
  return { root: collapsePath(root), branch, upstream };
}

/** `git checkout -b <name>` — check-ref-format validates the name first;
    an existing branch answers GIT_FAILED/'exists' (issue #107 AC-4). */
export async function gitCreateBranch(params: {
  path: string;
  name: string;
}): Promise<GitCreateBranchResult> {
  const root = await rootOrThrow(params.path);
  const ok = await gitOr(root, ["check-ref-format", "--branch", params.name]);
  if (ok === null) {
    throw new HostError(
      HOST_ERRORS.INVALID_PARAMS,
      `invalid branch name: ${params.name}`,
    );
  }
  const exists = await gitOr(root, [
    "rev-parse",
    "--verify",
    `refs/heads/${params.name}`,
  ]);
  if (exists !== null) {
    throw new HostError(
      HOST_ERRORS.GIT_FAILED,
      `git createBranch failed: a branch named '${params.name}' already exists`,
      { reason: "exists", detail: `refs/heads/${params.name} exists` },
    );
  }
  try {
    await git(root, ["checkout", "-b", params.name]);
  } catch (e) {
    throw gitWriteFailed("createBranch", e);
  }
  return { root: collapsePath(root), branch: params.name };
}

/** The branch's birth sha — the %H of its reflog's "branch: Created from"
    entry (its start point, whether the subject reads a ref or "HEAD"). */
async function birthSha(root: string, branch: string): Promise<string | null> {
  const out = await gitOr(root, [
    "reflog",
    "show",
    "--format=%H%x00%gs",
    branch,
  ]);
  for (const line of out?.split("\n") ?? []) {
    const i = line.indexOf("\0");
    if (i === -1) continue;
    if (line.slice(i + 1).startsWith("branch: Created from")) {
      return line.slice(0, i) || null;
    }
  }
  return null;
}

/** Base ref for `git.log`'s `<base>..HEAD`: explicit param, then the branch's
    own fork sha, then the remote default (≠ current), then upstream, then a
    local main/master/trunk ≠ current — null = whole history (capped). */
async function logBase(
  root: string,
  branch: string | null,
  explicit?: string,
): Promise<string | null> {
  if (explicit) return explicit;
  if (branch) {
    const sha = await birthSha(root, branch);
    if (sha) return sha;
  }
  const remoteDefault = await remoteDefaultOf(root);
  if (remoteDefault && remoteDefault !== branch) {
    return `origin/${remoteDefault}`;
  }
  const upstream = await gitOr(root, [
    "rev-parse",
    "--abbrev-ref",
    "@{upstream}",
  ]).then((o) => o?.trim() || null);
  if (upstream) return upstream;
  for (const d of ["main", "master", "trunk"]) {
    if (
      d !== branch &&
      (await gitOr(root, ["rev-parse", "--verify", `refs/heads/${d}`])) !== null
    ) {
      return d;
    }
  }
  return null;
}

/** `--name-status -z` records split on the \x1e commit marker. */
type NameStatusEntry = { status: string; path: string };

function parseNameStatus(raw: string): Map<string, NameStatusEntry[]> {
  const commits = new Map<string, NameStatusEntry[]>();
  // A record: "\x1e<full sha>\0<short>\0<subject>\0\n<A>\0<path>\0…"
  for (const rec of raw.split("\x1e")) {
    if (!rec.trim()) continue;
    const tokens = rec.split("\0");
    const sha = tokens[0].trim();
    const files: NameStatusEntry[] = [];
    for (let i = 3; i < tokens.length; i++) {
      const status = tokens[i].replace(/^\n+/, "").trim();
      if (!status) continue;
      let path = tokens[++i];
      if (path === undefined) break;
      if (status.startsWith("R") || status.startsWith("C")) {
        // rename/copy: `R<n>␀old␀new␀` — the row shows the new name.
        path = tokens[++i] ?? path;
      }
      files.push({ status, path });
    }
    commits.set(sha, files);
  }
  return commits;
}

/** `--numstat -z` records → per-commit path → {add,del} (binary = 0/0). */
function parseNumstat(
  raw: string,
): Map<string, Map<string, { add: number; del: number }>> {
  const commits = new Map<string, Map<string, { add: number; del: number }>>();
  for (const rec of raw.split("\x1e")) {
    if (!rec.trim()) continue;
    const tokens = rec.split("\0");
    const sha = tokens[0].trim();
    const files = new Map<string, { add: number; del: number }>();
    for (let i = 1; i < tokens.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(tokens[i].replace(/^\n+/, ""));
      if (!m) continue;
      const add = m[1] === "-" ? 0 : Number(m[1]);
      const del = m[2] === "-" ? 0 : Number(m[2]);
      if (m[3] === "") {
        // rename: path slot empty; next two tokens are old then new path.
        tokens[++i];
        const to = tokens[++i];
        if (to === undefined) break;
        files.set(to, { add, del });
      } else {
        files.set(m[3], { add, del });
      }
    }
    commits.set(sha, files);
  }
  return commits;
}

const diffFileStatus = (s: string): GitLogCommit["files"][number]["status"] =>
  s.startsWith("A") ? "added" : s.startsWith("D") ? "deleted" : "modified";

/** Commits on the branch vs its base — the Commits section's source in live
    mode and the Create-PR prefill (issue #107 AC-1/AC-4). */
export async function gitLog(params: {
  path: string;
  base?: string;
  limit?: number;
}): Promise<GitLogResult> {
  const root = await rootOrThrow(params.path);
  const branch = await headOf(root);
  const base = await logBase(root, branch, params.base);
  const limit = params.limit ?? 20;
  const range = base ? `${base}..HEAD` : "HEAD";
  const capped = base ? [] : ["-n", String(limit)];
  const format = "%x1e%H%x00%h%x00%s";
  const [nsRaw, stRaw] = await Promise.all([
    gitOr(root, [
      "log",
      range,
      `--format=${format}`,
      "-z",
      "--name-status",
      ...capped,
    ]),
    gitOr(root, [
      "log",
      range,
      "--format=%x1e%H",
      "-z",
      "--numstat",
      ...capped,
    ]),
  ]);
  if (!nsRaw) return { root: collapsePath(root), branch, base, commits: [] };
  const nameStatus = parseNameStatus(nsRaw);
  const numstat = parseNumstat(stRaw ?? "");
  const commits: GitLogCommit[] = [];
  for (const rec of nsRaw.split("\x1e")) {
    if (!rec.trim()) continue;
    const head = rec.split("\0");
    const full = head[0].trim();
    const files = (nameStatus.get(full) ?? []).map((f) => ({
      path: f.path,
      status: diffFileStatus(f.status),
      ...(numstat.get(full)?.get(f.path) ?? { add: 0, del: 0 }),
    }));
    commits.push({
      sha: head[1] ?? full.slice(0, 7),
      subject: head[2]?.replace(/\n+$/, "") ?? "",
      files,
    });
  }
  return { root: collapsePath(root), branch, base, commits };
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
