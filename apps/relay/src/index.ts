/**
 * Relay entry point — the only file in this app allowed to touch Bun APIs
 * (`bun:sqlite`, `Bun.serve`). Everything else is plain TS so the protocol
 * machine, stores' SQL, and Hono app stay testable under Node/vitest.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import packageJson from "../package.json";
import { createApp } from "./app";
import { createFileAttachmentStore } from "./attachments";
import { loadOrCreateInstallToken } from "./auth";
import { resolveRelayConfig } from "./config";
import { createDrizzleStore } from "./db/drizzle-store";
import { applyMigrations } from "./db/migrate";
import * as schema from "./db/schema";
import { createExpoPushSender } from "./expo";
import { createLogTail } from "./logtail";
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
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        const ok = server.upgrade(request);
        return ok
          ? undefined
          : new Response("websocket upgrade failed", { status: 400 });
      }
      return app.fetch(request);
    },
    websocket: {
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

// Under launchd a re-registered agent spawns while the old process is still
// tearing down, so EADDRINUSE is transient there — retry briefly before
// giving up (launchd throttles fast exits into "spawn failed"). The tailnet
// bind needs the same grace: accepted sockets outlive a killed process in
// TIME_WAIT, so a restart's rebind can collide.
const listen = (bindHost: string) => {
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
      Bun.sleepSync(250);
    }
  }
  if (!server) throw new Error(`port ${config.port} still busy after retries`);
  return server;
};

/* Same retry loop but async: the tailnet bind runs while the loopback
   server is already serving, and Bun.sleepSync there would freeze every
   local client for the whole retry window. Still retries — a restart's
   rebind can hit TIME_WAIT from its own accepted tailnet sockets. */
const listenAsync = async (bindHost: string) => {
  let server: ReturnType<typeof listenOnce> | undefined;
  for (let i = 0; i < 40 && !server; i++) {
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
let tailscaleServer: ReturnType<typeof listen> | undefined;
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
        tailscaleServer = await listenAsync(bindIp);
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
});
const app = createApp({
  instanceId: relay.instanceId,
  relayVersion: releaseVersion,
  pairing,
});

const server = listen(config.host);

const address = `${server.hostname}:${server.port}`;
relay.log(`listening on http://${address} (ws: /ws)`);
relay.log(`home: ${config.homeDir}`);
console.log(`[relay] listening on http://${address} (ws: /ws)`);
console.log(`[relay] home: ${config.homeDir}`);
console.log(`[relay] instanceId: ${relay.instanceId}`);

// Rebind the tailnet listener after restarts while phone access stays on.
const phoneAccessOn = await store.getSetting(PHONE_ACCESS_SETTING);
if (phoneAccessOn === true) {
  const bound = await phoneAccess.enable();
  if (!bound) {
    relay.log("phone access on but Tailscale unavailable — staying loopback");
  }
}
