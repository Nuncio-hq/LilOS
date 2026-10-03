import Constants from "expo-constants";
import { atom } from "nanostores";
import { NativeModules } from "react-native";

/* Dev-build network spy (#168 evidence): wraps the three JS-level network
   surfaces (fetch, WebSocket, XMLHttpRequest — every app request including
   the relay socket and pairing exchange goes through them) and counts the
   calls into an atom the NetSpyBadge renders. Two buckets: `app` = the
   evidence counter that must read zero through the offline demo flow;
   `dev` = calls to the Metro/dev-server authority (bundle serving, HMR,
   symbolication) — dev tooling, tracked separately so the filter is
   visible instead of hidden. Installed in index.ts under __DEV__ only;
   production builds never load this file's hooks. */

export interface NetSpyCount {
  app: number;
  dev: number;
}

export const $netSpy = atom<NetSpyCount>({ app: 0, dev: 0 });

/** Every counted non-dev call, in order — surfaced for evidence. */
export const netSpyTrail: { kind: string; url: string; at: number }[] = [];

const GLOBAL_KEY = "__lilosNetSpyInstalled";

function urlText(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const url = (input as { url?: unknown }).url;
    if (typeof url === "string") return url;
    const href = (input as { href?: unknown }).href;
    if (typeof href === "string") return href;
  }
  return String(input ?? "");
}

/** Authorities that belong to the dev bundler, not the app. */
function devAuthorities(): Set<string> {
  const hosts = new Set<string>();
  const add = (raw: string | undefined | null) => {
    if (!raw) return;
    try {
      const u = new URL(raw.includes("://") ? raw : `exp://${raw}`);
      if (u.host) hosts.add(u.host);
    } catch {
      /* hostUri forms like "172.16.4.2:8081" parse via the exp:// shim */
      const host = raw.split("/")[0];
      if (host) hosts.add(host);
    }
  };
  add(Constants.expoConfig?.hostUri);
  const scriptURL = (NativeModules as { SourceCode?: { scriptURL?: string } })
    .SourceCode?.scriptURL;
  add(scriptURL);
  /* Metro is also reachable as localhost/127.0.0.1 on its port. */
  const port =
    [...hosts]
      .map((h) => h.split(":")[1])
      .find((p): p is string => Boolean(p)) ?? "8081";
  hosts.add(`localhost:${port}`);
  hosts.add(`127.0.0.1:${port}`);
  hosts.add(`[::1]:${port}`);
  return hosts;
}

export function installNetSpy(): void {
  const g = globalThis as Record<string, unknown>;
  if (g[GLOBAL_KEY]) return;
  g[GLOBAL_KEY] = true;

  const devHosts = devAuthorities();
  const record = (kind: string, url: string) => {
    let dev = false;
    try {
      dev = devHosts.has(new URL(url).host);
    } catch {
      /* unparseable targets count as app calls */
    }
    const c = $netSpy.get();
    $netSpy.set({ app: c.app + (dev ? 0 : 1), dev: c.dev + (dev ? 1 : 0) });
    if (!dev) {
      netSpyTrail.push({ kind, url, at: Date.now() });
      console.warn(`[netspy] APP ${kind} ${url}`);
    }
  };

  /* RN's fetch delegates to XMLHttpRequest internally — suppress the XHR
     counter while a fetch is being issued so one call doesn't count twice. */
  let suppressXhr = 0;
  const origFetch = globalThis.fetch;
  if (origFetch) {
    globalThis.fetch = ((input: unknown, init?: unknown) => {
      record("fetch", urlText(input));
      suppressXhr += 1;
      try {
        return origFetch(input as never, init as never);
      } finally {
        suppressXhr -= 1;
      }
    }) as typeof fetch;
  }

  const OrigWS = globalThis.WebSocket;
  if (OrigWS) {
    const SpyWS = function (this: unknown, url: string, protocols?: unknown) {
      record("ws", url);
      return Reflect.construct(OrigWS as never, [url, protocols]) as WebSocket;
    } as unknown as typeof WebSocket;
    SpyWS.prototype = OrigWS.prototype;
    Object.setPrototypeOf(SpyWS, OrigWS);
    globalThis.WebSocket = SpyWS;
  }

  const OrigXHR = globalThis.XMLHttpRequest;
  if (OrigXHR) {
    const SpyXHR = function (this: XMLHttpRequest) {
      const xhr = Reflect.construct(OrigXHR as never, []) as XMLHttpRequest;
      const open = xhr.open.bind(xhr);
      xhr.open = ((method: string, url: string, ...rest: unknown[]) => {
        if (suppressXhr === 0) record("xhr", url);
        return open.call(xhr, method, url, ...(rest as [boolean?]));
      }) as XMLHttpRequest["open"];
      return xhr;
    } as unknown as typeof XMLHttpRequest;
    SpyXHR.prototype = OrigXHR.prototype;
    Object.setPrototypeOf(SpyXHR, OrigXHR);
    globalThis.XMLHttpRequest = SpyXHR;
  }
}
