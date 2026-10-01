import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckpointStore } from "../src/index";

/**
 * Issue #134: harness-owned file checkpoints — a shadow git dir per session
 * folder under the store root; the user's own .git/index/stash are never
 * touched and non-git folders work identically.
 */

let root: string;
let cwd: string;

const read = (p: string) => readFileSync(join(cwd, p), "utf8");
const write = (p: string, text: string) => {
  const abs = join(cwd, p);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
};
const gitCwd = (args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
/** Hash every byte of .git: HEAD, refs, index, objects, stash — all of it. */
const snapshotUserGit = (dir: string) => {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      h.update(name);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) h.update(readFileSync(p));
    }
  };
  walk(join(dir, ".git"));
  return h.digest("hex");
};
const metaDir = () =>
  join(
    root,
    createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 16),
  );

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lilos-ckpt-"));
  cwd = mkdtempSync(join(tmpdir(), "lilos-work-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("AC-1 rewind restores files; user git state untouched", () => {
  it.each(["git repo", "plain folder"])(
    "edits reverted, created files removed, deleted files back (%s)",
    async (kind) => {
      write("keep.txt", "v1\n");
      write("sub/gone.txt", "old\n");
      let userGitBefore: string | null = null;
      if (kind === "git repo") {
        gitCwd(["init", "-q"]);
        /* The commit below spawns git's detached auto-maintenance, which
           creates/deletes .git/objects/maintenance.lock mid-snapshot
           (ENOENT between readdirSync and statSync) and can drift the
           before/after hash — seen on Linux CI (#357). Off for this repo. */
        gitCwd(["config", "gc.auto", "0"]);
        gitCwd(["config", "maintenance.auto", "false"]);
        gitCwd(["add", "-A"]);
        gitCwd([
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "commit",
          "-qm",
          "init",
        ]);
        userGitBefore = snapshotUserGit(cwd);
      }

      const store = createCheckpointStore(root);
      const cp = await store.snapshot(cwd);
      expect(cp).toMatch(/^[0-9a-f]{40}$/);

      // the "agent" turn: edit, create, delete
      write("keep.txt", "v2 edited\n");
      write("new-file.txt", "created by the turn\n");
      write("deep/new/extra.txt", "x\n");
      rmSync(join(cwd, "sub/gone.txt"));

      const res = await store.restore(cwd, cp);
      expect(read("keep.txt")).toBe("v1\n");
      expect(read("sub/gone.txt")).toBe("old\n");
      expect(existsSync(join(cwd, "new-file.txt"))).toBe(false);
      expect(existsSync(join(cwd, "deep"))).toBe(false);
      expect(res.removed.sort()).toEqual([
        "deep/new/extra.txt",
        "new-file.txt",
      ]);

      if (userGitBefore) {
        // the user's own .git is byte-identical — index, refs, stash, HEAD
        expect(snapshotUserGit(cwd)).toEqual(userGitBefore);
      }
    },
  );

  it("files the folder's own .gitignore hides (.env) still snapshot and rewind", async () => {
    gitCwd(["init", "-q"]);
    write(".gitignore", ".env\n*.log\ntmp/\n");
    write(".env", "SECRET=one\n");
    write("keep.txt", "v1\n");
    const userGitBefore = snapshotUserGit(cwd);

    const store = createCheckpointStore(root);
    const cp = await store.snapshot(cwd);

    // the "agent" turn touches ignored paths: edits .env, creates .env.local
    write(".env", "SECRET=rewritten\n");
    write(".env.local", "NEW=1\n");
    write("debug.log", "noise\n");

    const res = await store.restore(cwd, cp);
    expect(read(".env")).toBe("SECRET=one\n");
    expect(existsSync(join(cwd, ".env.local"))).toBe(false);
    expect(existsSync(join(cwd, "debug.log"))).toBe(false);
    expect(res.removed.sort()).toEqual([".env.local", "debug.log"]);
    expect(snapshotUserGit(cwd)).toEqual(userGitBefore);
  });

  it("the shadow store lives outside the folder and never writes .git", async () => {
    const store = createCheckpointStore(root);
    await store.snapshot(cwd);
    expect(existsSync(join(cwd, ".git"))).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it("restore of an unknown checkpoint fails, changing nothing", async () => {
    write("keep.txt", "v1\n");
    const store = createCheckpointStore(root);
    await store.snapshot(cwd);
    write("keep.txt", "v2\n");
    await expect(store.restore(cwd, "0".repeat(40))).rejects.toThrow();
    expect(read("keep.txt")).toBe("v2\n");
  });

  it("a rewind is itself undoable (pre-restore snapshot)", async () => {
    write("keep.txt", "v1\n");
    const store = createCheckpointStore(root);
    const cp1 = await store.snapshot(cwd);
    write("keep.txt", "v2\n");
    await store.restore(cwd, cp1);
    // restore snapshotted "v2" before rolling back — rewind it to get v2 back
    const v2 = (await store.list(cwd)).find((c) => c.id !== cp1);
    expect(v2).toBeDefined();
    await store.restore(cwd, v2?.id ?? "");
    expect(read("keep.txt")).toBe("v2\n");
  });
});

describe("AC-6 snapshot cost and pruning", () => {
  it("incremental snapshot stays under 1s on a 50k-file tree", async () => {
    // 50k files across 200 dirs — hardlinks to one seed keep setup cheap.
    writeFileSync(join(cwd, "seed"), "");
    for (let d = 0; d < 200; d++) {
      const dir = join(cwd, "bulk", `d${d}`);
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 250; i++)
        linkSync(join(cwd, "seed"), join(dir, `f${i}`));
    }
    const store = createCheckpointStore(root);
    await store.snapshot(cwd); // cold: builds the index once
    write("bulk/d0/touched.txt", "x\n");
    const t0 = performance.now();
    await store.snapshot(cwd);
    expect(performance.now() - t0).toBeLessThan(1_000);
  }, 120_000);

  it("prunes to the retention window (max age)", async () => {
    const store = createCheckpointStore(root);
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      write("keep.txt", `v${i}\n`);
      ids.push(await store.snapshot(cwd));
    }
    // Age out the oldest five past the 7-day window via meta.json.
    const metaFile = join(metaDir(), "meta.json");
    const meta = JSON.parse(readFileSync(metaFile, "utf8")) as {
      checkpoints: { at: number }[];
    };
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 5; i++) {
      const cp = meta.checkpoints[i];
      if (cp) cp.at = old;
    }
    writeFileSync(metaFile, JSON.stringify(meta));

    await store.prune();
    const list = await store.list(cwd);
    expect(list.map((c) => c.id)).toEqual(ids.slice(5).reverse());
    /* Pruned refs are dropped; their objects linger until git's own gc
       threshold runs (`gc --auto` — a full repack every snapshot would blow
       the AC-6 budget), so a restore-by-sha can still land meanwhile. The
       contract is the listing, not the deletion. */
    expect(list.some((c) => c.id === ids[0])).toBe(false);
  });

  it("prunes to the retention window (last N)", async () => {
    const store = createCheckpointStore(root);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      write("keep.txt", `v${i}\n`);
      ids.push(await store.snapshot(cwd));
    }
    await store.prune({ keep: 3 });
    const list = await store.list(cwd);
    expect(list.map((c) => c.id)).toEqual(ids.slice(3).reverse());
  });
});
