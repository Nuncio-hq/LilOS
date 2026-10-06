/**
 * Relay entry point — the only file in this app allowed to touch Bun APIs
 * (`bun:sqlite`, `Bun.serve`). Everything else is plain TS so the protocol
 * machine, stores' SQL, and Hono app stay testable under Node/vitest.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { systemClock, watchOrphaned } from "@lilos/background";
import { MAX_FRAME_BYTES } from "@lilos/contracts/engine";
import { drizzle } from "drizzle-orm/bun-sqlite";
import packageJson from "../package.json";
import { createApp } from "./app";
import { createFileAttachmentStore } from "./attachments";
import { authorizeRelayUpgrade, loadOrCreateInstallToken } from "./auth";
import { resolveRelayConfig } from "./config";
import { createDrizzleStore } from "./db/drizzle-store";
import { applyMigrations } from "./db/migrate";
import * as schema from "./db/schema";
import { createExpoPushSender } from "./expo";
import { createLogTail } from "./logtail";
import { wsUpgradeOriginAllowed } from "./origin";
import { createPairingService } from "./pairing";
import { createPushFanout } from "./push";
import { createRelay, type PhoneAccess } from "./session";
import { resolveTailscaleProbe } from "./tailscale";

/** Release version — stamped at bundle build time (#35); repo builds report package.json's. */
const releaseVersion = process.env.LILOS_RELEASE_VERSION ?? packageJson.version;

const config = resolveRelayConfig();
mkdirSync(config.homeDir, { recursive: true, mode: 0o700 });

const token = loadOrCreateInstallToken(config.tokenPath);
const sqlite = new Database(config.dbPath);
sqlite.exec("PRAGMA journal_mode = WAL");
sqlite.exec("PRAGMA foreign_keys = ON");
applyMigrations(sqlite);

const store = createDrizzleStore(drizzle(sqlite, { schema }));
const attachments = createFileAttachmentStore(
  join(config.homeDir, "attachments"),
);
const pairing = createPairingService({
  store,
  grantTtlMs: process.env.LILOS_PAIRING_TTL_MS
    ? Number(process.env.LILOS_PAIRING_TTL_MS)
    : undefined,
});

type RelayPeer = ReturnType<typeof relay.connect>;
const peers = new Map<unknown, RelayPeer>();

// `relay`/`app` below are initialized before listen() is ever invoked.
const listenOnce = (bindHost: string) =>
  Bun.serve({
    hostname: bindHost,
    port: config.port,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        /* #568: refuse browser upgrades from foreign origins before the
           socket exists — a page on another site can't even reach
           session.hello to guess the token. Runs on both listeners
           (loopback + the opt-in tailnet bind share this fetch). */
        if (
          !wsUpgradeOriginAllowed(
            request.headers.get("origin"),
            request.headers.get("host"),
            request.headers.get("user-agent"),
          )
        ) {
          return new Response("websocket upgrade refused", { status: 403 });
        }
        /* #625: the credential check runs before `server.upgrade` too —
           Bun buffers a whole ws frame before dispatch, so an
           unauthenticated socket could otherwise pin up to
           MAX_FRAME_BYTES per connection without ever reaching
           session.hello (the #564 feed-gate pattern). Async is safe:
           Bun resolves the upgrade when fetch's promise settles. */
        const denied = await authorizeRelayUpgrade(request, {
          token,
          pairing,
        });
        if (denied) return denied;
        const ok = server.upgrade(request);
        return ok
          ? undefined
          : new Response("websocket upgrade failed", { status: 400 });
      }
      return app.fetch(request);
    },
    websocket: {
      /* #551: Bun's 16 MiB default sat under a maximal attachment send
         (10 × 10 MB base64-inlined ≈ 140 MB) and dropped the socket mid-send.
         The cap is deliberate — sized so every contract-valid frame fits. */
      maxPayloadLength: MAX_FRAME_BYTES,
      open(ws) {
        peers.set(
          ws,
          relay.connect({
            send: (frame) => ws.send(frame),
            close: (code, reason) => ws.close(code, reason),
          }),
        );
      },
      async message(ws, message) {
        if (typeof message !== "string") return;
        await peers.get(ws)?.receive(message);
      },
      close(ws) {
        peers.get(ws)?.closed();
        peers.delete(ws);
      },
    },
  });

/* Under launchd a re-registered agent spawns while the old process is still
   tearing down, so EADDRINUSE is transient there — retry briefly before
   giving up (launchd throttles fast exits into "spawn failed"). The tailnet
   bind needs the same grace: accepted sockets outlive a killed process in
   TIME_WAIT, so a restart's rebind can collide. Always async (#516): a
   Bun.sleepSync retry freezes the loop for the whole window — a kill in
   that window is ignored until SIGKILL and every buffered log line is
   dropped. */
const listen = async (bindHost: string) => {
  let server: ReturnType<typeof listenOnce> | undefined;
  for (let i = 0; i < 60 && !server; i++) {
    try {
      server = listenOnce(bindHost);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EADDRINUSE" && !/in use|EADDRINUSE/i.test(e.message)) {
        throw err;
      }
      console.error(
        `[relay] port ${config.port} on ${bindHost} busy, retrying`,
      );
      await Bun.sleep(250);
    }
  }
  if (!server) throw new Error(`port ${config.port} still busy after retries`);
  return server;
};

