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
 * and feed `/ws` upgrade, the surfaces `/view` socket and the agent
 * gateway's session/engine bearers. `node:crypto` keeps it runtime-neutral
 * (Bun + Node), which contracts requires anyway.
 */
export function equalSecret(a: string, b: string): boolean {
  return nodeCrypto.timingSafeEqual(
    nodeCrypto.createHash("sha256").update(a).digest(),
    nodeCrypto.createHash("sha256").update(b).digest(),
  );
}
