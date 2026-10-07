/**
 * Shared e2e stack helpers (#273): one `bootStack` for every spec that runs
 * the dev slice (relay + harness + vite via `bun run dev` in apps/web), plus
 * the small primitives component-level specs spawn by hand.
 *
 * Readiness is identity-checked, not just "something answers": the probe
 * reads the spawned process's own stdout for `[relay] instanceId:` /
 * `[harness] instanceId:` and polls `/healthz` until it returns that same
 * id. A different id — a foreign stack holding the port — is a hard boot
 * failure naming the port and both ids, instead of the spec quietly riding
 * the other file's stack (#256/#272).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as playwright from "@playwright/test";
import { engineTag, expectNoEngineLeak } from "../engine-leak";

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
  ports: StackPorts;
  relayWs: string;
  feedWs: string;
  relayToken: string;
  /** The `bun run dev` umbrella process (detached group leader). */
  proc: ChildProcess;
  /** LILOS_ENGINE_TAG the stack's engine-fake carries — for leak checks. */
  leakTag: string;
  /** Everything the stack printed so far (stdout + stderr). */
  log: () => string;
  /** The harness's own log file (empty until it writes). */
  harnessLog: () => string;
  stop: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* `bun run dev` stacks shim layers between `proc` and the real stack
   children, and bun doesn't forward signals through them — signal the
   whole process group (the spawn is `detached`) or the stack orphans and
   keeps its ports bound, poisoning the next boot (#84). */
export function killProc(proc: ChildProcess): Promise<void> {
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
    /* Already exited — 'exit' won't fire again and waiting the full timeout
       just stalls every dead-stack cleanup (#516: a stack that refuses a
       foreign port self-terminates before bootStack's catch runs). Still
       sweep the group: a dead leader can leave bound-port children behind,
       and a wedged one gets the same SIGKILL backstop — just unblocking. */
    if (proc.exitCode !== null || proc.signalCode !== null) {
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 8_000).unref();
      resolve();
      return;
    }
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

/**
 * Everything the child printed (stdout + stderr merged), tee'd to this
 * process's own streams so spec logs keep the stack output. Attach right
 * after spawn — the identity probe greps this buffer for `[<kind>]
 * instanceId:` and error paths print its tail.
 */
export function captureProc(proc: ChildProcess): () => string {
  let buf = "";
  const push = (chunk: unknown, err = false) => {
    const s = String(chunk);
    buf += s;
    if (buf.length > 300_000) buf = buf.slice(-150_000);
    (err ? process.stderr : process.stdout).write(s);
  };
  proc.stdout?.on("data", (d) => push(d));
  proc.stderr?.on("data", (d) => push(d, true));
  return () => buf;
}

/** Any HTTP answer = the server is listening; `proc` exit short-circuits the
    wait when the stack died instead of serving. */
export async function waitForHttp(
  url: string,
  ms = 30_000,
  proc?: ChildProcess,
): Promise<void> {
  const start = Date.now();
  let last = "unreachable";
  for (;;) {
    if (proc && proc.exitCode !== null)
      throw new Error(`stack exited ${proc.exitCode}: last=${last}`);
    try {
      const r = await fetch(url);
      if (r.status > 0) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = String(e);
    }
    if (Date.now() - start > ms)
      throw new Error(`timed out waiting for ${url}: ${last}`);
    await sleep(200);
  }
}

/** Waits for the stack's relay token to land so clients can authenticate. */
export async function waitForToken(home: string): Promise<string> {
  const tokenPath = path.join(home, "relay-token");
  for (let i = 0; i < 300; i++) {
    try {
      const t = readFileSync(tokenPath, "utf8").trim();
      if (t) return t;
    } catch {}
    await sleep(100);
  }
  throw new Error(`relay token never appeared at ${tokenPath}`);
}

/** This Playwright worker's index (stable per process) — specs use it for
    per-worker dirs (vite caches) that must not clobber a sibling worker's
    running optimizer (#84). */
export const WORKER = Number(process.env.TEST_WORKER_INDEX ?? "0");

/* #689: pick BELOW the kernel's ephemeral range, not out of it. `listen(0)`
   draws from that range — and so does every `bind(0)` listener (engine-fake
   launches on `--port 0`) and every outbound connect() source port, so a
   probed-free ephemeral port can be re-issued to another child in the
   release→bind gap (ac-659 repeat 18: engine-fake took the web port, vite
   died EADDRINUSE, `page.goto` landed on engine-fake's 404 page and the
   aside wait timed out). The allocator never hands out ports below its
   floor — Linux `ip_local_port_range` starts at 32768, macOS/Windows at
   49152 — so a picked port in this band stays free until our child binds
   it. A pick-vs-pick race is still possible, but it needs another caller
   choosing the same port in the same instant. */
const PICK_PORT_LO = 20_000;
const PICK_PORT_HI = 32_767;
const PICK_PORT_TRIES = 100;

export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    let tries = 0;
    const attempt = () => {
      if (++tries > PICK_PORT_TRIES) {
        reject(
          new Error(
            `no free port in ${PICK_PORT_LO}-${PICK_PORT_HI} after ${PICK_PORT_TRIES} tries`,
          ),
        );
        return;
      }
      const port =
        PICK_PORT_LO +
        Math.floor(Math.random() * (PICK_PORT_HI - PICK_PORT_LO + 1));
      const srv = createServer();
      srv.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE") attempt();
        else reject(e);
      });
      srv.listen(port, "127.0.0.1", () => {
        srv.close(() => resolve(port));
      });
    };
    attempt();
  });

