import { APP_PROTOCOL_VERSION } from "@lilos/contracts/app";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../src/app";
import { equalSecret } from "../src/auth";
import { wsUpgradeOriginAllowed } from "../src/origin";
import { createPairingService, PAIRING_GRANT_TTL_MS } from "../src/pairing";
import { createRelay } from "../src/session";
import {
  connectPeer,
  errorData,
  lastId,
  req,
  resultOf,
  startRelay,
  TOKEN,
} from "./helpers";
import { createMemoryStore } from "./memory-store";

/**
 * Issue #568 — relay hardening: constant-time secret compares, an Origin
 * gate on the `/ws` upgrade, and a throttle on `/pair/exchange` guesses.
 */

describe("AC-1 constant-time secret compares", () => {
  it("equalSecret answers equal/unequal regardless of input length", () => {
    expect(equalSecret("a", "a")).toBe(true);
    expect(equalSecret("", "")).toBe(true);
    expect(equalSecret("a", "b")).toBe(false);
    expect(equalSecret("abc", "abcd")).toBe(false);
    expect(equalSecret("short", "a-much-longer-secret-value")).toBe(false);
  });

  it("session.hello accepts the exact token and refuses near-misses", async () => {
    const relay = createRelay({ store: createMemoryStore(), token: TOKEN });
    const good = connectPeer(relay);
    await good.connection.receive(
      req("session.hello", {
        protocolVersion: APP_PROTOCOL_VERSION,
        token: TOKEN,
      }),
    );
    expect(resultOf(good.frames, lastId()).result).toMatchObject({
      protocolVersion: APP_PROTOCOL_VERSION,
    });

    /* Prefix-only and extended guesses — the shapes a timing oracle feeds
       on. All must land on `unauthenticated`, never throw. */
    for (const token of [TOKEN.slice(0, -1), `${TOKEN}x`, "wrong"]) {
      const p = connectPeer(relay);
      await p.connection.receive(
        req("session.hello", {
          protocolVersion: APP_PROTOCOL_VERSION,
          token,
        }),
      );
      expect(errorData(p.frames, lastId())).toBe("unauthenticated");
    }
  });

  it("a tampered device credential never authenticates, the real one does", async () => {
    const store = createMemoryStore();
    const pairing = createPairingService({ store });
    const grant = await pairing.mintGrant();
    const ex = await pairing.exchangeGrant({ code: grant.code });
    if (!("device" in ex)) throw new Error("exchange failed");

    // Same shape, different secret → null (hash compared in-process).
    const tampered = `devcred_${"0".repeat(64)}`;
    expect(await pairing.authenticateDevice(ex.device.id, tampered)).toBeNull();
    expect(
      await pairing.authenticateDevice(ex.device.id, ex.credential),
    ).toMatchObject({ id: ex.device.id });

    // Over the wire too: hello with the tampered credential is refused.
    const relay = createRelay({ store, token: TOKEN, pairing });
    const stranger = connectPeer(relay);
    await stranger.connection.receive(
      req("session.hello", {
        protocolVersion: APP_PROTOCOL_VERSION,
        deviceId: ex.device.id,
        credential: tampered,
      }),
    );
    expect(errorData(stranger.frames, lastId())).toBe("unauthenticated");
  });
});

