/* Pairing offer: what the Mac's "Pair phone" dialog hands the iPhone, as a QR
   (lilos://pair?...) or typed by hand. The URL is the wire format — the code
   is a real one-time grant (5-min TTL, single use) minted by the relay, and it
   always rides the URL fragment so proxies/logs never see it:
   `lilos://pair?host=<tailscale-host>:<port>#code=<grant>` (#153, D-#153). */

export type PairingOffer = {
  /** Where the relay is reachable, e.g. a Tailscale name `mac.tail0000.ts.net`. */
  host: string;
  /** One-time pairing grant, normalized: 12 uppercase letters/digits. */
  code: string;
  /** The Mac's display name, when the offer carries one. */
  name?: string;
};

export const CODE_LENGTH = 12;

export function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_LENGTH);
}

/** "7K4MQR2X9TBP" → "7K4M-QR2X-9TBP" (how the Mac shows it). */
export function formatCode(code: string): string {
  const c = normalizeCode(code);
  return c.match(/.{1,4}/g)?.join("-") ?? c;
}

const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$/i;

export function normalizeHost(raw: string): string {
  return raw
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

export function isValidHost(raw: string): boolean {
  return HOST_RE.test(normalizeHost(raw));
}

export function buildPairingUrl(offer: PairingOffer): string {
  const q = new URLSearchParams({ host: offer.host });
  if (offer.name) q.set("name", offer.name);
  // The grant is the secret — it lives in the fragment, off the wire logs.
  return `lilos://pair?${q.toString()}#code=${offer.code}`;
}

/** A scanned/opened URL → offer, or null when it isn't a LilOS pairing code. */
export function parsePairingUrl(raw: string): PairingOffer | null {
  const m = /^lilos:\/\/pair\/?\?([^#]*)(?:#(.*))?$/i.exec(raw.trim());
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const host = normalizeHost(q.get("host") ?? "");
  const fragment = new URLSearchParams(m[2] ?? "");
  const code = normalizeCode(fragment.get("code") ?? "");
  if (!isValidHost(host) || code.length !== CODE_LENGTH) return null;
  const name = q.get("name")?.trim();
  return name ? { host, code, name } : { host, code };
}

export type ManualErrors = { host?: string; code?: string };

export function validateManual(host: string, code: string): ManualErrors {
  const errors: ManualErrors = {};
  if (!isValidHost(host))
    errors.host =
      "That isn't a valid address. Copy it from Pair phone on your Mac.";
  if (normalizeCode(code).length !== CODE_LENGTH)
    errors.code = `The code has ${CODE_LENGTH} letters and numbers.`;
  return errors;
}
