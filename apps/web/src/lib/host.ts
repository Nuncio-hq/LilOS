/* Host API client (issue #113, AC-1): POST <feed-origin>/host carries one
   JSON-RPC frame to the harness, which runs packages/host on this machine.
   Auth is the install token the app already holds (cfg.relayToken), same as
   the harness feed's. The prototype keeps its own dev-plugin client
   (prototype/web/src/host.ts). */

import { ForgeGhErrorData, HOST_ERRORS } from "@lilos/contracts/host";
import type {
  CheckRun,
  Diff,
  HostAccessors,
  PrError,
  PullRequest,
} from "@lilos/ui/types";

let endpoint = "";
let token = "";
let rootsOverride: string[] | undefined;
let seq = 0;

/** Wire the client from boot config: ws(s)://…/ws → http(s)://…/host.
 *  `?roots=` (dev/e2e scan-roots override) is captured here at boot — later
 *  in-app navigation drops the query. */
export function initHost(cfg: { engineWs: string; relayToken: string }): void {
  const u = new URL(cfg.engineWs);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = "/host";
  u.search = "";
  u.hash = "";
  endpoint = u.toString();
  token = cfg.relayToken;
  rootsOverride =
    new URLSearchParams(window.location.search).get("roots")?.split(",") ??
    undefined;
}

/** Scan roots for git.discoverRepos (`?roots=` override or the defaults). */
export function hostRoots(): string[] {
  return (
    rootsOverride ?? ["~/Desktop", "~/Developer", "~/Documents", "~/repos"]
  );
}

/** A host-answered error: `code` is the JSON-RPC code (`HOST_ERRORS.*`),
    absent on transport failures (HTTP error, bad frame). Callers key on it —
    e.g. NOT_A_REPO means the tab stays hidden, GH_FAILED reads plainly. */
export class HostError extends Error {
  code?: number;
  /** Host-side error data (e.g. forge's `{reason, detail}` on GH_FAILED). */
  data?: unknown;
}

async function host<T>(method: string, params?: unknown): Promise<T> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
  });
  if (!res.ok) throw new Error(`host ${method}: HTTP ${res.status}`);
  const frame = (await res.json()) as {
    result?: T;
    error?: { code: number; message: string; data?: unknown };
  };
  if (frame.error) {
    const err = new HostError(frame.error.message);
    err.code = frame.error.code;
    err.data = frame.error.data;
    throw err;
  }
  return frame.result as T;
}

export type ListResult = {
  path: string;
  entries: {
    name: string;
    kind: "dir" | "file" | "other";
    repo?: { head: string | null; remote: string | null };
  }[];
};

export type BranchesResult = {
  root: string;
  current: string | null;
  branches: string[];
  remote: string | null;
};

export const hostList = (path: string) => host<ListResult>("fs.list", { path });
export const hostIsRepo = (path: string) =>
  host<{ isRepo: boolean }>("git.isRepo", { path });
export const hostBranches = (path: string) =>
  host<BranchesResult>("git.branches", { path });
export const hostDiscoverRepos = (roots: string[]) =>
  host<{
    repos: { path: string; head: string | null; remote: string | null }[];
  }>("git.discoverRepos", { roots, depth: 2 });

/* ---------------- Workbench accessors (issue #114) ----------------
   Ported from prototype/web/src/host.ts: fs.tree/git.diff/fs.read read the
   session's real cwd; forge.* drive `gh`. Every read resolves null when its
   method doesn't answer (tab stays hidden, D-#19); writes throw. */

/* Forge wire shape (@lilos/contracts forge.pr result's `pr`, minus {root,branch}). */
type WirePr = {
  number: number;
  url: string;
  repo: string;
  title: string;
  body: string;
  state: "open" | "merged" | "closed";
  author: string;
  base: string;
  head: string;
  openedAt: string;
  merged?: { by: string; at: string; sha: string };
  mergeable: "mergeable" | "conflicting" | "unknown";
  checks: { name: string; status: CheckRun["status"] }[];
  comments: { author: string; at: string; body: string }[];
};

