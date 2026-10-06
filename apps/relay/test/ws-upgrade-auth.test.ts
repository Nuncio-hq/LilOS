import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { RelayClient } from "@lilos/client-runtime";
import {
  APP_PROTOCOL_VERSION,
  WS_CLOSE_HELLO_TIMEOUT,
} from "@lilos/contracts/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { authorizeRelayUpgrade } from "../src/auth";
import { createPairingService } from "../src/pairing";
import { createRelay } from "../src/session";
import {
  BUN,
  connectPeer,
  lastId,
  req,
  resultOf,
  startRelay,
  TOKEN,
  wsFactory,
} from "./helpers";
import { createMemoryStore } from "./memory-store";

/**
 * Issue #625 — the relay's `/ws` upgrade authenticates: without a credential
 * the handshake is refused (401) before `server.upgrade`, so a stranger never
 * attaches and never gets to buffer a 160 MiB frame pre-hello. Plus a
 * `session.hello` deadline closes credentialed sockets that never say hello.
 *
 * The credential rides the URL — `?token=` for install-token peers (the same
 * carrier the #564 feed gate uses; a browser WebSocket can't set headers) and
 * `?deviceId=&credential=` for paired phones.
 */

/** Resolve 101 on upgrade, the HTTP status on refusal, -1 on socket error. */
const attempt = (url: string) =>
  new Promise<number>((resolve) => {
    const ws = new WebSocket(url);
    ws.once("open", () => {
      ws.close();
      resolve(101);
    });
    ws.once("unexpected-response", (_req, res) => {
      const code = res.statusCode ?? 0;
      res.socket.destroy();
      resolve(code);
    });
    ws.once("error", () => resolve(-1));
  });

const deviceParams = (deviceId: string, credential: string) =>
  `deviceId=${encodeURIComponent(deviceId)}&credential=${encodeURIComponent(credential)}`;

describe("AC-1 unauthenticated upgrades are refused before attach", () => {
  it("authorizeRelayUpgrade gates on the install token or a device credential", async () => {
    const store = createMemoryStore();
    const pairing = createPairingService({ store });
    const grant = await pairing.mintGrant();
    const ex = await pairing.exchangeGrant({ code: grant.code });
    if (!("device" in ex)) throw new Error("exchange failed");

    const gate = (url: string) =>
      authorizeRelayUpgrade(new Request(url), { token: TOKEN, pairing });

    // Install token — wrong, missing and empty are all refused; exact passes.
    expect((await gate("http://r/ws"))?.status).toBe(401);
    expect((await gate("http://r/ws?token=wrong"))?.status).toBe(401);
    expect((await gate("http://r/ws?token="))?.status).toBe(401);
    expect(await gate(`http://r/ws?token=${TOKEN}`)).toBeUndefined();

    // Device credential — real pair passes, wrong credential or a revoked
    // device are refused.
    expect(
      await gate(`http://r/ws?${deviceParams(ex.device.id, ex.credential)}`),
    ).toBeUndefined();
    expect(
      (
        await gate(
          `http://r/ws?${deviceParams(ex.device.id, `devcred_${"0".repeat(64)}`)}`,
        )
      )?.status,
    ).toBe(401);
    await pairing.revokeDevice(ex.device.id);
    expect(
      (await gate(`http://r/ws?${deviceParams(ex.device.id, ex.credential)}`))
        ?.status,
    ).toBe(401);
  });

  it("an upgrade without a credential answers 401 and never attaches", async () => {
    const relay = await startRelay();
    expect(await attempt(relay.url)).toBe(401);
    expect(await attempt(`${relay.url}?token=wrong`)).toBe(401);
    expect(await attempt(`${relay.url}?token=`)).toBe(401);
    expect(
      await attempt(
        `${relay.url}?${deviceParams("dev_nope", `devcred_${"0".repeat(64)}`)}`,
      ),
    ).toBe(401);
    /* A refused request never reaches the ws layer — nothing attaches, so no
       socket exists to buffer frames on. The install token still upgrades. */
    expect(await attempt(`${relay.url}?token=${relay.token}`)).toBe(101);
  });

  it("a device row authenticates at the upgrade on a real spawned relay", async () => {
    const relay = await startRelay();
    /* Seed a device row straight into the relay's sqlite — the same shape
       /pair/exchange writes (the tailnet leg is covered by e2e.test.ts). */
    const credential = `devcred_${"ab".repeat(32)}`;
    const credentialHash = createHash("sha256")
      .update(credential)
      .digest("hex");
    const seeded = spawnSync(
      BUN,
      [
        "-e",
        `import { Database } from "bun:sqlite";
         const db = new Database(${JSON.stringify(join(relay.home, "relay.sqlite"))});
         db.exec("INSERT INTO paired_devices (id,name,credential_hash,paired_at,last_seen_at) VALUES ('dev_seed','Seeded','${credentialHash}',1,1)");`,
      ],
      { encoding: "utf8" },
    );
    expect(seeded.status, seeded.stderr).toBe(0);

    expect(
      await attempt(`${relay.url}?${deviceParams("dev_seed", credential)}`),
    ).toBe(101);
    expect(
      await attempt(
        `${relay.url}?${deviceParams("dev_seed", "devcred_wrong")}`,
      ),
    ).toBe(401);
  });
});

