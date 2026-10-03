/**
 * Print the installed relay's `system.status` as JSON — the same call the
 * app's post-update handshake verifier makes.
 *
 *   bun apps/desktop/scripts/probe-status.ts
 *
 * Env: LILOS_RELAY_URL (default ws://127.0.0.1:4577/ws),
 *      LILOS_HOME (default ~/.lilos, for the relay token).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RelayClient } from "@lilos/client-runtime";

const LILOS_HOME = process.env.LILOS_HOME ?? join(homedir(), ".lilos");
const RELAY_URL = process.env.LILOS_RELAY_URL ?? "ws://127.0.0.1:4577/ws";

const token = readFileSync(join(LILOS_HOME, "relay-token"), "utf8").trim();
const client = new RelayClient({
  url: RELAY_URL,
  token,
  client: { name: "probe-status", version: "0" },
});
await client.connect();
const status = await client.systemStatus();
client.close();
console.log(JSON.stringify(status));
