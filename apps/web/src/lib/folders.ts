/* Folder picking for a DM session (issue #113): the relay owns the shared
   recents (folders.list / folders.add), the host API probes each path
   (missing / git branches). One atom feeds the composer picker; cwdInfo
   feeds the thread header badge. */

import type { Folder, FsDir, Workspace } from "@lilos/ui/types";
import { atom } from "nanostores";
import {
  hostBranches,
  hostDiscoverRepos,
  hostIsRepo,
  hostList,
  hostRoots,
} from "./host";
import { relay } from "./runtime";

/** Picker rows, newest first (relay order). `id` is the path itself. */
export const folders = atom<Folder[]>([]);

/** Dir listings the AddFolderDialog browses (keyed by requested path). */
export const fsRows = atom<Record<string, FsDir>>({});

/** "Found on this Mac" repos for the dialog header. */
export const discovered = atom<string[]>([]);

/** cwd → repo head (null = probed, not a repo; absent = not probed yet). */
export const cwdInfo = atom<Record<string, { branch: string } | null>>({});

const probed = new Set<string>();
const dirCache = new Map<string, Promise<Record<string, FsDir> | null>>();

async function probeFolder(path: string): Promise<Folder> {
  try {
    await hostList(path);
  } catch {
    return {
      id: path,
      project: "",
      path,
      branches: [],
      workstreams: [],
      missing: true,
    };
  }
  const git = await hostBranches(path).catch(() => null);
  return {
    id: path,
    project: "",
    path,
    repo: git?.remote ?? undefined,
    branches: git?.branches ?? [],
    workstreams: [],
  };
}

/** Pull the relay's recents and probe each (missing paths stay, disabled). */
export async function refreshFolders(): Promise<void> {
  const res = await relay.request<{ folders: { path: string }[] }>(
    "folders.list",
    {},
  );
  folders.set(await Promise.all(res.folders.map((f) => probeFolder(f.path))));
}

/** Add a picked path to the shared recents, then refresh the rows. */
export async function addFolder(path: string): Promise<Folder | undefined> {
  await relay.request("folders.add", { path });
  await refreshFolders();
  return folders.get().find((f) => f.path === path);
}

/** Lazy probe for a conversation's cwd (thread header branch). */
export function probeCwd(path: string): void {
  if (probed.has(path)) return;
  probed.add(path);
  void (async () => {
    const repo = await hostIsRepo(path).catch(() => null);
    if (!repo?.isRepo) {
      cwdInfo.set({ ...cwdInfo.get(), [path]: null });
      return;
    }
    const b = await hostBranches(path).catch(() => null);
    cwdInfo.set({ ...cwdInfo.get(), [path]: { branch: b?.current ?? "" } });
  })();
}

/** Header badge workspace for a stored conversation cwd (AC-7). */
export function wsFor(
  cwd: string | undefined,
  info: Record<string, { branch: string } | null>,
): Workspace | undefined {
  if (!cwd) return undefined;
  probeCwd(cwd);
  const project = cwd.split("/").filter(Boolean).pop() ?? cwd;
  const branch = info[cwd]?.branch ?? "";
  return { folder: cwd, project, mode: "direct", base: branch, branch, cwd };
}

/* ------------------------- AddFolderDialog data ------------------------- */

/* fs.list → FsDir rows: the dir's children + a git-marked stub per repo
   child; the dir's own repo mark too (ported from prototype host.ts). */
export function needDir(path: string): Promise<Record<string, FsDir> | null> {
  let p = dirCache.get(path);
  if (!p) {
    p = (async () => {
      const r = await hostList(path);
      const out: Record<string, FsDir> = {};
      const children: string[] = [];
      // Key by the requested path: the host may `~`-collapse the result.
      const dir = path === "/" ? "" : path;
      for (const e of r.entries) {
        if (e.kind !== "dir" || e.name.startsWith(".")) continue;
        children.push(e.name);
        out[`${dir}/${e.name}`] = e.repo
          ? {
              git: {
                branches: [e.repo.head ?? "HEAD"],
                remote: e.repo.remote ?? undefined,
              },
            }
          : {};
      }
      const self = await hostIsRepo(r.path)
        .then((x) => (x.isRepo ? hostBranches(r.path) : null))
        .catch(() => null);
      out[path] = {
        children,
        ...(self
          ? {
              git: {
                branches: self.branches.length
                  ? self.branches
                  : [self.current ?? "HEAD"],
                remote: self.remote ?? undefined,
              },
            }
          : {}),
      };
      if (r.path !== path) out[r.path] = out[path];
      return out;
    })().catch(() => null);
    dirCache.set(path, p);
    // A failed listing is not cached — the next needDir retries.
    void p.then((m) => {
      if (m === null) dirCache.delete(path);
    });
  }
  return p;
}

/** onNeedDir for the dialog: merge a listing into the fsRows atom. */
export function loadDir(path: string): void {
  void needDir(path).then((m) => {
    if (m) fsRows.set({ ...fsRows.get(), ...m });
  });
}

/** git.discoverRepos over the usual roots → "Found on this Mac" rows. */
export async function loadDiscovered(): Promise<void> {
  const r = await hostDiscoverRepos(hostRoots()).catch(() => null);
  if (!r) return;
  const stubs: Record<string, FsDir> = {};
  for (const x of r.repos) {
    stubs[x.path] = {
      git: { branches: [x.head ?? "HEAD"], remote: x.remote ?? undefined },
    };
  }
  discovered.set(r.repos.map((x) => x.path));
  fsRows.set({ ...fsRows.get(), ...stubs });
}