/* Relative time for comment headers ("2h", "3d") — keeps the panel quiet. */
const rel = (iso: string) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!(s >= 0)) return "just now";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

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
  merged: w.merged
    ? { by: w.merged.by, at: rel(w.merged.at), sha: w.merged.sha }
    : undefined,
  opened: rel(w.openedAt),
  checks: w.checks.map((c) => ({ name: c.name, status: c.status })),
  comments: w.comments.map((c) => ({
    from: c.author,
    time: rel(c.at),
    text: c.body,
  })),
});

export const hostAccessors: HostAccessors = {
  tree: (cwd) =>
    host<{ files: string[] }>("fs.tree", { path: cwd })
      .then((r) => r.files)
      .catch(() => null),
  diff: (cwd) =>
    host<{ files: Diff[] }>("git.diff", { path: cwd })
      .then((r) => r.files)
      .catch(() => null),
  read: (cwd, path) =>
    host<{ content: string; binary: boolean; truncated: boolean }>("fs.read", {
      path: `${cwd}/${path}`,
    }).catch(() => null),
  /* forge.pr → {pr} for the checkout's branch; outer null = the method didn't
     answer, {pr:null} = no PR on the branch, {error} = gh failed, with the
     host-classified reason the tab maps to plain copy (#114 AC-5). */
  pr: (cwd) =>
    host<{ branch?: string; pr: WirePr | null }>("forge.pr", { path: cwd })
      .then((r) => ({ pr: r.pr ? mapPr(r.pr) : null, branch: r.branch }))
      .catch((e) => {
        if (!(e instanceof HostError)) return null;
        if (e.code === HOST_ERRORS.NOT_A_REPO) return null;
        const d = ForgeGhErrorData.safeParse(e.data);
        const error: PrError = d.success
          ? d.data
          : { reason: "other", detail: e.message };
        return { pr: null, error };
      }),
  /* forge.comment → the new comment's URL (errors bubble to the panel). */
  prComment: (cwd, body) =>
    host<{ url: string }>("forge.comment", { path: cwd, body }).then(
      (r) => r.url,
    ),
  /* forge.merge → the re-read PR (never stdout trust). */
  prMerge: (cwd, method) =>
    host<{ pr: WirePr }>("forge.merge", { path: cwd, method }).then((r) =>
      mapPr(r.pr),
    ),
  /* os.editors / os.open (issue #110): the Focus header's OpenPathButton and
     the Workbench rows render only when these answer (D-#19). */
  osEditors: () =>
    host<{ editors: OsEditor[] }>("os.editors", {}).then((r) => r.editors),
  osOpen: (cwd, path, app, line) =>
    host<Record<string, never>>("os.open", { root: cwd, path, app, line }).then(
      () => undefined,
    ),
};

export type OsEditor = {
  id: "vscode" | "cursor" | "zed" | "xcode";
  name: string;
};
export type OsApp = OsEditor["id"] | "finder";

/* Capability check (issue #110, D-#19): os.open/os.editors exist on the host
   — controls render only then. One describe per app boot, cached; an
   unreachable host answers "no methods" so the controls simply hide. */
let methodsP: Promise<Set<string>> | null = null;
const hostMethods = () =>
  (methodsP ??= host<{ methods: string[] }>("host.describe")
    .then((r) => new Set(r.methods))
    .catch(() => new Set<string>()));

/** Editors the host detected (os.editors); null when os.open isn't there. */
export async function hostEditors(): Promise<OsEditor[] | null> {
  const m = await hostMethods();
  if (!m.has("os.open")) return null;
  if (!m.has("os.editors")) return [];
  return host<{ editors: OsEditor[] }>("os.editors", {})
    .then((r) => r.editors)
    .catch(() => [] as OsEditor[]);
}

/** os.open: open `path` inside `root` in `app`, at `line` if given. */
export const hostOsOpen = (
  root: string,
  path: string,
  app: OsApp,
  line?: number,
) =>
  host<Record<string, never>>("os.open", { root, path, app, line }).then(
    () => undefined,
  );

export type SearchResult = {
  path: string;
  files: { path: string; kind: "file" | "dir" }[];
};

/** `@`-mention file search inside a session folder (issue #105). */
export const hostSearch = (path: string, query: string, limit?: number) =>
  host<SearchResult>("fs.search", { path, query, ...(limit ? { limit } : {}) });

/** OS account name — first-run prefill source for the identity fields (#118). */
export const hostUser = () =>
  host<{ username: string; fullName: string | null }>("host.user", {});