/** Three distinct free ports — repeat/parallel runs must never collide. */
export async function pickPorts(): Promise<StackPorts> {
  for (;;) {
    const [relay, feed, web] = await Promise.all([
      freePort(),
      freePort(),
      freePort(),
    ]);
    if (new Set([relay, feed, web]).size === 3) return { relay, feed, web };
  }
}

const INSTANCE_RE = (kind: string) =>
  new RegExp(`\\[${kind}\\] instanceId: ([0-9a-fA-F-]{36})`);

/** What answered `<port>/healthz`: the instanceId it serves, or a marker for
    an answer that isn't one of ours at all. `undefined` = nothing answered. */
async function healthzId(port: number): Promise<string | undefined> {
  const r = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(1_000),
  }).catch(() => undefined);
  if (!r) return undefined;
  const id = await r
    .json()
    .then((j) => (j as { instanceId?: unknown }).instanceId)
    .catch(() => undefined);
  return typeof id === "string" ? id : `<HTTP ${r.status}, no instanceId>`;
}

/**
 * Identity-checked readiness (#273): poll `<port>/healthz` until it returns
 * the instanceId OUR spawned process logged on its own stdout. An answer
 * carrying a different id — or any answer that isn't an instanceId — means
 * a foreign stack holds the port: fail at once naming the port and both
 * ids. An answer seen before our id was logged is held for comparison once
 * the line lands (pipe delivery can lag a real bind by a tick).
 */
export async function waitForInstance(
  kind: "relay" | "harness",
  port: number,
  proc: ChildProcess,
  out: () => string,
  ms = 60_000,
  opts: { holdOursMs?: number } = {},
): Promise<string> {
  const start = Date.now();
  /* #516 repro knob: the spawned child's `instanceId` line can arrive late
     or never — a relay frozen in Bun.sleepSync dies with its stdout
     undelivered. `holdOursMs` withholds the line from the live probe for
     that long, modelling the window where the stack exits before the
     identity probe has named both ids. The post-exit re-parse below always
     sees whatever the child actually managed to emit. */
  const holdOursUntil = start + (opts.holdOursMs ?? 0);
  const oursLogged = () => INSTANCE_RE(kind).exec(out())?.[1];
  let ours: string | undefined;
  let foreign: string | undefined;
  for (;;) {
    if (!ours && Date.now() >= holdOursUntil) ours = oursLogged();
    const seen = await healthzId(port);
    if (seen !== undefined) {
      if (ours && seen === ours) return ours;
      if (ours)
        throw new Error(
          `port ${port} answers /healthz, but it is not the ${kind} this spec started (ours ${ours}, theirs ${seen})`,
        );
      foreign = seen;
    }
    if (proc.exitCode !== null || proc.signalCode !== null) {
      /* The stack died — but the identity question still stands (#516):
         drain the last output ('close' lands after 'exit', so buffered
         stdout can still be in flight), then probe /healthz one final
         time. A port answering with a different id is the primary error;
         "process exited" is only the fallback when nothing answers. */
      await Promise.race([once(proc, "close").catch(() => {}), sleep(300)]);
      ours ??= oursLogged();
      const them = (await healthzId(port)) ?? foreign;
      if (them !== undefined && them !== ours)
        throw new Error(
          `port ${port} answers /healthz, but it is not the ${kind} this ` +
            `spec started (ours ${ours ?? "never logged"}, theirs ${them}) ` +
            `— the ${kind} stack exited (code ${proc.exitCode ?? proc.signalCode}) first`,
        );
      throw new Error(
        `${kind} stack exited (code ${proc.exitCode ?? proc.signalCode}) before port ${port} was ours` +
          (them !== undefined ? ` — /healthz still answers ${them}` : "") +
          (ours !== undefined ? ` (ours ${ours})` : "") +
          ` — last output:\n${out().slice(-1200)}`,
      );
    }
    if (Date.now() - start > ms)
      throw new Error(
        `timed out waiting for ${kind} on port ${port}` +
          (foreign
            ? ` — it answers /healthz with ${foreign}, but our ${kind} never logged its instanceId`
            : " — nothing answers /healthz"),
      );
    await sleep(150);
  }
}