describe("AC-2 install-token and device clients still connect", () => {
  it("RelayClient connects with the token and with a device credential", async () => {
    const relay = await startRelay();
    const mac = new RelayClient({
      url: relay.url,
      token: relay.token,
      socketFactory: wsFactory().factory,
      autoReconnect: false,
      client: { name: "e2e-625-mac" },
    });
    await expect(mac.connect()).resolves.toMatchObject({
      protocolVersion: APP_PROTOCOL_VERSION,
    });

    // The phone leg: a device seeded into the spawned relay's store.
    const credential = `devcred_${"cd".repeat(32)}`;
    const credentialHash = createHash("sha256")
      .update(credential)
      .digest("hex");
    const seeded = spawnSync(
      BUN,
      [
        "-e",
        `import { Database } from "bun:sqlite";
         const db = new Database(${JSON.stringify(join(relay.home, "relay.sqlite"))});
         db.exec("INSERT INTO paired_devices (id,name,credential_hash,paired_at,last_seen_at) VALUES ('dev_phone','Phone','${credentialHash}',1,1)");`,
      ],
      { encoding: "utf8" },
    );
    expect(seeded.status, seeded.stderr).toBe(0);

    const phone = new RelayClient({
      url: relay.url,
      device: { deviceId: "dev_phone", credential },
      socketFactory: wsFactory().factory,
      autoReconnect: false,
      client: { name: "e2e-625-phone" },
    });
    await expect(phone.connect()).resolves.toMatchObject({
      protocolVersion: APP_PROTOCOL_VERSION,
    });
    /* Device scope works end to end: a non-admin method answers. */
    await expect(phone.request("employees.list", {})).resolves.toMatchObject({
      employees: expect.any(Array),
    });
    phone.close();
    mac.close();
  }, 30_000);
});

describe("AC-3 a socket that never completes session.hello is closed", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("in-process: the deadline closes a silent peer but not a helloed one", async () => {
    vi.useFakeTimers();
    const relay = createRelay({
      store: createMemoryStore(),
      token: TOKEN,
      helloDeadlineMs: 60_000,
    });
    const silent = connectPeer(relay);
    const spoke = connectPeer(relay);
    await spoke.connection.receive(
      req("session.hello", {
        protocolVersion: APP_PROTOCOL_VERSION,
        token: TOKEN,
      }),
    );
    expect(resultOf(spoke.frames, lastId()).result).toMatchObject({
      protocolVersion: APP_PROTOCOL_VERSION,
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(silent.closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(silent.closedCodes).toEqual([WS_CLOSE_HELLO_TIMEOUT]);
    // The helloed peer is never deadline-closed, even past the deadline.
    expect(spoke.closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spoke.closed).toEqual([]);
  });

  it("on the wire: an upgraded socket that stays silent is closed at the injected deadline", async () => {
    const relay = await startRelay({ LILOS_HELLO_DEADLINE_MS: "300" });
    const url = `${relay.url}?token=${encodeURIComponent(relay.token)}`;

    /* Connect+hello first: when the silent socket's close lands (~300 ms
       after ITS attach), this peer has provably been helloed past its own
       deadline — event-ordered, no wall-clock sleep. */
    const live = new RelayClient({
      url: relay.url,
      token: relay.token,
      socketFactory: wsFactory().factory,
      autoReconnect: false,
    });
    await live.connect();

    const silent = new WebSocket(url);
    const silentClosed = new Promise<number>((resolve) =>
      silent.once("close", (code) => resolve(code)),
    );
    await new Promise<void>((resolve, reject) => {
      silent.once("open", () => resolve());
      silent.once("error", reject);
    });
    // Never sends hello — the relay must hang it up.
    await expect(silentClosed).resolves.toBe(WS_CLOSE_HELLO_TIMEOUT);
    await expect(live.ping()).resolves.toBeUndefined();
    live.close();
  }, 30_000);
});
