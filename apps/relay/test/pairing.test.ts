import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_PROTOCOL_VERSION, type AppErrorCode } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
  createPairingService,
  normalizePairingCode,
  PAIRING_GRANT_TTL_MS,
  sha256Hex,
} from "../src/pairing";
import {
  createRelay,
  type PhoneAccess,
  type RelayWsPeer,
} from "../src/session";
import { createMemoryStore, type RelayStore } from "../src/store";

const TOKEN = "test-token";
const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUN = process.env.LILOS_BUN_BIN ?? "bun";

/** Pairing store spy: captures what the service hands the store — #153 AC-5. */
function spiedStore() {
  const inner = createMemoryStore();
  const grants: { codeHash: string; createdAt: number; expiresAt: number }[] =
    [];
  const devices: { credentialHash: string; name: string }[] = [];
  const store: RelayStore = {
    ...inner,
    insertPairingGrant: async (g) => {
      grants.push(g);
      await inner.insertPairingGrant(g);
    },
    insertPairedDevice: async (d) => {
      devices.push(d);
      return inner.insertPairedDevice(d);
    },
  };
  return { store, grants, devices };
}

const tailscaleUp = (host = "mac.tail1a2b.ts.net:4577"): PhoneAccess => ({
  enable: async () => ({ host }),
  disable: async () => {},
});

/** Tailscale probe down/missing: every enable() refuses. */
const tailscaleDown = (): PhoneAccess => ({
  enable: async () => null,
  disable: async () => {},
});

function connectPeer(relay: ReturnType<typeof createRelay>) {
  const frames: unknown[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const peer: RelayWsPeer = {
    send: (frame) => frames.push(JSON.parse(frame)),
    close: (code, reason) => closed.push({ code, reason }),
  };
  return { frames, closed, connection: relay.connect(peer) };
}

let nextId = 0;
const req = (method: string, params: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: `t${nextId++}`, method, params });
const frameFor = (frames: unknown[], id: string) => {
  const frame = (
    frames as {
      id?: string;
      result?: unknown;
      error?: { message: string; data?: { code?: string } };
    }[]
  ).find((f) => f.id === id);
  if (!frame) throw new Error(`no frame for ${id}`);
  return frame;
};
const errorCodeOf = (frames: unknown[], id: string) =>
  frameFor(frames, id).error?.data?.code as AppErrorCode;
const notifications = (frames: unknown[], method: string) =>
  (frames as { method?: string; params?: unknown }[]).filter(
    (f) => f.method === method,
  );

const helloDevice = (
  connection: { receive(d: string): Promise<void> },
  deviceId: string,
  credential: string,
) =>
  connection.receive(
    req("session.hello", {
      protocolVersion: APP_PROTOCOL_VERSION,
      deviceId,
      credential,
    }),
  );

describe("AC-2 one-time pairing grant", () => {
  it("mints a 5-min single-use grant; reuse answers 'used', expiry 'expired'", async () => {
    let clock = 1_000;
    const pairing = createPairingService({
      store: createMemoryStore(),
      now: () => clock,
    });
    const grant = await pairing.mintGrant();
    expect(grant.code).toHaveLength(12);
    expect(grant.code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]+$/);
    expect(grant.expiresAt).toBe(clock + PAIRING_GRANT_TTL_MS);

    // The exchange accepts the code as the phone types/scans it (4-4-4, lower).
    const dashed =
      grant.code
        .match(/.{1,4}/g)
        ?.join("-")
        .toLowerCase() ?? "";
    const first = await pairing.exchangeGrant({ code: dashed, name: "iPhone" });
    expect("device" in first).toBe(true);
    if (!("device" in first)) return;
    expect(first.device.name).toBe("iPhone");
    expect(first.credential).toMatch(/^devcred_[0-9a-f]{64}$/);

    // Reuse — the grant is spent.
    expect(await pairing.exchangeGrant({ code: grant.code })).toEqual({
      error: "used",
    });

    // Expiry — a grant older than its TTL refuses even when never spent.
    const stale = await pairing.mintGrant();
    clock += PAIRING_GRANT_TTL_MS + 1;
    expect(await pairing.exchangeGrant({ code: stale.code })).toEqual({
      error: "expired",
    });
    // And a code that was never minted.
    expect(await pairing.exchangeGrant({ code: "ZZZZZZZZZZZZ" })).toEqual({
      error: "unknown",
    });
  });
});

