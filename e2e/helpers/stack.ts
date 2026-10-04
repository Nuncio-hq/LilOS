import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { engineTag, expectNoEngineLeak } from "../engine-leak";

/**
 * Shared e2e stack boot (#273): `bun run dev` on a caller-picked port
 * triple, with identity-checked readiness — ready means OUR stack answered,
 * not whatever happens to hold the port on a shared Mac.
 *
 * The spawned tree's own output carries the identity, so a foreign process
 * can never pass for ours:
 * - `[relay] instanceId: <uuid>` is logged by the relay we spawned, after it
 *   binds — `/healthz` must then report that same id (a stale foreign relay
 *   on our port answers with a different one and fails fast, naming both).
 * - `harness up {…}` is logged by OUR harness to stderr with the relay URL
 *   and feed port it bound; only then is the feed socket probed.
 * - vite runs --strictPort: a held web port kills the child, which exits the
 *   umbrella — surfaced as a boot failure naming the port, not a timeout.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // e2e/helpers
const repo = path.resolve(here, "../..");
const webDir = path.join(repo, "apps", "web");

export interface StackPorts {
  relay: number;
  feed: number;
  web: number;
}

export interface Stack {
  home: string;
  webUrl: string;
  relayWs: string;
  feedWs: string;
  relayToken: string;
  relayInstanceId: string;
  stop: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function killProc(proc: ChildProcess): Promise<void> {
  // `bun run dev` stacks intermediate shim layers between `proc` and the
  // real dev-stack children, and bun doesn't forward signals through them —
  // signal the whole process group (the spawn is `detached`) or the stack
  // orphans and keeps its ports bound, poisoning the next boot (#84).
  const killGroup = (sig: "SIGTERM" | "SIGKILL") => {
    try {
      if (proc.pid) process.kill(-proc.pid, sig);
    } catch {
      try {
        proc.kill(sig);
      } catch {}
    }
  };
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      killGroup("SIGKILL");
      resolve();
    }, 8_000);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    killGroup("SIGTERM");
  });
}

/** One poll step that also fails fast if the spawned stack died. */
async function waitFor(
  what: string,
  ready: () => Promise<boolean>,
  dead: () => string | null,
  ms = 30_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const why = dead();
    if (why) throw new Error(`stack died while waiting for ${what}: ${why}`);
    if (await ready()) return;
    if (Date.now() - start > ms)
      throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

/** Boot `bun run dev` (relay + harness/engine-fake + vite dev) on `ports`. */
export async function bootStack(
  tag: string,
  ports: StackPorts,
  extraEnv: Record<string, string> = {},
): Promise<Stack> {
  const home = mkdtempSync(path.join(tmpdir(), `lilos-e2e-${tag}-`));
  const leakTag = engineTag(tag);
  const proc = spawn("bun", ["run", "dev"], {
    cwd: webDir,
    detached: true,
    env: {
      ...process.env,
      LILOS_HOME: home,
      LILOS_ENGINE_TAG: leakTag,
      LILOS_RELAY_PORT: String(ports.relay),
      LILOS_FEED_PORT: String(ports.feed),
      LILOS_WEB_PORT: String(ports.web),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  /* The children inherit the umbrella's stdio: relay logs on stdout,
     harness's file logger mirrors to stderr. Both pipes are scanned for the
     identity lines and kept as a tail for failure messages. */
  const tail: string[] = [];
  let relayInstanceId = "";
  let harnessUp = false;
  const feedWs = `ws://127.0.0.1:${ports.feed}/ws`;
  const relayWs = `ws://127.0.0.1:${ports.relay}/ws`;
  const scan = (line: string) => {
    tail.push(line);
    if (tail.length > 80) tail.shift();
    const id = /\[relay\] instanceId: (\S+)/.exec(line)?.[1];
    if (id) relayInstanceId = id;
    if (
      line.includes("harness up") &&
      line.includes(`"feed":"${feedWs}"`) &&
      line.includes(`"relay":"${relayWs}"`)
    )
      harnessUp = true;
  };
  const onData = (stream: NodeJS.ReadableStream | null) => {
    let buf = "";
    stream?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) scan(line);
    });
  };
  onData(proc.stdout);
  onData(proc.stderr);
  let exitWhy: string | null = null;
  proc.once("exit", (code, sig) => {
    exitWhy = `bun run dev exited (${sig ?? `code ${code}`})`;
  });
  const dead = () =>
    exitWhy ? `${exitWhy}\n--- stack tail ---\n${tail.join("\n")}` : null;
  const webUrl = `http://127.0.0.1:${ports.web}`;
  try {
    // 1. Our relay must announce itself; only then may its port answer.
    await waitFor(
      `relay instanceId on :${ports.relay}`,
      async () => relayInstanceId !== "",
      dead,
    );
    await waitFor(
      `relay /healthz on :${ports.relay} (expecting ${relayInstanceId})`,
      async () => {
        const r = await fetch(`http://127.0.0.1:${ports.relay}/healthz`, {
          signal: AbortSignal.timeout(2_000),
        }).catch(() => null);
        if (!r?.ok) return false;
        const body = (await r.json().catch(() => null)) as {
          instanceId?: string;
        } | null;
        if (body?.instanceId && body.instanceId !== relayInstanceId)
          throw new Error(
            `port ${ports.relay} serves a foreign relay ` +
              `(${body.instanceId} != spawned ${relayInstanceId})`,
          );
        return body?.instanceId === relayInstanceId;
      },
      dead,
    );
    // 2. OUR harness logged its bind of OUR feed port against OUR relay.
    await waitFor(`harness feed ${feedWs}`, async () => harnessUp, dead);
    await waitFor(
      `feed socket on :${ports.feed}`,
      async () =>
        fetch(`http://127.0.0.1:${ports.feed}/`, {
          signal: AbortSignal.timeout(2_000),
        })
          .then((r) => r.ok)
          .catch(() => false),
      dead,
    );
    // 3. vite dev (--strictPort; a foreign holder exits the umbrella above).
    await waitFor(
      `web on :${ports.web}`,
      async () =>
        fetch(webUrl, { signal: AbortSignal.timeout(2_000) })
          .then((r) => r.ok)
          .catch(() => false),
      dead,
    );
    const tokenPath = path.join(home, "relay-token");
    let relayToken = "";
    await waitFor(
      `relay token at ${tokenPath}`,
      async () => {
        try {
          relayToken = readFileSync(tokenPath, "utf8").trim();
        } catch {}
        return relayToken !== "";
      },
      dead,
    );
    return {
      home,
      webUrl,
      relayWs,
      feedWs,
      relayToken,
      relayInstanceId,
      stop: async () => {
        await killProc(proc);
        await expectNoEngineLeak(leakTag);
      },
    };
  } catch (e) {
    // Group kill: `bun run dev` spawns detached — killing only the shim
    // orphans stack.ts + relay + harness + vite and poisons the next boot.
    await killProc(proc);
    throw e;
  }
}
