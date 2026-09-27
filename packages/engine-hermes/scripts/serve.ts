/**
 * WebSocket entry point — the only place engine-hermes touches Bun APIs
 * (AGENTS.md: Bun-only APIs live at entry points, packages stay neutral).
 *
 *   bun packages/engine-hermes/scripts/serve.ts \
 *     [--port N] [--hermes-bin PATH] [--hermes-args "..."]
 *     [--provider NAME] [--model NAME]
 *     [--acp-args "..."] [--acp-env K=V,K=V]
 *
 * Spawns `hermes serve` (generated token on 127.0.0.1), connects the engine,
 * then serves the LilOS protocol at ws://127.0.0.1:PORT/ws and prints
 * `LISTENING ws://...` on stdout once up.
 */
import { HermesEngine } from "../src/engine.js";
import { RpcError } from "../src/errors.js";
import { HermesGateway } from "../src/gateway.js";
import { type HermesServeHandle, startHermesServe } from "../src/serve.js";
import { eventFrame, handleJsonRpc } from "../src/transport.js";
import {
  HERMES_TOO_OLD_EXIT_CODE,
  hermesTooOldMessage,
} from "../src/version.js";

/**
 * Die with a clean last line (#95): an uncaught rejection prints a Bun
 * stack, which pushes the real reason out of the stderr tail the harness
 * launcher surfaces. Keep the one-line verdict last so it survives.
 */
const die = (e: unknown): never => {
  const message = e instanceof Error ? e.message : String(e);
  console.error(message);
  const lines = message.split("\n").filter((l) => l.trim());
  if (lines.length > 1 && lines[0]) console.error(lines[0]);
  process.exit(1);
};

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const hermesArgs = arg("hermes-args");
let hermes: HermesServeHandle;
try {
  hermes = await startHermesServe({
    bin: arg("hermes-bin", process.env.HERMES_BIN ?? "hermes"),
    ...(hermesArgs ? { args: hermesArgs.split(" ").filter(Boolean) } : {}),
    timeoutMs: Number(process.env.HERMES_SERVE_TIMEOUT_MS ?? 240_000),
  });
} catch (e) {
  die(e);
}
console.log(`hermes serve ready at ${hermes.url} (token generated)`);

let gateway: HermesGateway;
try {
  gateway = await HermesGateway.connect(
    `ws://127.0.0.1:${hermes.port}/api/ws?token=${hermes.token}`,
  );
} catch (e) {
  // -32601 on client.capabilities = a Hermes older than the handshake
  // (AC-1, #95): print the plain verdict and exit the reserved code so the
  // launcher marks it fatal instead of counting a restartable crash.
  if (e instanceof RpcError && e.code === -32601) {
    console.error(hermesTooOldMessage(undefined));
    process.exit(HERMES_TOO_OLD_EXIT_CODE);
  }
  die(e);
}
const acpArgs = arg("acp-args");
const acpEnv = arg("acp-env");
const engine = new HermesEngine({
  gateway,
  ...(arg("provider") ? { provider: arg("provider") } : {}),
  ...(arg("model") ? { model: arg("model") } : {}),
  acp: {
    bin: arg("hermes-bin", process.env.HERMES_BIN ?? "hermes"),
    ...(acpArgs ? { args: acpArgs.split(" ").filter(Boolean) } : {}),
    ...(acpEnv
      ? {
          env: Object.fromEntries(
            acpEnv.split(",").map((kv) => kv.split("=", 2) as [string, string]),
          ),
        }
      : {}),
  },
});
console.log(
  `handshake server_requests: ${[...gateway.serverRequests].sort().join(",")}`,
);

const clients = new Set<{ send: (s: string) => void }>();
engine.onEvent((e) => {
  const frame = eventFrame(e);
  for (const ws of clients) ws.send(frame);
});

const server = Bun.serve({
  port: Number(arg("port", "0")),
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws" && srv.upgrade(req)) return;
    return new Response("engine-hermes: websocket at /ws", { status: 404 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
    },
    async message(ws, message) {
      const res = await handleJsonRpc(
        engine,
        typeof message === "string" ? message : Buffer.from(message).toString(),
      );
      if (res !== null) ws.send(res);
    },
    close(ws) {
      clients.delete(ws);
    },
  },
});

console.log(`LISTENING ws://127.0.0.1:${server.port}/ws`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    server.stop(true);
    await engine.close();
    await hermes.close();
    process.exit(0);
  });
}