describe("AC-3 device credential hello", () => {
  it("exchange returns device id + credential; hello accepts it and the install token", async () => {
    const store = createMemoryStore();
    const pairing = createPairingService({ store });
    const relay = createRelay({
      store,
      token: TOKEN,
      pairing,
      phoneAccess: tailscaleUp(),
    });

    const grant = await pairing.mintGrant();
    const exchanged = await pairing.exchangeGrant({ code: grant.code });
    if (!("device" in exchanged)) throw new Error("exchange failed");

    // Device credential → welcome (and the peer is tracked for revoke).
    const phone = connectPeer(relay);
    await helloDevice(
      phone.connection,
      exchanged.device.id,
      exchanged.credential,
    );
    const welcome = frameFor(phone.frames, `t${nextId - 1}`);
    expect(welcome.result).toMatchObject({
      protocolVersion: APP_PROTOCOL_VERSION,
    });

    // A bad credential is rejected like a bad token.
    const stranger = connectPeer(relay);
    await helloDevice(stranger.connection, exchanged.device.id, "devcred_nope");
    expect(errorCodeOf(stranger.frames, `t${nextId - 1}`)).toBe(
      "unauthenticated" satisfies AppErrorCode,
    );

    // The install token still works for local clients.
    const local = connectPeer(relay);
    await local.connection.receive(
      req("session.hello", {
        protocolVersion: APP_PROTOCOL_VERSION,
        token: TOKEN,
      }),
    );
    expect(frameFor(local.frames, `t${nextId - 1}`).result).toMatchObject({
      protocolVersion: APP_PROTOCOL_VERSION,
    });
  });
});

describe("AC-4 list + revoke", () => {
  it("devices.list shows the phone; revoke closes its socket and kills the credential", async () => {
    const store = createMemoryStore();
    const pairing = createPairingService({ store });
    const relay = createRelay({
      store,
      token: TOKEN,
      pairing,
      phoneAccess: tailscaleUp(),
    });

    // Mac client: helloed, watches devices.changed.
    const mac = connectPeer(relay);
    await mac.connection.receive(
      req("session.hello", {
        protocolVersion: APP_PROTOCOL_VERSION,
        token: TOKEN,
      }),
    );
    mac.frames.length = 0;

    const grant = await pairing.mintGrant();
    const exchanged = await pairing.exchangeGrant({ code: grant.code });
    if (!("device" in exchanged)) throw new Error("exchange failed");

    // The exchange broadcast reaches the Mac (async fanout → macrotask).
    await new Promise((r) => setImmediate(r));
    const changed = notifications(mac.frames, "devices.changed");
    expect(changed).toHaveLength(1);
    const first = changed[0];
    if (!first) throw new Error("devices.changed missing");
    expect((first.params as { devices: { name: string }[] }).devices).toEqual([
      expect.objectContaining({ name: "iPhone" }),
    ]);

    // The phone connects.
    const phone = connectPeer(relay);
    await helloDevice(
      phone.connection,
      exchanged.device.id,
      exchanged.credential,
    );

    // devices.list carries name / pairedAt / lastSeenAt.
    await mac.connection.receive(req("devices.list"));
    const listed = frameFor(mac.frames, `t${nextId - 1}`).result as {
      devices: {
        id: string;
        name: string;
        pairedAt: number;
        lastSeenAt: number;
      }[];
    };
    expect(listed.devices).toHaveLength(1);
    expect(listed.devices[0]).toMatchObject({
      id: exchanged.device.id,
      name: "iPhone",
    });
    expect(listed.devices[0].lastSeenAt).toBeGreaterThanOrEqual(
      listed.devices[0].pairedAt,
    );

    // Revoke: the live socket is closed with the dedicated code, the
    // credential stops working, and another devices.changed lands.
    await mac.connection.receive(
      req("devices.revoke", { deviceId: exchanged.device.id }),
    );
    expect(frameFor(mac.frames, `t${nextId - 1}`).result).toEqual({
      ok: true,
    });
    expect(phone.closed).toEqual([{ code: 4403, reason: "device revoked" }]);
    await new Promise((r) => setImmediate(r));
    expect(
      notifications(mac.frames, "devices.changed").length,
    ).toBeGreaterThanOrEqual(2);

    const zombie = connectPeer(relay);
    await zombie.connection.receive(
      req("session.hello", {
        protocolVersion: APP_PROTOCOL_VERSION,
        deviceId: exchanged.device.id,
        credential: exchanged.credential,
      }),
    );
    expect(errorCodeOf(zombie.frames, `t${nextId - 1}`)).toBe(
      "unauthenticated" satisfies AppErrorCode,
    );

    // Revoking a phantom is not_found, not ok.
    await mac.connection.receive(
      req("devices.revoke", { deviceId: "dev_nope" }),
    );
    expect(errorCodeOf(mac.frames, `t${nextId - 1}`)).toBe(
      "not_found" satisfies AppErrorCode,
    );
  });
});