/**
 * Opt-in Tailscale listener (#153): a second Bun.serve on this Mac's CGNAT
 * address. It only ever binds the tailnet IP — never loopback — so a QR can
 * never invite a phone to an address that doesn't reach it. `phoneAccess`
 * persists as a setting so a relay restart keeps the chosen mode.
 */
const probeTailscale = resolveTailscaleProbe();
let tailscaleServer: Awaited<ReturnType<typeof listen>> | undefined;
let tailscaleAdvertised: string | undefined;
const PHONE_ACCESS_SETTING = "phoneAccess";

/* One enable/disable in flight at a time: the probe→bind sequence is async,
   so a racing pair of calls (double-clicked dialog, startup rebind vs. an
   RPC) could double-bind or let an in-flight enable's `setSetting(true)`
   overwrite a just-requested disable. */
let phoneAccessGate: Promise<unknown> = Promise.resolve();
const serializePhoneAccess = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = phoneAccessGate.then(fn, fn);
  phoneAccessGate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const phoneAccess: PhoneAccess = {
  enable: () =>
    serializePhoneAccess(async () => {
      if (tailscaleServer) {
        return tailscaleAdvertised
          ? { host: `${tailscaleAdvertised}:${tailscaleServer.port}` }
          : null;
      }
      const probe = await probeTailscale();
      const bindIp = probe.ok ? probe.self.ipv4s[0] : undefined;
      if (!probe.ok || !bindIp) {
        relay.log(
          `tailscale unavailable (${probe.ok ? "no tailnet IPv4" : probe.reason})`,
        );
        return null;
      }
      try {
        tailscaleServer = await listen(bindIp);
      } catch (err) {
        relay.log(`tailscale bind ${bindIp}:${config.port} failed: ${err}`);
        return null;
      }
      // MagicDNS name over raw IP in the QR host when the tailnet has one.
      tailscaleAdvertised = probe.self.dnsName ?? bindIp;
      await store.setSetting(PHONE_ACCESS_SETTING, true);
      relay.log(
        `tailscale listener on http://${bindIp}:${tailscaleServer.port}`,
      );
      return { host: `${tailscaleAdvertised}:${tailscaleServer.port}` };
    }),
  disable: () =>
    serializePhoneAccess(async () => {
      tailscaleServer?.stop(true);
      tailscaleServer = undefined;
      tailscaleAdvertised = undefined;
      await store.setSetting(PHONE_ACCESS_SETTING, false);
    }),
};

/* Push fan-out (#161): ask/turn transitions → Expo push for every
   registered phone. `LILOS_EXPO_ENDPOINT` overrides the send target so the
   live leg can point it at a fake collector instead of exp.host. Send
   failures go to the same log tail `system.status` surfaces. */
const logTail = createLogTail();
const push = createPushFanout({
  store,
  send: createExpoPushSender({
    endpoint: process.env.LILOS_EXPO_ENDPOINT,
  }),
  log: (message) => logTail.log(message),
});

const relay = createRelay({
  store,
  token,
  relayVersion: releaseVersion,
  attachments,
  pairing,
  macName: hostname(),
  phoneAccess,
  logTail,
  push,
  /* #625: test knob — how long an upgraded socket may sit silent before
     it's closed without a session.hello. */
  helloDeadlineMs: process.env.LILOS_HELLO_DEADLINE_MS
    ? Number(process.env.LILOS_HELLO_DEADLINE_MS)
    : undefined,
});
const app = createApp({
  instanceId: relay.instanceId,
  relayVersion: releaseVersion,
  pairing,
});

/* Log our id BEFORE bind: an e2e readiness probe (#273) must know the id of
   the relay it spawned even when a foreign stack already holds the port —
   post-bind it would never print and the probe couldn't name both ids.
   Written unbuffered (#516): buffered stdout can be dropped when the
   process is killed mid-boot, and the probe then never sees the id. This
   line is also how `bun run dev` learns which instanceId is its own. */
try {
  writeSync(1, `[relay] instanceId: ${relay.instanceId}\n`);
} catch {
  // fd 1 closed (spawned with stdout ignored) — /healthz carries the id.
}

const server = await listen(config.host);

const address = `${server.hostname}:${server.port}`;
relay.log(`listening on http://${address} (ws: /ws)`);
relay.log(`home: ${config.homeDir}`);
console.log(`[relay] listening on http://${address} (ws: /ws)`);
console.log(`[relay] home: ${config.homeDir}`);

// Rebind the tailnet listener after restarts while phone access stays on.
const phoneAccessOn = await store.getSetting(PHONE_ACCESS_SETTING);
if (phoneAccessOn === true) {
  const bound = await phoneAccess.enable();
  if (!bound) {
    relay.log("phone access on but Tailscale unavailable — staying loopback");
  }
}

// Orphan watchdog (#347): die with the tree that spawned us — a killed test
// worker or `bun run dev` umbrella otherwise leaves the relay holding its
// port for days. Safe under launchd: a daemon's ppid is 1 and never moves.
watchOrphaned({
  clock: systemClock,
  intervalMs: 1_000,
  onOrphaned: (reason) => {
    relay.log(`orphaned (${reason}) — exiting`);
    process.exit(0);
  },
});
