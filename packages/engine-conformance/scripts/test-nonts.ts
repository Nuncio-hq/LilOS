/**
 * AC-3 runner for `bun run test:nonts` (wired into `bun run verify`):
 * starts engine-fake's Bun WebSocket entry, drives it with the Python stdlib
 * client, and exits non-zero unless the client prints AC-3 PASS.
 *
 *   bun packages/engine-conformance/scripts/test-nonts.ts
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVE = join(PKG, "..", "engine-fake", "scripts", "serve.ts");
const CLIENT = join(PKG, "clients", "python", "drive.py");
const SCHEMA = join(
  PKG,
  "..",
  "contracts",
  "generated",
  "engine-protocol.schema.json",
);

const server = spawn("bun", [SERVE, "--port", "0", "--tick", "5"], {
  stdio: ["ignore", "pipe", "inherit"],
});

const url = await new Promise<string>((resolve, reject) => {
  let buf = "";
  server.stdout.on("data", (d) => {
    buf += d;
    const m = buf.match(/LISTENING (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  server.on("exit", (c) =>
    reject(new Error(`engine-fake serve exited ${c}: ${buf}`)),
  );
  setTimeout(
    () => reject(new Error("timed out waiting for LISTENING")),
    15_000,
  );
});

console.log(`engine-fake listening on ${url}`);
const client = spawn("python3", [CLIENT, "--url", url, "--schema", SCHEMA], {
  stdio: "inherit",
});
const code = await new Promise<number>((resolve) =>
  client.on("exit", (c) => resolve(c ?? 1)),
);
server.kill("SIGTERM");
process.exit(code);
