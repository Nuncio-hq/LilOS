/**
 * WebSocket entry point — the only place engine-fake touches Bun APIs
 * (D-#3: Bun-only APIs live at entry points, packages stay neutral).
 *
 *   bun packages/engine-fake/scripts/serve.ts [--port N] [--tick MS] [--no-steer]
 *                                        [--watch-stdin] [--tag MARKER]
 *                                        [--ask-open-delay MS]
 *
 * Serves the protocol at ws://127.0.0.1:PORT/ws and prints
 * `LISTENING ws://...` on stdout once up. The listener binds 127.0.0.1
 * only. `/ws` requires `LILOS_ENGINE_PROTOCOL_TOKEN` (the harness grants
 * it on spawn and sends it as `?token=`); a missing or wrong token is 401
 * and the socket never attaches. `--no-steer` serves an engine that
 * does not declare the steer capability (`describe` omits it, `session.steer`
 * answers METHOD_NOT_FOUND) — the queued-composer path's counterpart.
 *
 * `--watch-stdin` (set by the harness launcher): exit when stdin closes — the
 * pipe's write end dies with the harness process, even on SIGKILL, so the
 * engine never outlives its launcher (#84). `--tag` is a plain argv marker so
 * e2e teardown can pgrep for engines a specific boot leaked.
 */
import { execFileSync } from "node:child_process";
import { authorizeLoopbackUpgrade } from "@lilos/contracts/auth";
import { MAX_FRAME_BYTES } from "@lilos/contracts/engine";
import { takeEngineProtocolToken } from "@lilos/contracts/env";
import { FakeEngine } from "../src/engine.js";
import { eventFrame, handleJsonRpc } from "../src/transport.js";

/* D-#564 (#752): read the per-launch credential and drop it before any
   child (the orphan watchdog's `ps`, MCP servers) can inherit a secret
   that drives this socket. Not on the D-#412 allow-list for that reason —
   the harness passes it as an explicit spawn grant. Empty fails closed
   inside the upgrade gate. */
const protocolToken = takeEngineProtocolToken();

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
  /* #621 e2e hook: delay each approval's `request.opened` — mirrors the
     open→paint lag a loaded box adds before the card, so ask-driving
     helpers can be exercised against a late card. 0 opens at once. */
  askOpenDelayMs: arg("ask-open-delay", 0),
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

/* Orphan watchdog (#347), unconditional: a fake engine exists only inside a
   test/dev tree, so once the spawner is gone this process is by definition a
   leak — the ~3.5-day-old `serve.ts --tick 25` orphans Oscar swept. Exit
   when we are reparented (our parent died) or when our parent gets
   reparented (the owner past a `bun run` shim died). Same check as
   @lilos/background's watchOrphaned, inlined — engines depend only on
   contracts. Belt under --watch-stdin for launchers that cannot hold our
   stdin (detached groups, `stdio: ["ignore"]`). launchd-installed runs are
   safe: their ppid is 1 from the start and never changes. */
const ppid0 = process.ppid;
const parentPpid = (pid: number): number | null => {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
};
const gpid0 = ppid0 <= 1 ? null : parentPpid(ppid0);
setInterval(() => {
  if (process.ppid !== ppid0) process.exit(0);
  const gp = parentPpid(ppid0);
  /* `null` = `ps` couldn't say (transient under load) — not evidence; a
     truly dead parent reparents us, which the first check catches. */
  if (gpid0 !== null && gp !== null && gp !== gpid0) process.exit(0);
}, 1_000).unref();

const server = Bun.serve({
  /* D-#564 (#752): Bun's default hostname is every interface, which is
     what the old LISTENING line claimed was 127.0.0.1. Bind the loopback
     interface only — another machine must not be able to open this port. */
  hostname: "127.0.0.1",
  port: arg("port", 0),
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const denied = authorizeLoopbackUpgrade(req, protocolToken);
      if (denied) return denied;
      if (srv.upgrade(req)) return;
      return new Response("websocket upgrade failed\n", { status: 400 });
    }
    return new Response("engine-fake: websocket at /ws", { status: 404 });
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

/* #825: this is the port the kernel assigned (`--port 0`). Parents parse
   `LISTENING ws://127.0.0.1:<port>/ws` — nothing picks the port first. */
console.log(`LISTENING ws://127.0.0.1:${server.port}/ws`);
