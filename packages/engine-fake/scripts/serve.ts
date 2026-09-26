/**
 * WebSocket entry point — the only place engine-fake touches Bun APIs
 * (AGENTS.md: Bun-only APIs live at entry points, packages stay neutral).
 *
 *   bun packages/engine-fake/scripts/serve.ts [--port N] [--tick MS]
 *
 * Serves the protocol at ws://127.0.0.1:PORT/ws and prints
 * `LISTENING ws://...` on stdout once up.
 */
import { FakeEngine } from "../src/engine.js";
import { eventFrame, handleJsonRpc } from "../src/transport.js";

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};

const engine = new FakeEngine({ tick: arg("tick", 25) });
const clients = new Set<{ send: (s: string) => void }>();
engine.onEvent((e) => {
  const frame = eventFrame(e);
  for (const ws of clients) ws.send(frame);
});

const server = Bun.serve({
  port: arg("port", 0),
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws" && srv.upgrade(req)) return;
    return new Response("engine-fake: websocket at /ws", { status: 404 });
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