describe("AC-5 secrets are stored hashed", () => {
  it("the store sees only SHA-256 hashes — never the raw grant or credential", async () => {
    const { store, grants, devices } = spiedStore();
    const pairing = createPairingService({ store });
    const grant = await pairing.mintGrant();
    const exchanged = await pairing.exchangeGrant({ code: grant.code });
    if (!("device" in exchanged)) throw new Error("exchange failed");

    expect(grants).toHaveLength(1);
    expect(grants[0].codeHash).toBe(sha256Hex(grant.code));
    expect(grants[0].codeHash).not.toBe(grant.code);

    expect(devices).toHaveLength(1);
    expect(devices[0].credentialHash).toBe(sha256Hex(exchanged.credential));
    expect(devices[0].credentialHash).not.toContain(exchanged.credential);
    expect(exchanged.credential).toMatch(/^devcred_[0-9a-f]{64}$/);
  });

  it("AC-5 sqlite: the persisted rows carry hashes, not secrets", () => {
    const script = `
      import { Database } from "bun:sqlite";
      import { drizzle } from "drizzle-orm/bun-sqlite";
      import { applyMigrations } from "./src/db/migrate.ts";
      import * as schema from "./src/db/schema.ts";
      import { createDrizzleStore } from "./src/db/drizzle-store.ts";
      import { createPairingService } from "./src/pairing.ts";
      const db = new Database(":memory:");
      applyMigrations(db);
      const store = createDrizzleStore(drizzle(db, { schema }));
      const pairing = createPairingService({ store });
      const grant = await pairing.mintGrant();
      const ex = await pairing.exchangeGrant({ code: grant.code, name: "iPhone" });
      const grantRow = db.query("SELECT * FROM pairing_grants").get();
      const devRow = db.query("SELECT * FROM paired_devices").get();
      console.log(JSON.stringify({ grant, grantRow, deviceId: ex.device.id,
        credential: ex.credential, devRow }));
    `;
    const res = spawnSync(BUN, ["-e", script], {
      cwd: RELAY_DIR,
      encoding: "utf8",
    });
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout.trim().split("\n").at(-1) ?? "null");
    const grantRow = out.grantRow as Record<string, unknown>;
    const devRow = out.devRow as Record<string, unknown>;

    // Grant: hashed code only; the raw 12-char code appears nowhere in the row.
    expect(Object.keys(grantRow).sort()).toEqual([
      "code_hash",
      "consumed_at",
      "created_at",
      "expires_at",
    ]);
    expect(grantRow.code_hash).toBe(sha256Hex(out.grant.code));
    expect(Object.values(grantRow).join("|")).not.toContain(out.grant.code);

    // Device: credential hash only; the raw credential appears nowhere.
    expect(devRow.credential_hash).toBe(sha256Hex(out.credential));
    expect(Object.values(devRow).join("|")).not.toContain(out.credential);
  });
});

