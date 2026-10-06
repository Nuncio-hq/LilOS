import { createHash, timingSafeEqual } from "node:crypto";

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
 * and feed `/ws` upgrade, the surfaces `/view` socket and the agent
 * gateway's session/engine bearers. `node:crypto` keeps it runtime-neutral
 * (Bun + Node), which contracts requires anyway.
 */
export function equalSecret(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}
