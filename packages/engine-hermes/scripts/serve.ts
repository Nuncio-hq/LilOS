/**
 * WebSocket entry point — the only place engine-hermes touches Bun APIs
 * (AGENTS.md: Bun-only APIs live at entry points, packages stay neutral).
 *
 *   bun packages/engine-hermes/scripts/serve.ts \
 *     [--port N] [--hermes-bin PATH] [--hermes-args "..."]
 *     [--provider NAME] [--model NAME] [--sessions-file PATH]
 *     [--acp-args "..."] [--acp-env K=V,K=V]
 *
 * Spawns `hermes serve` (generated token on 127.0.0.1), connects the engine,
 * then serves the LilOS protocol at ws://127.0.0.1:PORT/ws and prints
 * `LISTENING ws://...` on stdout once up. #482: `HermesBackendSupervisor`
 * keeps the backend watched — a dead child or dropped socket fails engine
 * calls fast typed and relaunches `hermes serve` with backoff instead of
 * leaving the adapter "running" on a corpse.
 */
import { homedir } from "node:os";
import { MAX_FRAME_BYTES } from "@lilos/contracts/engine";
import { HermesBackendSupervisor } from "../src/backend.js";
import { HermesEngine } from "../src/engine.js";
import { RpcError } from "../src/errors.js";
import { HermesHostConflict } from "../src/serve.js";
import { eventFrame, handleJsonRpc } from "../src/transport.js";
import {
  HERMES_HOST_CONFLICT_EXIT_CODE,
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
const backend = new HermesBackendSupervisor({
  bin: arg("hermes-bin", process.env.HERMES_BIN ?? "hermes"),
  ...(hermesArgs ? { args: hermesArgs.split(" ").filter(Boolean) } : {}),
  spawnTimeoutMs: Number(process.env.HERMES_SERVE_TIMEOUT_MS ?? 240_000),
  ...(process.env.HERMES_SERVE_PID_FILE
    ? { pidFile: process.env.HERMES_SERVE_PID_FILE }
    : {}),
  onLog: (line) => console.log(line),
});

let engine: HermesEngine;
try {
  const gateway = await backend.start();
  console.log(`hermes serve ready (token generated)`);
  const acpArgs = arg("acp-args");
  const acpEnv = arg("acp-env");
  engine = new HermesEngine({
    gateway,
    ...(arg("provider") ? { provider: arg("provider") } : {}),
    ...(arg("model") ? { model: arg("model") } : {}),
    ...(arg("sessions-file") ? { sessionsFile: arg("sessions-file") } : {}),
    onBackendNeeded: () => backend.kick(),
    onLog: (line) => console.log(line),
    hermesHome: process.env.HERMES_HOME ?? `${homedir()}/.hermes`,
    acp: {
      bin: arg("hermes-bin", process.env.HERMES_BIN ?? "hermes"),
      ...(acpArgs ? { args: acpArgs.split(" ").filter(Boolean) } : {}),
      ...(acpEnv
        ? {
            env: Object.fromEntries(
              acpEnv
                .split(",")
                .map((kv) => kv.split("=", 2) as [string, string]),
            ),
          }
        : {}),
    },
  });
  /* From here the supervisor owns the backend lifetime: death →
     markBackendDown (calls fail fast typed) → backoff relaunch →
     setGateway — and sessions lazily resume their stored row. */
  backend.attachReactor(engine);
  console.log(
    `handshake server_requests: ${[...gateway.serverRequests].sort().join(",")}`,
  );
} catch (e) {
  // -32601 on client.capabilities = a Hermes older than the handshake
  // (AC-1, #95): print the plain verdict and exit the reserved code so the
  // launcher marks it fatal instead of counting a restartable crash.
  if (e instanceof RpcError && e.code === -32601) {
    console.error(hermesTooOldMessage(undefined));
    process.exit(HERMES_TOO_OLD_EXIT_CODE);
  }
  // #548: the multiplex attach/refusal names its owner — exit the reserved
  // code so the launcher marks it fatal instead of retrying 5 times.
  if (e instanceof HermesHostConflict) {
    console.error(e.message);
    process.exit(HERMES_HOST_CONFLICT_EXIT_CODE);
  }
  die(e);
}

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
    /* #551: prompts carry attachments as inline base64 image blocks — a
       maximal send (~140 MB) must fit or the harness's socket drops. */
    maxPayloadLength: MAX_FRAME_BYTES,
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
    await backend.close();
    process.exit(0);
  });
}