describe("AC-1 pairing.offer — Tailscale opt-in", () => {
  it("returns an offer when the tailnet bind succeeds", async () => {
    const store = createMemoryStore();
    const pairing = createPairingService({ store });
    const relay = createRelay({
      store,
      token: TOKEN,
      pairing,
      phoneAccess: tailscaleUp("mac.tail1a2b.ts.net:4577"),
      macName: "macbook-pro",
    });
    const mac = connectPeer(relay);
    await mac.connection.receive(
      req("session.hello", {
        protocolVersion: APP_PROTOCOL_VERSION,
        token: TOKEN,
      }),
    );
    await mac.connection.receive(req("pairing.offer"));
    const offer = (
      frameFor(mac.frames, `t${nextId - 1}`).result as {
        offer: {
          host: string;
          code: string;
          name: string;
          expiresAt: number;
        };
      }
    ).offer;
    expect(offer.host).toBe("mac.tail1a2b.ts.net:4577");
    expect(offer.code).toHaveLength(12);
    // No profile yet → the hostname stands in as the Mac's display name.
    expect(offer.name).toBe("macbook-pro");
    expect(offer.expiresAt).toBeGreaterThan(Date.now());

    // pairing.disable is the way out.
    await mac.connection.receive(req("pairing.disable"));
    expect(frameFor(mac.frames, `t${nextId - 1}`).result).toEqual({
      ok: true,
    });
  });

  it("tailscale down → tailscale_unavailable, no grant minted", async () => {
    const store = createMemoryStore();
    const pairing = createPairingService({ store });
    const down = tailscaleDown();
    const relay = createRelay({
      store,
      token: TOKEN,
      pairing,
      phoneAccess: down,
    });
    const mac = connectPeer(relay);
    await mac.connection.receive(
      req("session.hello", {
        protocolVersion: APP_PROTOCOL_VERSION,
        token: TOKEN,
      }),
    );
    await mac.connection.receive(req("pairing.offer"));
    expect(errorCodeOf(mac.frames, `t${nextId - 1}`)).toBe(
      "tailscale_unavailable" satisfies AppErrorCode,
    );
    // No grant exists to spend — nothing was minted.
    expect(await pairing.exchangeGrant({ code: "7K4MQR2X9TBP" })).toEqual({
      error: "unknown",
    });
  });
});

describe("pairing exchange endpoint (POST /pair/exchange)", () => {
  const okPairing = (code = "7K4MQR2X9TBP") => {
    let device = 0;
    return {
      mintGrant: async () => ({ code, expiresAt: Date.now() + 60_000 }),
      exchangeGrant: async (input: { code: string; name?: string }) =>
        input.code === code
          ? {
              device: {
                id: `dev_${++device}`,
                name: input.name ?? "iPhone",
                pairedAt: 1,
                lastSeenAt: 1,
              },
              credential: "devcred_raw",
            }
          : { error: "unknown" as const },
      authenticateDevice: async () => null,
      listDevices: async () => [],
      revokeDevice: async () => null,
      setOnDevicesChanged: () => {},
    };
  };

  it("exchanges a grant over HTTP and classifies refusals", async () => {
    const app = createApp({
      instanceId: "test",
      relayVersion: "0",
      pairing: okPairing(),
    });
    const good = await app.request("/pair/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "7K4MQR2X9TBP", name: "Test iPhone" }),
    });
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({
      deviceId: "dev_1",
      credential: "devcred_raw",
      device: { name: "Test iPhone" },
    });

    const bad = await app.request("/pair/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "WRONGCODEWRONG" }),
    });
    expect(bad.status).toBe(410);
    expect(await bad.json()).toEqual({ error: "unknown" });
  });
});

describe("normalizePairingCode", () => {
  it("strips display dashes and case", () => {
    expect(normalizePairingCode("7k4m-qr2x-9tbp")).toBe("7K4MQR2X9TBP");
    expect(normalizePairingCode(" 7K4MQR2X9TBP ")).toBe("7K4MQR2X9TBP");
  });
});
