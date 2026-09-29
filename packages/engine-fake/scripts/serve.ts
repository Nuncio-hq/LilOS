/**
 * WebSocket entry point — the only place engine-fake touches Bun APIs
 * (AGENTS.md: Bun-only APIs live at entry points, packages stay neutral).
 *
 *   bun packages/engine-fake/scripts/serve.ts [--port N] [--tick MS] [--no-steer]
 *                                        [--watch-stdin] [--tag MARKER]
 *
 * Serves the protocol at ws://127.0.0.1:PORT/ws and prints
 * `LISTENING ws://...` on stdout once up. `--no-steer` serves an engine that
 * does not declare the steer capability (`describe` omits it, `session.steer`
 * answers METHOD_NOT_FOUND) — the queued-composer path's counterpart.
 *
 * `--watch-stdin` (set by the harness launcher): exit when stdin closes — the
 * pipe's write end dies with the harness process, even on SIGKILL, so the
 * engine never outlives its launcher (#84). `--tag` is a plain argv marker so
 * e2e teardown can pgrep for engines a specific boot leaked.
 */
import { FakeEngine } from "../src/engine.js";
import { eventFrame, handleJsonRpc } from "../src/transport.js";

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

/* `--no-cap <id>` (repeatable): serve an engine that does not declare that
   capability — the cap-less harness run AC-5 legs need (e.g. --no-cap
   subagents --no-cap background_jobs). */
const noCap = new Set(
  process.argv
    .map((a, i) => (a === "--no-cap" ? process.argv[i + 1] : undefined))
    .filter((x): x is string => Boolean(x)),
);
const cap = (id: string) => !noCap.has(id);

const engine = new FakeEngine({
  tick: arg("tick", 25),
  capabilities: {
    steer: !flag("no-steer") && cap("steer"),
    subagents: cap("subagents"),
    background_jobs: cap("background_jobs"),
  },
});
const clients = new Set<{ send: (s: string) => void }>();
engine.onEvent((e) => {
  const frame = eventFrame(e);
  for (const ws of clients) ws.send(frame);
});

if (flag("watch-stdin")) {
  // stdin is a pipe whose write end is held by the harness; when that process
  // dies the fd closes and the read side sees EOF — exit with it.
  process.stdin.resume();
  process.stdin.once("end", () => process.exit(0));
  process.stdin.once("close", () => process.exit(0));
  process.stdin.once("error", () => process.exit(0));
}

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
