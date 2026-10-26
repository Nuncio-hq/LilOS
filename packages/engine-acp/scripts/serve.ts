import { execFileSync } from "node:child_process";
import { authorizeLoopbackUpgrade } from "@lilos/contracts/auth";
import { MAX_FRAME_BYTES } from "@lilos/contracts/engine";
import { scrubLilosEnv, takeEngineProtocolToken } from "@lilos/contracts/env";
import { ACP_AGENTS } from "../shims/registry.js";
import { AcpEngine } from "../src/engine.js";
import type { AcpLaunchSpec } from "../src/launch.js";
import { probeExecutable } from "../src/launch.js";
import { resolveAgentCommand } from "../src/provision.js";
import { AcpClientTerminals } from "../src/terminals.js";
import { acpEventFrame, handleJsonRpc } from "../src/transport.js";

/**
 * WebSocket entry point — the only place engine-acp touches Bun APIs
 * (D-#3). One of:
 *
 *   bun packages/engine-acp/scripts/serve.ts --agent devin
 *   bun packages/engine-acp/scripts/serve.ts --command "bun scripts/fake-agent.ts"
 *
 *   [--port N] [--watch-stdin] [--tag MARKER] [--name NAME]
 *
 * D-#845: `--agent` picks a curated registry entry (the REGISTRY table —
 * the local stand-in for T3's remote ACP registry; verified install, the
 * agent's own login, no stored credentials). `--command` runs any local
 * ACP command verbatim. The child env is D-#412-scrubbed inside the seam,
 * so what a signed-in CLI needs (HOME, PATH, provider keys) passes while
 * LilOS-internal state never crosses the spawn boundary.
 *
 * Serves the protocol at ws://127.0.0.1:PORT/ws and prints
 * `LISTENING ws://...` once up; `/ws` requires the per-launch
 * LILOS_ENGINE_PROTOCOL_TOKEN grant (D-#564). `--watch-stdin` exits when
 * the launcher's stdin pipe dies (#84).
 */

/* D-#564 (#752): read the per-launch credential and drop it before any
   child (the agent, its MCP servers, terminal commands, the watchdog's
   `ps`) can inherit the secret that drives this socket. */
const protocolToken = takeEngineProtocolToken();

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

/* The curated registry (D-#845) lives in `shims/registry.ts` — shared
   with the harness's runtime catalog (D-#761). */
const REGISTRY = ACP_AGENTS;

const spec: AcpLaunchSpec = (() => {
  const agent = arg("agent");
  const command = arg("command");
  if (agent && command) {
    console.error("engine-acp: pass --agent or --command, not both");
    process.exit(2);
  }
  if (agent) {
    const entry = REGISTRY[agent];
    if (!entry) {
      console.error(
        `engine-acp: unknown agent "${agent}" — registry has: ${Object.keys(REGISTRY).join(", ") || "(empty)"}; or pass --command`,
      );
      process.exit(2);
    }
    return entry;
  }
  if (command) {
    const argv = command.trim().split(/\s+/).filter(Boolean);
    if (argv.length === 0) {
      console.error("engine-acp: --command is empty");
      process.exit(2);
    }
    /* The roster seed for an unnamed command: the executable basename as
       the display name — `devin acp` shows as "Devin", anything else as
       itself. --name overrides for a friendlier engine/agent label. */
    const base =
      argv[0]
        .split("/")
        .pop()
        ?.replace(/\.[^.]*$/, "") ?? "agent";
    const display = base.charAt(0).toUpperCase() + base.slice(1);
    return {
      id: "command",
      command: argv,
      agent: {
        id: "command",
        name: display,
        description: `The configured ACP command: ${argv.join(" ")}`,
        detail: { isDefault: true },
      },
    };
  }
  console.error(
    'engine-acp: pass --agent <id> (registry entry) or --command "<argv>"',
  );
  process.exit(2);
})();

