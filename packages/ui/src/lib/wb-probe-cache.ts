/* Issue #544: last-known Workbench reads per session folder, held in a
   module store — outside component state, so closing the panel or leaving
   Focus and coming back shows them on the first frame while fresh reads
   revalidate behind (stale-while-revalidate). Same rationale as
   lib/diff-comments.ts (D-#320): module stores outlive unmounts.

   Key = host + cwd: a WeakMap per host keeps entries for the app's run
   without leaking the host accessors themselves, and each host's map is
   bounded to the last 10 folders (LRU on read and write). */
import type {
  Diff,
  GitCommit,
  HostAccessors,
  PrError,
  PullRequest,
} from "../types";

/* The Workbench's probe answer set — `null` per field means "the host
   method didn't answer" (fs unreachable, path not a repo, `gh` missing). */
export type WbProbeData = {
  files: string[] | null;
  diffs: Diff[] | null;
  pr: {
    pr: PullRequest | null;
    branch?: string;
    error?: PrError;
  } | null;
  status: { branch: string | null; clean: boolean } | null;
  branches: {
    current: string | null;
    remote: string | null;
    default: string | null;
  } | null;
  log: GitCommit[] | null;
};

export type WbViewFile = {
  path: string;
  content: string;
  binary: boolean;
  truncated: boolean;
  /** Line a `workbench_open` pointed at — highlighted + scrolled to. */
  line?: number;
};

export type WbCacheEntry = {
  probe: WbProbeData;
  /** Changes tab's selected file + the open file view (AC-4). */
  sel: string | null;
  viewFile: WbViewFile | null;
  updatedAt: number;
};

export const EMPTY_WB_PROBE: WbProbeData = {
  files: null,
  diffs: null,
  pr: null,
  status: null,
  branches: null,
  log: null,
};

const EMPTY_ENTRY: WbCacheEntry = {
  probe: EMPTY_WB_PROBE,
  sel: null,
  viewFile: null,
  updatedAt: 0,
};

const CAP = 10; // folders per host
const stores = new WeakMap<HostAccessors, Map<string, WbCacheEntry>>();

const forHost = (host: HostAccessors): Map<string, WbCacheEntry> => {
  let m = stores.get(host);
  if (!m) {
    m = new Map();
    stores.set(host, m);
  }
  return m;
};

/** Last-known entry for the folder — bumps its recency on a hit. */
export function readWbCache(
  host: HostAccessors,
  cwd: string,
): WbCacheEntry | undefined {
  const m = stores.get(host);
  const e = m?.get(cwd);
  if (m && e) {
    m.delete(cwd);
    m.set(cwd, e);
  }
  return e;
}

/** Merge into the folder's entry (LRU-bounded at 10 per host). */
export function patchWbCache(
  host: HostAccessors,
  cwd: string,
  patch: (e: WbCacheEntry) => WbCacheEntry,
): void {
  const m = forHost(host);
  const next = patch(m.get(cwd) ?? EMPTY_ENTRY);
  m.delete(cwd); // refresh recency
  m.set(cwd, next);
  while (m.size > CAP) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}
