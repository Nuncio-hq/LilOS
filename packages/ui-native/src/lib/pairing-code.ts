/* Pairing offer: what the Mac's "Pair phone" screen hands the iPhone, as a QR
   (lilos://pair?...) or typed by hand. Prototype-only format — the real
   pairing grant is a backend slice (see the mobile notes in AGENTS.md); only
   the host + one-time code + display name shape is assumed here. */

export type PairingOffer = {
  /** Where the relay is reachable, e.g. a Tailscale name `mac.tail0000.ts.net`. */
  host: string;
  /** One-time pairing code, normalized: 6 uppercase letters/digits. */
  code: string;
  /** The Mac's display name, when the offer carries one. */
  name?: string;
};

export const CODE_LENGTH = 6;

export function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_LENGTH);
}

/** "7K4M2P" → "7K4-M2P" (how the Mac shows it). */
export function formatCode(code: string): string {
  const c = normalizeCode(code);
  return c.length > 3 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
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
  const q = new URLSearchParams({ host: offer.host, code: offer.code });
  if (offer.name) q.set("name", offer.name);
  return `lilos://pair?${q.toString()}`;
}

/** A scanned/opened URL → offer, or null when it isn't a LilOS pairing code. */
export function parsePairingUrl(raw: string): PairingOffer | null {
  const m = /^lilos:\/\/pair\/?\?(.*)$/i.exec(raw.trim());
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const host = normalizeHost(q.get("host") ?? "");
  const code = normalizeCode(q.get("code") ?? "");
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
