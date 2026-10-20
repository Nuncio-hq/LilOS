/* Default import on purpose, NOT `import { createHash } from "node:crypto"`:
   browser bundles reach this file through `@lilos/surfaces` → `gateway.ts`
   (prototype/web's live tabs import `openViewer` from the index). Bundlers
   compile named imports of an external module into eager member accesses
   at module-eval time, and the `browser-external` shim throws on ANY
   access — which crashed every prototype page load in e2e. The default
   binding is only dereferenced inside `equalSecret`, which no browser path
   ever calls, so the module stays inert in browser bundles. */
import nodeCrypto from "node:crypto";

/**
 * Constant-time secret compare: hash both sides, then `timingSafeEqual`
 * over the fixed-size digests. A plain `!==`/`===` early-exits on the
 * first differing byte, so a remote caller that can time auth round-trips
 * could read off the longest matching prefix. Digests keep the compare
 * fixed-cost for any input length.
 *
 * The ONE implementation for every loopback auth gate (#611 — lifted out
 * of apps/relay's auth.ts, where #568 introduced it): the relay's
 * `session.hello` and paired-device credential, the harness `/host` bearer
 * and feed `/ws` upgrade, the engine adapter `/ws` (via
 * `authorizeLoopbackUpgrade`), the surfaces `/view` socket and the agent
 * gateway's session/engine bearers. `node:crypto` keeps it runtime-neutral
 * (Bun + Node), which contracts requires anyway.
 */
export function equalSecret(a: string, b: string): boolean {
  return nodeCrypto.timingSafeEqual(
    nodeCrypto.createHash("sha256").update(a).digest(),
    nodeCrypto.createHash("sha256").update(b).digest(),
  );
}

/** Query key the loopback upgrade gate reads. Browsers cannot set headers
 *  on a WebSocket, so the credential rides the URL — the same carrier the
 *  harness feed and the surfaces viewer already use. */
const UPGRADE_TOKEN_PARAM = "token";

/**
 * D-#564: the upgrade gate shared by every loopback listener that speaks
 * this check — the harness feed `/ws` and the engine adapter `/ws` (#752).
 * Run it before `server.upgrade`, so a refusal never attaches and never
 * sees a frame.
 *
 * The credential is whatever the caller configured (the install token for
 * the feed, a per-launch token for the engine adapter). An empty configured
 * credential authenticates nothing. Comparison is `equalSecret`. A wrong or
 * missing `?token=` is 401.
 *
 * `Origin`: a browser always sends it; script clients (Bun `WebSocket`,
 * `ws`, curl, the harness) don't — absence means "not a browser", not a
 * failure. When present it must be the app's own: a loopback http(s) host
 * (dev server, `vite preview`, and e2e pick their own ports, so the check
 * is scheme+host, not port), `file://`, or `null`. Blink serializes a
 * file: document's origin as `null` unless `--allow-file-access-from-files`
 * is set, so the packaged Electron window can arrive as either. `null` also
 * covers other opaque origins (sandboxed iframes, data:); the token remains
 * the credential — this check only filters serialized foreign origins.
 * A foreign page can open a WebSocket to 127.0.0.1 (the handshake is not
 * CORS-gated) and its Origin is the site's own, so loopback-only origins
 * keep that page out even if a token ever leaked to it.
 */
export function authorizeLoopbackUpgrade(
  req: Request,
  token: string,
): Response | undefined {
  if (
    !token ||
    !equalSecret(
      new URL(req.url).searchParams.get(UPGRADE_TOKEN_PARAM) ?? "",
      token,
    )
  ) {
    return new Response("unauthorized\n", { status: 401 });
  }
  const origin = req.headers.get("origin");
  if (origin !== null && !appOrigin(origin)) {
    return new Response("forbidden origin\n", { status: 403 });
  }
  return undefined;
}

/** Put the protocol credential on a `ws://` URL the gate will accept.
 *  The engine prints `LISTENING` without it; only the harness's in-memory
 *  url carries the query. */
export function withEngineProtocolToken(url: string, token: string): string {
  const next = new URL(url);
  next.searchParams.set(UPGRADE_TOKEN_PARAM, token);
  return next.toString();
}

const appOrigin = (origin: string): boolean => {
  if (origin === "null" || origin === "file://") return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "127.0.0.1" ||
      host === "::1"
    );
  } catch {
    return false;
  }
};
