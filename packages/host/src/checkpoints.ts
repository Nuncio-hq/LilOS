import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { HOST_ERRORS, HostError } from "./errors.js";

const run = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

/** Default retention: newest 50 checkpoints per folder, nothing older than 7 days. */
export const CHECKPOINT_KEEP = 50;
export const CHECKPOINT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Folders never snapshotted — the user's own .git first among them. */
const DEFAULT_EXCLUDES = [
  ".git",
  ".lilos",
  "node_modules",
  ".next",
  "dist",
  "build",
  "target",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".DS_Store",
].join("\n");

interface Meta {
  /** Canonical session-folder path this store shadows. */
  path: string;
  /** Monotonic checkpoint sequence (ref suffix + history position). */
  count: number;
  /** Commit the shadow index was last seeded from — skip `read-tree` when it
      still matches the tip so `git add -A` keeps its stat cache (AC-6). */
  indexSeed?: string;
  checkpoints: { id: string; at: number; seq: number }[];
}

interface Folder {
  dir: string;
  gitDir: string;
  indexFile: string;
  metaFile: string;
}

const TIP = "refs/lilos/tip";
const CKPT = "refs/lilos/ck";

const identity = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "user.name=LilOS",
  "-c",
  "user.email=checkpoints@lilos.local",
];

