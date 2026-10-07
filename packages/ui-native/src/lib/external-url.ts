/**
 * #598 (review): only URLs the OS may safely open — desktop's #565
 * link policy applied to the phone. Forge/workbench/background URLs are
 * engine-supplied, so anything reaching `Linking.openURL` goes through
 * here first: `https:` anywhere, `http:` only for a loopback host (a dev
 * server the Mac serves on the phone's own box). Everything else —
 * `file:`, `javascript:`, `tel:`, an app scheme — is refused, and the
 * caller shows no link affordance.
 */
export function safeExternalUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return raw;
    if (u.protocol === "http:" && isLoopback(u.hostname)) return raw;
    return undefined;
  } catch {
    return undefined;
  }
}

const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "::1" ||
  hostname === "[::1]" ||
  hostname.startsWith("127.");
