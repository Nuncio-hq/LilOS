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

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Subprocess, spawn } from "bun";
import { parseListeningPort, requireSlicePort } from "./ready";

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
/**
 * Wait for children to exit before this process exits: a SIGTERM'd child
 * (vite especially) still holds its port while it drains, and if the
 * umbrella exits first a respawned stack races the half-dead child on
 * --strictPort and never serves (#84). Wedged children get SIGKILL after a
 * grace period rather than hanging the shutdown.
 *
 * One in-flight promise. A child that exits first starts it; a later
 * `await shutdown(1)` must wait for that same drain. Returning immediately
 * let the umbrella die while siblings were still exiting (#84).
 */
let shuttingDown: Promise<void> | undefined;
const shutdown = (code: number): Promise<void> => {
  shuttingDown ??= (async () => {
    killAll();
    await Promise.race([
      Promise.allSettled(kids.map((k) => k.exited)),
      Bun.sleep(5_000).then(() => {
        for (const k of kids) if (k.exitCode === null) k.kill("SIGKILL");
      }),
    ]);
    process.exit(code);
  })();
  return shuttingDown;
};
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

// `bun run <script>` spawns this file as a child process and does NOT
// forward signals, so a SIGTERM/SIGKILL aimed at the `bun run dev` shim
// orphans us — and our relay/harness/vite children keep their ports bound,
// poisoning the next stack's boot (#84). Die when we get reparented — or
// when the shim itself gets reparented: a killed test worker leaves the
// shim alive with stdin ignored, and without this hop nothing reaches us
// (#347). Same check as @lilos/background's watchOrphaned, inlined — apps/web
// keeps dev scripts dependency-free.
const parentPidOf = (pid: number): number | null => {
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
const ppid0 = process.ppid;
const gpid0 = ppid0 <= 1 ? null : parentPidOf(ppid0);
setInterval(() => {
  if (process.ppid !== ppid0) void shutdown(0);
  const gp = parentPidOf(ppid0);
  /* `null` = `ps` couldn't say (transient under load) — not evidence; a
     truly dead parent reparents us, which the first check catches. */
  if (gpid0 !== null && gp !== null && gp !== gpid0) void shutdown(0);
}, 300).unref();

const webDir = path.resolve(here, "..");

/** Pipe stdout, forward every byte, keep the text so a port-0 child can be
    read back. A child that exits before its ready line still fails the
    boot — `exited` is observed by the caller, this only captures output. */
function spawnCaptured(
  name: string,
  cmd: string[],
  env: Record<string, string>,
  cwd = repo,
): { proc: Subprocess; text: () => string } {
  const proc = spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "inherit",
  });
  kids.push(proc);
  console.log(`[stack] ${name}: ${cmd.join(" ")}`);
  let buf = "";
  const dec = new TextDecoder();
  void (async () => {
    const stream = proc.stdout as ReadableStream<Uint8Array>;
    for await (const chunk of stream) {
      const text = dec.decode(chunk, { stream: true });
      buf += text;
      process.stdout.write(text);
    }
  })();
  proc.exited.then((code) => {
    if (!shuttingDown) {
      console.error(`[stack] ${name} exited (code ${code})`);
      void shutdown(1);
    }
  });
  return { proc, text: () => buf };
}

/** Fail fast: the ready line, the process exiting, or the budget. No hang. */
async function reportedPort(
  kind: "relay" | "harness" | "web",
  read: () => string,
  proc: Subprocess,
  ms: number,
): Promise<number> {
  const start = Date.now();
  for (;;) {
    const port = parseListeningPort(read(), kind);
    if (port) return port;
    if (proc.exitCode !== null) {
      throw new Error(
        `[stack] ${kind} exited (code ${proc.exitCode}) before reporting its port\n${read().slice(-1200)}`,
      );
    }
    if (Date.now() - start > ms) {
      throw new Error(
        `[stack] timed out waiting for ${kind} to report its port\n${read().slice(-1200)}`,
      );
    }
    await Bun.sleep(50);
  }
}

/* The relay's stdout is piped, not inherited: an identity-checked readiness
   needs the instanceId the relay logs pre-bind (`[relay] instanceId:`), and
   "inherit" gives no access to the stream. Every line is still forwarded so
   the outer boot probe sees the same output. */
