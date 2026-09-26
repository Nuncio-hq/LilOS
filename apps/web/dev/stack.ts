/**
 * `bun run dev` in apps/web — boots the whole dev slice in one shot:
 *
 *   apps/relay    (app protocol, :4577, own LILOS_RELAY_HOME scratch dir)
 *   apps/harness  (workspace harness + engine-fake, feed ws :4581)
 *   vite          (this app, :5200)
 *
 * Then open http://localhost:5200 — or just `bun run dev` and the Electron
 * shell points at the same endpoints.
 *
 * Env overrides: LILOS_RELAY_PORT, LILOS_FEED_PORT, LILOS_WEB_PORT,
 * LILOS_HOME (relay state dir), LILOS_ENGINE + LILOS_ENGINE_URL (proxy a live
 * engine instead of engine-fake), LILOS_HIDE_CAPS (comma-list, e.g. "steer"),
 * HERMES_PROVIDER / HERMES_MODEL / HERMES_BIN for the live leg.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Subprocess, spawn } from "bun";

const here = path.dirname(fileURLToPath(import.meta.url)); // apps/web/dev
const repo = path.resolve(here, "../../..");

const RELAY_PORT = Number(process.env.LILOS_RELAY_PORT ?? 4577);
const FEED_PORT = Number(process.env.LILOS_FEED_PORT ?? 4581);
const WEB_PORT = Number(process.env.LILOS_WEB_PORT ?? 5200);
const HOME =
  process.env.LILOS_HOME ?? mkdtempSync(path.join(tmpdir(), "lilos-dev-"));
mkdirSync(HOME, { recursive: true });
const HARNESS_HOME = path.join(HOME, "harness");

const kids: Subprocess[] = [];
const killAll = () => {
  for (const k of kids) k.kill();
};
process.on("SIGINT", () => {
  killAll();
  process.exit(0);
});
process.on("SIGTERM", () => {
  killAll();
  process.exit(0);
});

const webDir = path.resolve(here, "..");

function run(
  name: string,
  cmd: string[],
  env: Record<string, string>,
  cwd = repo,
): Subprocess {
  const p = spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  kids.push(p);
  console.log(`[stack] ${name}: ${cmd.join(" ")}`);
  return p;
}

const relay = run("relay", ["bun", "run", "apps/relay/src/index.ts"], {
  LILOS_RELAY_HOME: HOME,
  LILOS_RELAY_PORT: String(RELAY_PORT),
  LILOS_RELAY_HOST: "127.0.0.1",
});

// wait for the relay token file AND the socket — the token lands first
const tokenPath = path.join(HOME, "relay-token");
for (let i = 0; i < 100 && !existsSync(tokenPath); i++) {
  await Bun.sleep(50);
}
let relayUp = false;
for (let i = 0; i < 200 && !relayUp; i++) {
  relayUp = await fetch(`http://127.0.0.1:${RELAY_PORT}/`)
    .then((r) => r.status > 0)
    .catch(() => false);
  if (!relayUp) await Bun.sleep(100);
}
if (!relayUp) {
  console.error("[stack] relay never opened its socket");
  killAll();
  process.exit(1);
}
const token = existsSync(tokenPath)
  ? readFileSync(tokenPath, "utf8").trim()
  : "";
if (!token) {
  console.error("[stack] relay did not write its token file");
  killAll();
  process.exit(1);
}
console.log(`[stack] relay ready on :${RELAY_PORT} (home ${HOME})`);

// The harness launches engine-fake itself (LILOS_ENGINE=fake by default);
// LILOS_ENGINE=url + LILOS_ENGINE_URL points it at an external engine.
const harnessEnv: Record<string, string> = {
  LILOS_RELAY_URL: `ws://127.0.0.1:${RELAY_PORT}/ws`,
  LILOS_RELAY_HOME: HOME,
  LILOS_RELAY_TOKEN: token,
  LILOS_HARNESS_HOME: HARNESS_HOME,
  LILOS_REPO_ROOT: repo,
  LILOS_WORKDIR: path.join(HARNESS_HOME, "work"),
  LILOS_FEED_PORT: String(FEED_PORT),
};
if (!process.env.LILOS_ENGINE) harnessEnv.LILOS_ENGINE = "fake";
run("harness", ["bun", "run", "apps/harness/src/index.ts"], harnessEnv);

// wait for the feed socket to accept a connection (harness cold start +
// engine spawn can take a few seconds on a fresh checkout)
let feedUp = false;
for (let i = 0; i < 300 && !feedUp; i++) {
  feedUp = await fetch(`http://127.0.0.1:${FEED_PORT}/`)
    .then((r) => r.ok)
    .catch(() => false);
  if (!feedUp) await Bun.sleep(100);
}
if (!feedUp) {
  console.error("[stack] harness feed never came up");
  killAll();
  process.exit(1);
}

run(
  "web",
  [
    path.join(webDir, "node_modules", ".bin", "vite"),
    "--host",
    "127.0.0.1",
    "--port",
    String(WEB_PORT),
    "--strictPort",
  ],
  {
    LILOS_RELAY_WS: `ws://127.0.0.1:${RELAY_PORT}/ws`,
    LILOS_RELAY_TOKEN: token,
    LILOS_ENGINE_WS: `ws://127.0.0.1:${FEED_PORT}/ws`,
    LILOS_WEB_PORT: String(WEB_PORT),
  },
  webDir,
);

console.log(`
LilOS dev stack
  web     http://localhost:${WEB_PORT}
  relay   ws://127.0.0.1:${RELAY_PORT}/ws   (state: ${HOME})
  feed    ws://127.0.0.1:${FEED_PORT}/ws   (harness; engine ${
    process.env.LILOS_ENGINE ?? "fake"
  })
`);

await relay.exited;
killAll();