/** `waitForInstance` for a spec's own relay child (ac-28/130/138 style). */
export const waitForRelay = (
  port: number,
  proc: ChildProcess,
  out: () => string,
  ms?: number,
) => waitForInstance("relay", port, proc, out, ms);

/** `waitForInstance` for a spec's own harness child (ac-28/130/138 style). */
export const waitForFeed = (
  port: number,
  proc: ChildProcess,
  out: () => string,
  ms?: number,
) => waitForInstance("harness", port, proc, out, ms);

/** Boot `bun run dev` (relay + harness + vite dev) on the given ports.
    `opts.home` reuses a LILOS_HOME — a restart on the same relay state
    (ac-92's persistence leg). */
export async function bootStack(
  tag: string,
  ports: StackPorts,
  extraEnv: Record<string, string> = {},
  opts: { home?: string; holdOursMs?: number } = {},
): Promise<Stack> {
  const home =
    opts.home ?? mkdtempSync(path.join(tmpdir(), `lilos-e2e-${tag}-`));
  const leakTag = engineTag(tag);
  const proc = spawn("bun", ["run", "dev"], {
    cwd: webDir,
    detached: true,
    env: {
      ...process.env,
      LILOS_HOME: home,
      /* #412: the shipped default sends no-folder sessions to the user's
         home — a spec must never work there, so the scratch home pins a
         workdir explicitly. */
      LILOS_WORKDIR: path.join(home, "work"),
      LILOS_ENGINE_TAG: leakTag,
      LILOS_RELAY_PORT: String(ports.relay),
      LILOS_FEED_PORT: String(ports.feed),
      LILOS_WEB_PORT: String(ports.web),
      ...extraEnv,
    },
    /* Piped, not inherited: the readiness probe reads `[relay] instanceId`
       off this stream — captureProc tees it back to the spec's console. */
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = captureProc(proc);
  const webUrl = `http://127.0.0.1:${ports.web}`;
  try {
    /* Identity before web: a foreign relay/harness fails in ~a second
       instead of after vite's whole boot. Vite can't carry identity, but
       its --strictPort dies on a held port and the umbrella exits — the
       proc-exit check catches that. */
    await waitForInstance("relay", ports.relay, proc, log, 60_000, {
      holdOursMs: opts.holdOursMs,
    });
    await waitForInstance("harness", ports.feed, proc, log);
    await waitForHttp(webUrl, 60_000, proc);
    const relayToken = await waitForToken(home);
    return {
      home,
      webUrl,
      ports,
      relayWs: `ws://127.0.0.1:${ports.relay}/ws`,
      feedWs: `ws://127.0.0.1:${ports.feed}/ws`,
      relayToken,
      proc,
      leakTag,
      log,
      harnessLog: () => {
        try {
          return readFileSync(
            path.join(home, "harness", "harness.log"),
            "utf8",
          );
        } catch {
          return "";
        }
      },
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

/**
 * #577 navigation helper: a send lands on the DM list with the thread open
 * in the side panel (`/dm/:e/:c`); Focus opens only from the panel's ↗
 * button. Specs that need Focus after a send call this — it waits for the
 * panel URL, clicks Focus, and waits for the Focus URL.
 */
export async function panelIntoFocus(
  page: import("@playwright/test").Page,
  focusUrl: RegExp = /\/dm\/[^/]+\/[^/]+\/focus$/,
): Promise<void> {
  const { expect } = playwright;
  await expect(page).toHaveURL(/\/dm\/[^/]+\/[^/]+$/, { timeout: 30_000 });
  // The URL lands before the panel mounts (the conv resolves async under
  // load) — wait for the surface, then the button.
  await expect(page.locator("[data-thread-panel]")).toBeVisible({
    timeout: 30_000,
  });
  await page
    .locator("[data-thread-panel]")
    .getByTitle("Focus", { exact: true })
    .click({ timeout: 15_000 });
  await expect(page).toHaveURL(focusUrl, { timeout: 30_000 });
}