const relayProc = spawn(["bun", "run", "apps/relay/src/index.ts"], {
  cwd: repo,
  env: {
    ...process.env,
    LILOS_RELAY_HOME: HOME,
    LILOS_RELAY_PORT: String(RELAY_PORT),
    LILOS_RELAY_HOST: "127.0.0.1",
  },
  stdout: "pipe",
  stderr: "inherit",
});
kids.push(relayProc);
console.log(`[stack] relay: bun run apps/relay/src/index.ts`);

let relayInstance: string | undefined;
let relayUp = false;
let foreign: string | undefined;
relayProc.exited.then((code) => {
  if (!shuttingDown) {
    /* A pre-ready exit still names who held the port (#516) — the outer boot
       probe reads this from the forwarded output. */
    console.error(
      `[stack] relay exited (code ${code})` +
        (relayUp
          ? ""
          : ` before port ${relayPort} was ours` +
            (foreign !== undefined ? ` — /healthz answers ${foreign}` : "") +
            ` (ours ${relayInstance ?? "never logged"})`),
    );
    void shutdown(1);
  }
});

const INSTANCE_LINE = /instanceId: ([0-9a-fA-F-]{36})/;
let relayBuf = "";
void (async () => {
  const dec = new TextDecoder();
  const stream = relayProc.stdout as ReadableStream<Uint8Array>;
  for await (const chunk of stream) {
    const text = dec.decode(chunk, { stream: true });
    relayBuf += text;
    relayInstance ??= INSTANCE_LINE.exec(relayBuf)?.[1];
    process.stdout.write(text);
  }
})();

// wait for the relay token file AND the socket — the token lands first
const tokenPath = path.join(HOME, "relay-token");
for (let i = 0; i < 100 && !existsSync(tokenPath); i++) {
  await Bun.sleep(50);
}
/* Identity-checked readiness (#273/#516, same rule as e2e/helpers/stack.ts):
   a bare `fetch /` accepts whatever already holds the port — a foreign
   relay's stand-in answers it too, and the harness then dies on a WebSocket
   upgrade to a plain-HTTP endpoint. Require /healthz to serve OUR relay's
   own instanceId (parsed from its stdout above). A foreign answer is not an
   instant fail — the holder may be draining while our relay's bind-retry
   races the same port — but it is remembered so a boot that never lands
   names the port and both ids (the exited handler does the same). Bound
   each poll: a half-dead predecessor can hold the port bound but
   unanswering, and an unbounded fetch hangs this boot (#84). */
const relayDeadline = Date.now() + 25_000;
/* #825: port 0 is "bind whatever the kernel assigns". The listening line
   carries that port; probing :0 is not a server. A concrete port (the dev
   default, or a spec that pinned one) is unchanged. */
