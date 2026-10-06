/**
 * WebSocket Origin gate (#568): browsers always send an `Origin` header on
 * a ws upgrade and page JavaScript cannot forge it, so refusing foreign
 * origins keeps a page on another site from opening a socket to the
 * loopback relay and hammering `session.hello` token guesses. The install
 * token still does the real auth — this check only shrinks who can try.
 *
 * Allowed:
 * - no/absent `Origin` — non-browser clients (the `ws` package, React
 *   Native on the phone, the harness) send none;
 * - `file://` — the packaged Electron window loads the UI via `loadFile`;
 *   a remote page can't navigate to `file:`, so the scheme can't be
 *   minted from a website;
 * - `null` only with an Electron `User-Agent` — a foreign page can mint
 *   `Origin: null` through a sandboxed iframe or `data:` document, so the
 *   bare value isn't trusted; the packaged app sends Chromium's default
 *   UA, which always carries `Electron/` and can't be forged by page JS;
 * - loopback `http(s)` pages on any port — the vite dev/preview stack;
 * - an origin equal to the request's own `Host` — same-origin by
 *   definition (a deployment serving the page from the relay itself).
 * Everything else is refused before `server.upgrade`.
 */
const ELECTRON_UA = /\bElectron\//i;

export function wsUpgradeOriginAllowed(
  origin: string | null | undefined,
  host: string | null | undefined,
  userAgent: string | null | undefined,
): boolean {
  if (!origin) return true;
  if (origin === "null") return ELECTRON_UA.test(userAgent ?? "");
  const url = safeUrl(origin);
  if (!url) return false;
  if (url.protocol === "file:") return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (host && url.host === host) return true;
  return isLoopbackHost(url.hostname);
}

function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/* Loopback page hosts: `localhost`/`*.localhost`, the whole 127/8 (the URL
   parser already normalizes odd IPv4 forms like `127.1` → `127.0.0.1`),
   and `::1` (canonical `[::1]` once parsed). */
function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }
  if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) return true;
  return hostname === "[::1]";
}