function shadowEnv(f: Folder, cwd: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "GIT_DIR" || key === "GIT_WORK_TREE" || key === "GIT_INDEX_FILE") {
      delete env[key];
    }
  }
  return {
    ...env,
    GIT_DIR: f.gitDir,
    GIT_WORK_TREE: cwd,
    GIT_INDEX_FILE: f.indexFile,
    /* The shadow repo must never inherit config — a global commit.gpgsign or
       a safe.directory entry would leak the caller's git setup into it. */
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

async function git(f: Folder, cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", [...identity, ...args], {
    cwd,
    env: shadowEnv(f, cwd),
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

async function gitOr(
  f: Folder,
  cwd: string,
  args: string[],
): Promise<string | null> {
  try {
    return await git(f, cwd, args);
  } catch {
    return null;
  }
}

/**
 * Session-folder checkpoints (issue #134): a per-folder *shadow* git dir
 * under `~/.lilos/checkpoints/<folder-hash>` that snapshots the worktree at
 * each turn start and restores it on rewind. The user's own `.git`, index,
 * stash and HEAD are never touched — every command runs with GIT_DIR /
 * GIT_WORK_TREE / GIT_INDEX_FILE pointed at the shadow store, so non-git
 * folders snapshot identically. Ported from hermes-agent's
 * `tools/checkpoint_manager.py` (MIT), adapted to per-folder stores with
 * unrelated per-checkpoint refs (no parent chain, so pruning is just ref
 * deletion + gc) and a restore that also unlinks files created after the
 * checkpoint.
 */
export interface CheckpointStore {
  /** Snapshot `cwd`; returns the checkpoint id (commit sha). Idempotent —
      an unchanged worktree returns the previous checkpoint. */
  snapshot(cwd: string): Promise<string>;
  /**
   * Restore `cwd` to the checkpoint's tree: tracked-at-checkpoint files are
   * rewritten, files created afterwards are removed (except excluded dirs
   * like node_modules), and the pre-restore state is itself checkpointed so
   * a rewind is undoable. Throws PATH_NOT_FOUND on an unknown id.
   */
  restore(
    cwd: string,
    checkpoint: string,
  ): Promise<{ removed: string[]; restoredTo: string }>;
  /** Newest-first checkpoint list for the folder. */
  list(cwd: string): Promise<{ id: string; at: number }[]>;
  /** Drop checkpoints past the retention window (default: last 50 / 7 days). */
  prune(opts?: { keep?: number; maxAgeMs?: number }): Promise<void>;
}

export function createCheckpointStore(root: string): CheckpointStore {
  /** In-process serialization: two sessions sharing a folder can start turns
      at once; a per-folder chain keeps their `git add -A` index locks apart. */
  const chains = new Map<string, Promise<unknown>>();

  const folderFor = async (cwd: string): Promise<Folder> => {
    const real = await fsp.realpath(cwd).catch(() => cwd);
    const key = createHash("sha256").update(real).digest("hex").slice(0, 16);
    const dir = join(root, key);
    const f: Folder = {
      dir,
      gitDir: join(dir, "repo"),
      indexFile: join(dir, "index"),
      metaFile: join(dir, "meta.json"),
    };
    if (!existsSync(join(f.gitDir, "HEAD"))) {
      await fsp.mkdir(join(f.gitDir, "info"), { recursive: true });
      await run("git", ["init", "--bare", f.gitDir]);
      await fsp.writeFile(join(f.gitDir, "info", "exclude"), DEFAULT_EXCLUDES);
      await fsp.writeFile(
        f.metaFile,
        JSON.stringify({ path: real, count: 0, checkpoints: [] }),
      );
    }
    return f;
  };

  const readMeta = async (f: Folder): Promise<Meta> => {
    try {
      return JSON.parse(await fsp.readFile(f.metaFile, "utf8")) as Meta;
    } catch {
      return { path: "", count: 0, checkpoints: [] };
    }
  };

  const writeMeta = (f: Folder, meta: Meta) =>
    fsp.writeFile(f.metaFile, JSON.stringify(meta));

  const tip = (f: Folder, cwd: string) =>
    gitOr(f, cwd, ["rev-parse", "--verify", "--quiet", TIP]).then(
      (o) => o?.trim() || null,
    );

  const enqueue = <T>(cwd: string, fn: () => Promise<T>): Promise<T> => {
    const key = cwd;
    const next = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
    chains.set(
      key,
      next.catch(() => {}),
    );
    return next;
  };

  const snapshotIn = async (cwd: string): Promise<string> => {
    const f = await folderFor(cwd);
    const meta = await readMeta(f);
    const before = await tip(f, cwd);
    if (before && meta.indexSeed !== before) {
      await git(f, cwd, ["read-tree", before]);
    }
    await git(f, cwd, ["add", "-A", "--", "."]);
    const tree = (await git(f, cwd, ["write-tree"])).trim();
    if (before) {
      const beforeTree = (
        await git(f, cwd, ["rev-parse", `${before}^{tree}`])
      ).trim();
      if (beforeTree === tree) return before;
    }
    const seq = ++meta.count;
    const commitArgs = ["commit-tree", tree, "-m", `checkpoint ${seq}`];
    const sha = (
      await git(f, cwd, commitArgs)
    ).trim();
    await git(f, cwd, ["update-ref", TIP, sha]);
    /* Each checkpoint gets its own ref and NO parent — the chain would keep
       every ancestor reachable and make retention pruning impossible. */
    await git(f, cwd, [
      "update-ref",
      `${CKPT}/${String(seq).padStart(8, "0")}`,
      sha,
    ]);
    meta.indexSeed = sha;
    meta.checkpoints.push({ id: sha, at: Date.now(), seq });
    await writeMeta(f, meta);
    await pruneFolder(f, cwd, meta);
    return sha;
  };

  const pruneFolder = async (
    f: Folder,
    cwd: string,
    meta: Meta,
    opts?: { keep?: number; maxAgeMs?: number },
  ) => {
    const keep = opts?.keep ?? CHECKPOINT_KEEP;
    const cutoff = Date.now() - (opts?.maxAgeMs ?? CHECKPOINT_MAX_AGE_MS);
    const cps = meta.checkpoints;
    const kept = cps.filter((c, i) => cps.length - 1 - i < keep && c.at >= cutoff);
    /* Never drop the tip: it seeds the next snapshot's index and is the
       restore path's safety snapshot target. */
    if (kept.length === 0 && cps.length > 0) kept.push(cps[cps.length - 1]!);
    if (kept.length === cps.length) return;
    const dropping = cps.filter((c) => !kept.some((k) => k.id === c.id));
    for (const c of dropping) {
      await gitOr(f, cwd, [
        "update-ref",
        "-d",
        `${CKPT}/${String(c.seq).padStart(8, "0")}`,
      ]);
    }
    meta.checkpoints = kept;
    await writeMeta(f, meta);
    await gitOr(f, cwd, ["gc", "--prune=now", "--quiet"]);
  };

  const restoreIn = async (cwd: string, checkpoint: string) => {
    const f = await folderFor(cwd);
    const kind = await gitOr(f, cwd, ["cat-file", "-t", checkpoint]);
    if (kind?.trim() !== "commit") {
      throw new HostError(
        HOST_ERRORS.PATH_NOT_FOUND,
        `no checkpoint ${checkpoint} for ${cwd}`,
      );
    }
    /* Safety snapshot first — the rewind itself stays undoable, and it
       refreshes the shadow index to the real worktree before we compare. */
    await snapshotIn(cwd);
    const meta = await readMeta(f);
    await git(f, cwd, ["read-tree", checkpoint]);
    await git(f, cwd, ["checkout-index", "-f", "-a"]);
    meta.indexSeed = checkpoint;
    await writeMeta(f, meta);
    /* Files created after the checkpoint aren't in its tree — the index is
       now exactly that tree, so untracked non-excluded paths are the extras. */
    const raw = await git(f, cwd, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const extras = raw.split("\0").filter(Boolean);
    const dirs = new Set<string>();
    for (const rel of extras) {
      await fsp.rm(join(cwd, rel), { recursive: true, force: true });
      let d = dirname(join(cwd, rel));
      while (d !== cwd && d.startsWith(cwd)) {
        dirs.add(d);
        d = dirname(d);
      }
    }
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
      await fsp.rmdir(d).catch(() => {});
    }
    return { removed: extras, restoredTo: checkpoint };
  };

  return {
    snapshot: (cwd) => enqueue(cwd, () => snapshotIn(cwd)),
    restore: (cwd, checkpoint) =>
      enqueue(cwd, () => restoreIn(cwd, checkpoint)),
    list: async (cwd) => {
      const f = await folderFor(cwd);
      const meta = await readMeta(f);
      return [...meta.checkpoints].reverse();
    },
    prune: async (opts) => {
      if (!existsSync(root)) return;
      for (const name of await fsp.readdir(root)) {
        const dir = join(root, name);
        const metaFile = join(dir, "meta.json");
        if (!existsSync(metaFile)) continue;
        const meta = await readMeta({
          dir,
          gitDir: join(dir, "repo"),
          indexFile: join(dir, "index"),
          metaFile,
        });
        const f: Folder = {
          dir,
          gitDir: join(dir, "repo"),
          indexFile: join(dir, "index"),
          metaFile,
        };
        await enqueue(meta.path, () => pruneFolder(f, meta.path, meta, opts));
      }
    },
  };
}
