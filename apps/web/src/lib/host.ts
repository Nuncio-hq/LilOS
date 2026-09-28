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

/** OS account name — first-run prefill source for the identity fields (#118). */
export const hostUser = () =>
  host<{ username: string; fullName: string | null }>("host.user", {});