/* Verified install (T3's AcpRegistrySupport idea, D-#845; npm recipe
   per D-#866): the spec's launch command must resolve — an installed
   binary on PATH, else the pinned npm distribution fetched once into
   the LilOS cache — and answer the probe before we serve. A missing
   runner or a failed fetch fails at launch with the reason, never
   inside the first prompt turn. Provision reads the engine's env
   (post-token-drop): LILOS_ACP_CACHE stays visible here so the cache
   root resolves; the agent child's env is scrubbed in the seam. */
const r = resolveAgentCommand(spec, process.env);
if (!r.ok || !r.command) {
  console.error(
    `engine-acp: ${spec.id} is not launchable — ${r.output || "unresolved command"} ` +
      `(install it yourself or pass --command; its own login carries the session)`,
  );
  process.exit(1);
}
const command = r.command;
if (spec.verify) {
  const probe = await probeExecutable(
    command[0] as string,
    [...command.slice(1), ...spec.verify.args],
    {
      env: scrubLilosEnv(process.env),
      ...(spec.verify.timeoutMs !== undefined
        ? { timeoutMs: spec.verify.timeoutMs }
        : {}),
    },
  );
  if (!probe.ok) {
    console.error(
      `engine-acp: "${command.join(" ")}" failed (install verification) — ${probe.output || "non-zero exit"}`,
    );
    process.exit(1);
  }
}

const terminals = spec.clientCapabilities?.terminal
  ? new AcpClientTerminals({
      ...(spec.terminals?.shellCommands !== undefined
        ? { shellCommands: spec.terminals.shellCommands }
        : {}),
      cwd: process.cwd(),
      /* Post-token-drop, pre-scrubbed env — the same view the agent child
         gets, so a command's PATH/HOME sees the login env. */
      env: scrubLilosEnv(process.env),
    })
  : undefined;

const engine = new AcpEngine({
  name: arg("name") ?? `engine-acp-${spec.id}`,
  command,
  clientInfo: { name: "lilos", version: "0" },
  ...(spec.agent ? { agent: spec.agent } : {}),
  ...(spec.clientCapabilities
    ? { clientCapabilities: spec.clientCapabilities }
    : {}),
  ...(terminals ? { terminals } : {}),
  ...(spec.modeForAccess ? { modeForAccess: spec.modeForAccess } : {}),
  ...(spec.defaultEffort ? { defaultEffort: spec.defaultEffort } : {}),
  ...(spec.sessionMeta ? { sessionMeta: spec.sessionMeta } : {}),
  ...(spec.env || r.env ? { env: { ...spec.env, ...r.env } } : {}),
  ...(spec.dropEnv ? { dropEnv: spec.dropEnv } : {}),
});
const clients = new Set<{ send: (s: string) => void }>();
engine.onEvent((e) => {
  const frame = acpEventFrame(e);
  for (const ws of clients) ws.send(frame);
});

if (flag("watch-stdin")) {
  // The pipe's write end dies with the harness process — exit with it.
  process.stdin.resume();
  process.stdin.once("end", () => process.exit(0));
  process.stdin.once("close", () => process.exit(0));
  process.stdin.once("error", () => process.exit(0));
}

/* Orphan watchdog (#347), same check as engine-fake: exit when reparented
   or when our parent gets reparented (the owner past a `bun run` shim
   died). A launchd-installed run has ppid 1 from the start — never trips. */
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
  if (gpid0 !== null && gp !== null && gp !== gpid0) process.exit(0);
}, 1_000).unref();

const server = Bun.serve({
  /* D-#564 (#752): loopback only — nothing off this host may open /ws. */
  hostname: "127.0.0.1",
  port: Number(arg("port") ?? 0),
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const denied = authorizeLoopbackUpgrade(req, protocolToken);
      if (denied) return denied;
      if (srv.upgrade(req)) return;
      return new Response("websocket upgrade failed\n", { status: 400 });
    }
    return new Response("engine-acp: websocket at /ws", { status: 404 });
  },
  websocket: {
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

const shutdown = async () => {
  server.stop();
  await engine.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
