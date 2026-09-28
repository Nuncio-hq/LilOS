/* Host API client (issue #113, AC-1): POST <feed-origin>/host carries one
   JSON-RPC frame to the harness, which runs packages/host on this machine.
   Auth is the install token the app already holds (cfg.relayToken), same as
   the harness feed's. The prototype keeps its own dev-plugin client
   (prototype/web/src/host.ts). */

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
    error?: { code: number; message: string };
  };
  if (frame.error) throw new Error(frame.error.message);
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
