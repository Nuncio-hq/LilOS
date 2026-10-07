import {
  PairingExchangeError,
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
 *
 * #593: `signal` carries the screen's Cancel and its ~15s timeout.
 */
export async function exchangePairingGrant(
  baseUrl: string,
  input: { code: string; name?: string },
  options: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<PairingExchangeResult> {
  const { fetchImpl = fetch, signal } = options;
  const res = await fetchImpl(`${baseUrl}/pair/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok) {
    const parsed = PairingExchangeError.safeParse(
      await res.json().catch(() => null),
    );
    /* Only the documented refusal body carries a reason a phone can act on.
       Anything else — a 500 page, a captive portal, a proxy error — is a
       plain "can't reach", never a wrong code (#593). A throttled refusal
       (429, #568) carries Retry-After so the phone can say how long. */
    if (!parsed.success) {
      throw new Error(`pairing exchange failed: HTTP ${res.status}`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new PairingExchangeFailed(
      parsed.data.error,
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.ceil(retryAfter * 1000)
        : undefined,
    );
  }
  const parsed = PairingExchangeResult.safeParse(await res.json());
  if (!parsed.success) {
    /* A 200 that isn't the credential payload is a broken peer, not a wrong
       code — unreachable, not 'unknown' (#593). */
    throw new Error("pairing exchange failed: malformed result");
  }
  return parsed.data;
}

export class PairingExchangeFailed extends Error {
  readonly reason: PairingExchangeError["error"];
  /** From the 429's Retry-After header, in ms — absent when the relay
     didn't send one (#568). */
  readonly retryAfterMs?: number;
  constructor(reason: PairingExchangeError["error"], retryAfterMs?: number) {
    super(`pairing exchange failed: ${reason}`);
    this.name = "PairingExchangeFailed";
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}
