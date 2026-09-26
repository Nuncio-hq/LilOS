import type { PreviewTarget } from "@lilos/contracts/harness";

/**
 * Preview discovery per spike #24's measured winner: scan PTY output for a
 * printed localhost URL (`npm run dev`, `python -m http.server`, …), with an
 * explicit `PREVIEW: <url>` marker as the override that also works for
 * silent servers and non-root paths. No port polling — a bare port carries
 * no URL semantics and missed the silent server outright in the spike.
 *
 * The scanner is a feed-forward state machine over terminal bytes: the
 * harness feeds it every PTY chunk; it emits the deduped preview list on
 * change. ANSI escapes are stripped before matching.
 */
export class PreviewScanner {
  private previews = new Map<string, PreviewTarget>();
  /** Marker targets outlive scan results: a marker URL beats a scanned one. */
  private markerUrls = new Set<string>();
  private pending = "";

  feed(chunk: string): PreviewTarget[] | null {
    const clean = stripAnsi(chunk);
    this.pending = (this.pending + clean).slice(-8192);
    let changed = false;
    for (const m of this.pending.matchAll(/PREVIEW:\s*(\S+)/g)) {
      const url = m[1].trim();
      if (!isHttpUrl(url)) continue;
      if (!this.markerUrls.has(url)) {
        this.markerUrls.add(url);
        this.previews.set(url, { url, via: "marker" });
        changed = true;
      }
    }
    for (const m of this.pending.matchAll(LOCAL_URL_RE)) {
      const url = normalizeLocalUrl(m[0]);
      if (!url) continue;
      const existing = this.previews.get(url);
      if (!existing) {
        this.previews.set(url, { url, via: "scan" });
        changed = true;
      }
    }
    return changed ? this.list() : null;
  }

  list(): PreviewTarget[] {
    return [...this.previews.values()];
  }
}

/**
 * Loopback/localhost http(s) URLs as dev servers print them. Kept deliberately
 * narrow — a bare `http://x.com` in output is not a preview.
 */
// `()` and quotes excluded from path chars: in terminal output they are almost
// always the wrapper punctuation ("(http://…)", `'http://…'`), not the URL.
const LOCAL_URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[A-Za-z0-9\-._~:/?#[\]@!$&*+,;=%]*)?/g;

function isHttpUrl(s: string): boolean {
  return /^https?:\/\/\S+$/.test(s);
}

/** `0.0.0.0`/`[::1]` are bind addresses, not browse targets — normalize to localhost. */
function normalizeLocalUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "0.0.0.0" || u.hostname === "[::1]")
      u.hostname = "localhost";
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

// CSI (\e[...final) + OSC (\e]...BEL/\e\\) + simple escape sequences.
const ANSI_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: PTY output is ANSI by nature
  /\u001b\[[0-9;:]*[a-zA-Z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][0-2]|\u001b[ -/]*[0-~]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}