let relayPort = RELAY_PORT;
if (relayPort === 0) {
  try {
    relayPort = await reportedPort(
      "relay",
      () => relayBuf,
      relayProc,
      Math.max(relayDeadline - Date.now(), 1),
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    await shutdown(1);
    throw err;
  }
}
while (!relayUp) {
  const seen = await fetch(`http://127.0.0.1:${relayPort}/healthz`, {
    signal: AbortSignal.timeout(1_000),
  })
    .then((r) => r.json())
    .then((j) => {
      const id = (j as { instanceId?: unknown }).instanceId;
      return typeof id === "string" ? id : `<HTTP ${r.status}, no instanceId>`;
    })
    .catch(() => undefined);
  if (seen !== undefined && seen === relayInstance) {
    relayUp = true;
    break;
  }
  if (seen !== undefined) foreign = seen;
  if (Date.now() > relayDeadline) {
    console.error(
      `[stack] relay never claimed port ${relayPort} ` +
        `(ours ${relayInstance ?? "never logged"}` +
        (foreign !== undefined ? `, /healthz answers ${foreign}` : "") +
        `)`,
    );
    await shutdown(1);
  }
  await Bun.sleep(100);
}
const token = existsSync(tokenPath)
  ? readFileSync(tokenPath, "utf8").trim()
  : "";
if (!token) {
  console.error("[stack] relay did not write its token file");
  await shutdown(1);
}
console.log(`[stack] relay ready on :${relayPort} (home ${HOME})`);

// The harness launches engine-fake itself (LILOS_ENGINE=fake by default);
// LILOS_ENGINE=url + LILOS_ENGINE_URL points it at an external engine.
// Engine-fake already binds `--port 0` and prints `LISTENING ws://…`
// (#825); the harness launcher reads that line. Nothing here picks it.
const harnessEnv: Record<string, string> = {
  LILOS_RELAY_URL: `ws://127.0.0.1:${relayPort}/ws`,
  LILOS_RELAY_HOME: HOME,
  LILOS_RELAY_TOKEN: token,
  LILOS_HARNESS_HOME: HARNESS_HOME,
  LILOS_REPO_ROOT: repo,
  /* No LILOS_WORKDIR: #412 defaults no-folder sessions to the user's home —
     the shipped behavior. e2e pins its own scratch workdir instead. */
  LILOS_FEED_PORT: String(FEED_PORT),
};
if (!process.env.LILOS_ENGINE) harnessEnv.LILOS_ENGINE = "fake";
const harness = spawnCaptured(
  "harness",
  ["bun", "run", "apps/harness/src/index.ts"],
  harnessEnv,
);

// The old poll was 300 × 100ms. Port discovery shares that budget so a
// child that never reports fails in the same window, not a longer one.
const feedDeadline = Date.now() + 30_000;
let feedPort = FEED_PORT;
if (feedPort === 0) {
  try {
    feedPort = await reportedPort(
      "harness",
      harness.text,
      harness.proc,
      Math.max(feedDeadline - Date.now(), 1),
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    await shutdown(1);
    throw err;
  }
}
let feedUp = false;
while (!feedUp) {
  feedUp = await fetch(`http://127.0.0.1:${feedPort}/`, {
    signal: AbortSignal.timeout(1_000),
  })
    .then((r) => r.ok)
    .catch(() => false);
  if (!feedUp) {
    if (Date.now() > feedDeadline) break;
    await Bun.sleep(100);
  }
}
if (!feedUp) {
  console.error(
    `[stack] harness feed never answered HTTP on :${feedPort}` +
      (FEED_PORT === 0 ? " (the listening line was received)" : ""),
  );
  await shutdown(1);
}

/* #825: Vite 8.3.4 does not honour `server.port: 0` (it probes, closes,
   then rebinds). The port has to be known first. A worker slice port is
   probed here; if something already holds it, this throws and vite is
   not spawned. A shutdown that started during the probe (a sibling
   already died, or SIGTERM) must not continue into the spawn either.
   `bun run dev` passes 5200 and does not come through here. */
let webPort = WEB_PORT;
if (webPort === 0) {
  try {
    webPort = await requireSlicePort("web");
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    await shutdown(1);
    throw err;
  }
}
if (shuttingDown) await shuttingDown;
else {
  const web = spawnCaptured(
    "web",
    [
      path.join(webDir, "node_modules", ".bin", "vite"),
      "--host",
      "127.0.0.1",
      "--port",
      String(webPort),
      "--strictPort",
    ],
    {
      LILOS_RELAY_WS: `ws://127.0.0.1:${relayPort}/ws`,
      LILOS_RELAY_TOKEN: token,
      LILOS_ENGINE_WS: `ws://127.0.0.1:${feedPort}/ws`,
      LILOS_WEB_PORT: String(webPort),
    },
    webDir,
  );
  if (WEB_PORT === 0) {
    try {
      const bound = await reportedPort("web", web.text, web.proc, 60_000);
      if (bound !== webPort) {
        throw new Error(
          `[stack] vite bound :${bound}, not the slice port :${webPort}`,
        );
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      await shutdown(1);
      throw err;
    }
  }

  console.log(`
LilOS dev stack
  web     http://localhost:${webPort}
  relay   ws://127.0.0.1:${relayPort}/ws   (state: ${HOME})
  feed    ws://127.0.0.1:${feedPort}/ws   (harness; engine ${
    process.env.LILOS_ENGINE ?? "fake"
  })
`);

  // The stack is only alive while every child is: a dead vite (e.g. its
  // --strictPort was still held by the previous stack's draining child)
  // otherwise leaves an umbrella that serves nothing and hangs callers
  // waiting for the web URL (#84).
  await Promise.race(kids.map((k) => k.exited));
  await shutdown(1);
}