describe("AC-2 Origin gate on the /ws upgrade", () => {
  it("allows non-browser and loopback origins, refuses foreign ones", () => {
    const host = "127.0.0.1:4577";

    // Non-browser clients (harness ws client, React Native, scripts) send
    // no Origin header at all.
    expect(wsUpgradeOriginAllowed(null, host)).toBe(true);
    expect(wsUpgradeOriginAllowed(undefined, host)).toBe(true);
    // Packaged Electron loads the UI via loadFile → file origin / "null".
    expect(wsUpgradeOriginAllowed("file://", host)).toBe(true);
    expect(wsUpgradeOriginAllowed("null", host)).toBe(true);
    // The dev stack: vite/preview pages on any loopback port.
    expect(wsUpgradeOriginAllowed("http://localhost:5200", host)).toBe(true);
    expect(wsUpgradeOriginAllowed("http://127.0.0.1:5199", host)).toBe(true);
    expect(wsUpgradeOriginAllowed("https://localhost:4173", host)).toBe(true);
    expect(wsUpgradeOriginAllowed("http://[::1]:5200", host)).toBe(true);
    // A page served by the relay itself is same-origin by definition.
    expect(
      wsUpgradeOriginAllowed("http://100.64.1.2:4577", "100.64.1.2:4577"),
    ).toBe(true);

    // Browser pages on any other origin never reach session.hello.
    expect(wsUpgradeOriginAllowed("https://evil.example", host)).toBe(false);
    expect(wsUpgradeOriginAllowed("http://192.168.1.5:8080", host)).toBe(false);
    expect(wsUpgradeOriginAllowed("http://127.0.0.1.evil.example", host)).toBe(
      false,
    );
    expect(wsUpgradeOriginAllowed("chrome-extension://abc", host)).toBe(false);
    expect(wsUpgradeOriginAllowed("not a url", host)).toBe(false);
  });

  it("a spawned relay answers 403 to foreign origins and upgrades allowed ones", async () => {
    const relay = await startRelay();
    /** Resolve 101 on upgrade, the HTTP status on refusal, -1 on error. */
    const attempt = (origin?: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(
          relay.url,
          origin === undefined ? undefined : { headers: { origin } },
        );
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

    expect(await attempt("https://evil.example")).toBe(403);
    expect(await attempt("http://192.168.1.20:8000")).toBe(403);
    expect(await attempt("http://localhost:5200")).toBe(101);
    expect(await attempt("file://")).toBe(101);
    expect(await attempt()).toBe(101);
  });
});

describe("AC-3 /pair/exchange throttle", () => {
  const post = (app: ReturnType<typeof createApp>, code: string) =>
    app.request("/pair/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });

  it("five consecutive unknown codes lock the endpoint — even a valid code waits out the cooldown", async () => {
    let clock = 1_000;
    const pairing = createPairingService({
      store: createMemoryStore(),
      now: () => clock,
    });
    for (let i = 0; i < 5; i++) {
      expect(await pairing.exchangeGrant({ code: "WRONGWRONGWR" })).toEqual({
        error: "unknown",
      });
    }

    // Locked: a real grant minted mid-lockdown can't be spent either.
    const grant = await pairing.mintGrant();
    expect(await pairing.exchangeGrant({ code: grant.code })).toEqual({
      error: "throttled",
    });

    // The documented cooldown (SECURITY.md: 60s) lifts the lock.
    clock += 60_000;
    const ok = await pairing.exchangeGrant({ code: grant.code });
    expect("device" in ok).toBe(true);
  });

  it("used/expired replies prove a held code — they never consume the guess budget", async () => {
    let clock = 1_000;
    const pairing = createPairingService({
      store: createMemoryStore(),
      now: () => clock,
    });
    const grant = await pairing.mintGrant();
    const first = await pairing.exchangeGrant({ code: grant.code });
    expect("device" in first).toBe(true);

    // Replays of the spent grant answer `used`, no matter how many.
    for (let i = 0; i < 10; i++) {
      expect(await pairing.exchangeGrant({ code: grant.code })).toEqual({
        error: "used",
      });
    }
    // An unspent grant past its TTL answers `expired`, also uncounted.
    const stale = await pairing.mintGrant();
    clock += PAIRING_GRANT_TTL_MS + 1;
    for (let i = 0; i < 10; i++) {
      expect(await pairing.exchangeGrant({ code: stale.code })).toEqual({
        error: "expired",
      });
    }
    // Nothing tripped: a fresh grant still exchanges.
    const fresh = await pairing.mintGrant();
    const ok = await pairing.exchangeGrant({ code: fresh.code });
    expect("device" in ok).toBe(true);
  });

  it("a successful exchange resets the miss counter", async () => {
    const pairing = createPairingService({ store: createMemoryStore() });
    for (let i = 0; i < 4; i++) {
      expect(await pairing.exchangeGrant({ code: "BADBADBADBAD" })).toEqual({
        error: "unknown",
      });
    }
    const grant = await pairing.mintGrant();
    expect(
      "device" in (await pairing.exchangeGrant({ code: grant.code })),
    ).toBe(true);
    // Budget is fresh again — four more misses stay under the limit.
    for (let i = 0; i < 4; i++) {
      expect(await pairing.exchangeGrant({ code: "BADBADBADBAD" })).toEqual({
        error: "unknown",
      });
    }
  });

  it("POST /pair/exchange answers 410 while guesses fit, then 429", async () => {
    const pairing = createPairingService({ store: createMemoryStore() });
    const app = createApp({
      instanceId: "test",
      relayVersion: "0",
      pairing,
    });
    for (let i = 0; i < 5; i++) {
      expect((await post(app, "NOPE-NOPE-NOPE")).status).toBe(410);
    }
    const refused = await post(app, "NOPE-NOPE-NOPE");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "throttled" });
  });
});
