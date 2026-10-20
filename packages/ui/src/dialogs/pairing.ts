/* Pair phone (Mac side of mobile onboarding): the one-time offer the iPhone
   scans as a QR code. The offer/code are the relay's real one-time grants
   (#153), minted by `pairing.offer`; the v3 phone settings pane renders it. */

export type PairPhoneOffer = {
  host: string;
  /** Raw one-time grant (12 chars) — shown chunked as 4-4-4. */
  code: string;
  name: string;
  /** epoch ms */
  expiresAt: number;
};

export function pairingUrl(o: PairPhoneOffer): string {
  const q = new URLSearchParams({ host: o.host, name: o.name });
  // The grant is the secret — it rides the URL fragment, never the query
  // (D-#153: `lilos://pair?host=…#code=…`; fragments stay out of logs).
  return `lilos://pair?${q.toString()}#code=${o.code}`;
}
