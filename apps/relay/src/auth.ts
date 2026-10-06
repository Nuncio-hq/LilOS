import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { PairingService } from "./pairing";

/**
 * Per-install local-process auth (issue #25): the relay generates a token on
 * first run into <homeDir>/relay-token (0600) and local clients pass it in
 * `session.hello`. No user action involved; rotate by deleting the file.
 */
export function loadOrCreateInstallToken(tokenPath: string): string {
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, "utf8").trim();
    if (token.length > 0) return token;
  }
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, token, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  return token;
}

/**
 * Constant-time secret compare (#568): hash both sides, then
 * `timingSafeEqual` over the fixed-size digests. A plain `!==`/`===`
 * early-exits on the first differing byte, so a remote caller that can
 * time `session.hello` round-trips could read off the longest matching
 * prefix. Digests keep the compare fixed-cost for any input length.
 */
export function equalSecret(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

/**
 * #625: the `/ws` upgrade gate — a credential is checked BEFORE
 * `server.upgrade`, so a refused handshake never attaches and never gets to
 * sit pre-auth buffering frames up to `MAX_FRAME_BYTES` (#551 raised the cap
 * to 160 MiB; the old 16 MiB default accidentally bounded this). The
 * credential rides the URL's query because a browser WebSocket can't set
 * headers — the same carrier the #564 feed gate uses: web/desktop/harness
 * send `?token=` (the install token), a paired phone sends
 * `?deviceId=&credential=`. `session.hello` still authenticates on the
 * socket; this gate only bounds what runs pre-hello.
 */
export async function authorizeRelayUpgrade(
  req: Request,
  deps: { token: string; pairing?: PairingService },
): Promise<Response | undefined> {
  const url = new URL(req.url);
  const presented = url.searchParams.get("token");
  // Fail closed: an empty configured credential must never authenticate.
  if (deps.token && presented && equalSecret(presented, deps.token)) {
    return undefined;
  }
  const deviceId = url.searchParams.get("deviceId");
  const credential = url.searchParams.get("credential");
  if (deviceId && credential && deps.pairing) {
    try {
      const device = await deps.pairing.authenticateDevice(
        deviceId,
        credential,
      );
      if (device) return undefined;
    } catch {
      /* A store error must still fail closed — the uniform 401 below. */
    }
  }
  return new Response("unauthorized\n", { status: 401 });
}
