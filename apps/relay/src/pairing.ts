import { createHash, randomBytes } from "node:crypto";
import type { PairedDevice } from "@lilos/contracts/app";
import { newId, type RelayStore } from "./store";

/**
 * Phone pairing (#153): one-time grant → per-device credential, ported from
 * T3 Code's `apps/server/src/auth/PairingGrantStore.ts` — same shape without
 * Effect: a short-lived single-use grant carries the pairing secret (in the
 * QR's URL fragment), and spending it mints a long-lived per-device
 * credential. Both secrets are stored only as SHA-256 hashes; the raw
 * credential exists once, in the exchange response.
 */

/** Grants live 5 minutes and die on first spend. */
export const PAIRING_GRANT_TTL_MS = 5 * 60 * 1000;

/**
 * Exchange throttle (#568): this many consecutive `unknown` misses lock
 * `exchangeGrant` for the cooldown. Both numbers are the documented budget
 * in SECURITY.md — online guessing at a 60-bit code must stay pointless.
 */
export const PAIRING_EXCHANGE_MAX_FAILURES = 5;
export const PAIRING_EXCHANGE_COOLDOWN_MS = 60_000;

/** 12 chars from T3's unambiguous alphabet — no 0/1/I/O confusion. */
const PAIRING_CODE_LENGTH = 12;
const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** T3's rejection sampling: drop bytes that would skew the modulo. */
function newPairingCode(
  length = PAIRING_CODE_LENGTH,
  alphabet = PAIRING_CODE_ALPHABET,
): string {
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  const out: string[] = [];
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out.push(alphabet[byte % alphabet.length]);
      if (out.length === length) break;
    }
  }
  return out.join("");
}

/** "7K4M-QR2X-9TBP" and typed variants normalize to the raw grant. */
export function normalizePairingCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export interface PairingService {
  /** Mint a fresh one-time grant (stored hashed). */
  mintGrant(): Promise<{ code: string; expiresAt: number }>;
  /**
   * Spend a grant for a device credential. Success carries the device plus
   * the raw credential — the only place that value ever exists server-side.
   * `throttled` (#568): too many consecutive `unknown` guesses — retry
   * after the cooldown.
   */
  exchangeGrant(input: {
    code: string;
    name?: string;
  }): Promise<
    | { device: PairedDevice; credential: string }
    | { error: "unknown" | "expired" | "used" }
    | { error: "throttled"; retryAfterMs: number }
  >;
  /**
   * `session.hello` auth for phones: hash-match an unrevoked device and bump
   * its last-seen; null rejects the handshake.
   */
  authenticateDevice(
    deviceId: string,
    credential: string,
  ): Promise<PairedDevice | null>;
  listDevices(): Promise<PairedDevice[]>;
  /** Mark revoked; the session layer closes live sockets after this. */
  revokeDevice(id: string): Promise<PairedDevice | null>;
  /** Called by the session layer so pairing broadcasts reach ws clients. */
  setOnDevicesChanged(fn: (() => void) | undefined): void;
}

export function createPairingService(options: {
  store: RelayStore;
  /** Injectable clock (tests freeze TTL windows). */
  now?: () => number;
  /** Grant TTL override (e2e expiry runs); default 5 min. */
  grantTtlMs?: number;
  /** Exchange throttle knobs (#568); defaults in SECURITY.md. */
  exchangeMaxFailures?: number;
  exchangeCooldownMs?: number;
}): PairingService {
  const { store } = options;
  const now = options.now ?? (() => Date.now());
  const grantTtlMs = options.grantTtlMs ?? PAIRING_GRANT_TTL_MS;
  const maxFailures =
    options.exchangeMaxFailures ?? PAIRING_EXCHANGE_MAX_FAILURES;
  const cooldownMs = options.exchangeCooldownMs ?? PAIRING_EXCHANGE_COOLDOWN_MS;
  let onDevicesChanged: (() => void) | undefined;
  const changed = () => onDevicesChanged?.();
  /* Shared miss budget + lock: pairing is a rare flow, so a per-source
     limiter isn't worth the plumbing — while locked, every exchange waits
     out the same cooldown. */
  let misses = 0;
  let throttledUntil = 0;

  return {
    async mintGrant() {
      /* GC spent/expired rows on every mint — grants are write-only secrets,
         nothing reads old ones back. */
      await store.prunePairingGrants(now());
      const code = newPairingCode();
      const expiresAt = now() + grantTtlMs;
      await store.insertPairingGrant({
        codeHash: sha256Hex(code),
        createdAt: now(),
        expiresAt,
      });
      return { code, expiresAt };
    },

    async exchangeGrant({ code, name }) {
      /* #568: while the lock runs every exchange is refused — even a valid
         code, so the lock actually costs an attacker the whole window. */
      if (now() < throttledUntil) {
        return { error: "throttled", retryAfterMs: throttledUntil - now() };
      }
      const credential = `devcred_${randomBytes(32).toString("hex")}`;
      const at = now();
      /* Consume + device insert are one store transaction — a failure can't
         burn the grant while leaving the phone with a bare 500. */
      const spent = await store.exchangePairingGrant({
        codeHash: sha256Hex(normalizePairingCode(code)),
        device: {
          id: newId("dev"),
          name: name?.trim() || "iPhone",
          credentialHash: sha256Hex(credential),
          pairedAt: at,
          lastSeenAt: at,
        },
        at,
      });
      if ("error" in spent) {
        /* Only `unknown` counts against the budget: `used`/`expired` prove
           the caller held a real code, so replaying a dead grant can never
           lock the owner's own phone out. A success resets the counter. */
        if (spent.error === "unknown") {
          misses += 1;
          if (misses >= maxFailures) {
            throttledUntil = now() + cooldownMs;
            misses = 0;
          }
        }
        return { error: spent.error };
      }
      misses = 0;
      changed();
      return { device: spent.device, credential };
    },

    async authenticateDevice(deviceId, credential) {
      return store.authenticateDevice({
        deviceId,
        credentialHash: sha256Hex(credential),
        seenAt: now(),
      });
    },

    async listDevices() {
      return store.listPairedDevices();
    },

    async revokeDevice(id) {
      const device = await store.revokePairedDevice(id, now());
      if (device) changed();
      return device;
    },

    setOnDevicesChanged(fn) {
      onDevicesChanged = fn;
    },
  };
}
