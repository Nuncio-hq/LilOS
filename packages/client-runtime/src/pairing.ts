import {
  type PairingExchangeError,
  PairingExchangeResult,
} from "@lilos/contracts/app";

/**
 * Phone-side pairing (#153): the one call a not-yet-paired device makes —
 * spending the QR's one-time grant (carried in the `lilos://pair` URL's
 * fragment) for its own credential over plain HTTP. Returns the credential
 * once; the phone stores it in the Keychain and never asks again. The
 * relay's install token never appears in this flow.
 *
 * `baseUrl` is `http(s)://<host>:<port>` — the pairing URL's `host` param
 * (Tailscale MagicDNS name or CGNAT IP) with a scheme.
 */
export async function exchangePairingGrant(
  baseUrl: string,
  input: { code: string; name?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<PairingExchangeResult> {
  const res = await fetchImpl(`${baseUrl}/pair/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res
      .json()
      .catch(() => null)) as PairingExchangeError | null;
    const error = body?.error ?? "unknown";
    throw new PairingExchangeFailed(error);
  }
  const parsed = PairingExchangeResult.safeParse(await res.json());
  if (!parsed.success) {
    throw new PairingExchangeFailed("unknown");
  }
  return parsed.data;
}

export class PairingExchangeFailed extends Error {
  readonly reason: PairingExchangeError["error"];
  constructor(reason: PairingExchangeError["error"]) {
    super(`pairing exchange failed: ${reason}`);
    this.name = "PairingExchangeFailed";
    this.reason = reason;
  }
}
