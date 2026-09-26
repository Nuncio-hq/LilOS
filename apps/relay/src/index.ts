/**
 * Relay entry point — the only file in this app allowed to touch Bun APIs
 * (`bun:sqlite`, `Bun.serve`). Everything else is plain TS so the protocol
 * machine, stores' SQL, and Hono app stay testable under Node/vitest.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
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
import { createRelay } from "./session";

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
const relay = createRelay({
  store,
  token,
  relayVersion: releaseVersion,
  attachments,
});
const app = createApp({
  instanceId: relay.instanceId,
  relayVersion: releaseVersion,
});

type RelayPeer = ReturnType<typeof relay.connect>;
const peers = new Map<unknown, RelayPeer>();

const server = Bun.serve({
  hostname: config.host,
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

const address = `${server.hostname}:${server.port}`;
relay.log(`listening on http://${address} (ws: /ws)`);
relay.log(`home: ${config.homeDir}`);
console.log(`[relay] listening on http://${address} (ws: /ws)`);
console.log(`[relay] home: ${config.homeDir}`);
console.log(`[relay] instanceId: ${relay.instanceId}`);
