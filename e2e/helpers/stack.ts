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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as playwright from "@playwright/test";
import {
  type ListeningKind,
  PORT_SLICE,
  parseListeningPort,
  probeFreePort,
  requireSlicePort,
  type SliceUse,
  workerIndex,
} from "../../apps/web/dev/ready";
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
  /** `keepHome`: a restart leg reuses this LILOS_HOME for its next
      bootStack (`opts.home`) — the stop must not drop it. */
  stop: (opts?: { keepHome?: boolean }) => Promise<void>;
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

const WARM_WIDTH = 8;
const WARM_URL_CAP = 4_000;
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
const CSS_URL_RE =
  /@import\s+(?:url\(\s*)?["']([^"']+)["']|url\(\s*["']?([^"')\s]+)["']?\s*\)/g;
const HTML_REF_RE =
  /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi;

/** Same-origin URL `raw` resolved against `base`. External, data, and
    blob URLs are not this dev server's graph. A bare specifier
    (`react`, or a word inside a comment) is not a live import either:
    Vite rewrites those to `/src/…`, `/@fs/…`, or a dep url before the
    response is sent. Requesting the bare word makes the optimizer look
    for a dep file that was never written. */
function warmUrl(raw: string, base: string, origin: string): string | null {
  if (
    !raw ||
    raw.startsWith("data:") ||
    raw.startsWith("blob:") ||
    raw.startsWith("#") ||
    (!raw.startsWith(".") &&
      !raw.startsWith("/") &&
      !raw.startsWith("http:") &&
      !raw.startsWith("https:"))
  )
    return null;
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  url.hash = "";
  return url.href;
}

/**
 * #827: `waitForHttp` returns on the HTML document. Vite serves that
 * before it has transformed a module. The browser's `load` event waits
 * for the static graph (measured ~250 requests, ~17MB). ac-115 AC-1 has
 * no `test.setTimeout`, so that compile ran inside the default 30s and
 * on a busy Mac the first `page.goto` ("waiting until load") exceeded
 * it. `server.warmup` does not close the gap: an HTML warmup only calls
 * `transformIndexHtml`, and `preTransformRequests` fires `warmupRequest`
 * on static imports without awaiting them. One fetch of `main.tsx`
 * returns while the rest of the graph is still compiling.
 *
 * Crawl the transformed URLs here, inside the boot's existing web
 * budget, so the spec's `page.goto` is a warm load. Each vite process
 * has its own in-memory transform cache — a suite-wide prebuild does
 * not warm the next stack. The dep-optimizer cache is per worker
 * (`LILOS_VITE_CACHE_DIR` in vite.config.ts) so parallel boots don't
 * re-bundle one `node_modules/.vite` and full-reload each other (#84).
 *
 * A 504 is Vite's "outdated optimized dep" while the first optimize is
 * still writing; retry it until the budget ends. Any other non-OK
 * response is a URL the graph mentioned and the server refused — skip
 * it, the browser's load event would too.
 */
export async function warmDevClient(
  webUrl: string,
  ms = 60_000,
  proc?: ChildProcess,
): Promise<void> {
  const origin = new URL(webUrl).origin;
  const deadline = Date.now() + ms;
  const seen = new Set<string>();
  const queue: string[] = [];
  const enqueue = (raw: string, base: string) => {
    const href = warmUrl(raw, base, origin);
    if (!href || seen.has(href)) return;
    if (seen.size >= WARM_URL_CAP) {
      throw new Error(
        `warm of ${webUrl} followed more than ${WARM_URL_CAP} urls`,
      );
    }
    seen.add(href);
    queue.push(href);
  };
  enqueue(`${origin}/`, `${origin}/`);

  const timedOut = () => Date.now() > deadline;
  const pull = async (url: string): Promise<void> => {
    let res: Response | undefined;
    while (!timedOut()) {
      if (proc && proc.exitCode !== null) {
        throw new Error(
          `stack exited ${proc.exitCode} while warming ${webUrl}`,
        );
      }
      try {
        // A stalled transform must not outlive the deadline.
        res = await fetch(url, {
          signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)),
        });
      } catch {
        res = undefined;
      }
      if (res && res.status !== 504 && res.status !== 408) break;
      await sleep(50);
    }
    if (!res || res.status === 504 || res.status === 408) {
      throw new Error(`timed out warming ${webUrl} at ${url}`);
    }
    if (!res.ok) return;
    const text = await res.text();
    const ct = res.headers.get("content-type") ?? "";
    const html =
      ct.includes("html") || url === `${origin}/` || /\.html(?:$|\?)/.test(url);
    if (html) {
      for (const m of text.matchAll(HTML_REF_RE)) enqueue(m[1] ?? "", url);
      return;
    }
    for (const m of text.matchAll(IMPORT_RE)) enqueue(m[1] ?? "", url);
    if (ct.includes("css") || url.includes(".css")) {
      for (const m of text.matchAll(CSS_URL_RE))
        enqueue(m[1] ?? m[2] ?? "", url);
    }
  };

  while (queue.length) {
    if (timedOut()) {
      throw new Error(
        `timed out warming ${webUrl} (${seen.size} urls, ${queue.length} left)`,
      );
    }
    await Promise.all(queue.splice(0, WARM_WIDTH).map(pull));
  }
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

/* #689: a probe stays under the slice and under the ephemeral floor.
   `listen(0)` draws from that floor — engine-fake launches on `--port 0`
   — so a probed-free ephemeral port can be re-issued before the real
   bind (ac-659 repeat 18). The band is `PORT_SLICE.probeLo`–`probeHi`.
   Vite and a restart-on-the-same-port spec do not use this; they take
   a slice port (#825). */
export const freePort = (): Promise<number> => probeFreePort();

/**
 * Ports for `bootStack`. `0` means "do not choose". The child binds port 0
 * and prints the port it actually bound; `bootStack` reads that line.
 * Vite is the exception: it cannot bind 0, so `bootStack` fills `web`
 * from this worker's slice before spawn. Choosing a free ephemeral port
 * here and handing the number over was the race: two workers can both
 * observe the same port free after the probe closes, and one spec then
 * talks to the other's server (#825).
 */
export function pickPorts(): Promise<StackPorts> {
  return Promise.resolve({ relay: 0, feed: 0, web: 0 });
}

/**
 * Relay, feed, and web for a spec that rebinds those ports while the
 * page still holds the addresses (ac-28, ac-130, ac-557). Each number
 * is that worker's slice port. A holder fails the boot by name.
 */
export async function slicePorts(): Promise<StackPorts> {
  const [relay, feed, web] = await Promise.all([
    requireSlicePort("relay"),
    requireSlicePort("feed"),
    requireSlicePort("web"),
  ]);
  return { relay, feed, web };
}

/* One worker can boot more than one stack. Each live vite takes the
   next name in `PORT_SLICE.viteSlots`. The name is checked out before
   the probe, and a held port is not replaced with the next name. */
const takenVite = new Set<SliceUse>();
const takeViteUse = (): SliceUse => {
  const use = PORT_SLICE.viteSlots.find((slot) => !takenVite.has(slot));
  if (!use) {
    throw new Error(
      `this worker already has ${PORT_SLICE.viteSlots.length} vite servers (${PORT_SLICE.viteSlots.join(", ")})`,
    );
  }
  takenVite.add(use);
  return use;
};
const releaseViteUse = (use: SliceUse) => {
  takenVite.delete(use);
};

/** The port a child printed. Fails on process exit or when `ms` runs out,
    with the tail of its output — never a hang. Discovery shares the
    caller's existing budget; it does not add one. */
export async function waitForListeningPort(
  kind: ListeningKind,
  proc: ChildProcess,
  out: () => string,
  ms: number,
): Promise<number> {
  const start = Date.now();
  for (;;) {
    const port = parseListeningPort(out(), kind);
    if (port) return port;
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `${kind} exited (${proc.exitCode ?? proc.signalCode}) before reporting its port\n${out().slice(-1200)}`,
      );
    }
    if (Date.now() - start > ms)
      throw new Error(
        `timed out waiting for ${kind} to report its port\n${out().slice(-1200)}`,
      );
    await sleep(50);
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
  /* Vite cannot bind 0. Inside a runner the port is this worker's next
     vite slot, passed in as a concrete number so two stacks in one
     worker do not both ask the child for `web`. Outside a runner the
     child would probe; do that here so the URL we wait on is the one
     vite was given. */
  let viteUse: SliceUse | undefined;
  if (ports.web === 0) {
    if (workerIndex() === undefined) {
      ports = { ...ports, web: await probeFreePort() };
    } else {
      const use = takeViteUse();
      try {
        ports = { ...ports, web: await requireSlicePort(use) };
        viteUse = use;
      } catch (err) {
        releaseViteUse(use);
        throw err;
      }
    }
  }
  const releaseVite = () => {
    if (!viteUse) return;
    releaseViteUse(viteUse);
    viteUse = undefined;
  };
  /* An `opts.home` is the caller's reused LILOS_HOME (ac-92's restart
     leg) — only a home this boot mkdtemp'd is ours to remove at stop
     (r10: ~100 stacks per shard used to leave their scratch dirs —
     and any provisioned adapter caches — behind on the runner). */
  const ownsHome = opts.home === undefined;
  const home =
    opts.home ?? mkdtempSync(path.join(tmpdir(), `lilos-e2e-${tag}-`));
  const dropHome = () => {
    if (ownsHome) rmSync(home, { recursive: true, force: true });
  };
  const leakTag = engineTag(tag);
  let spawned: ChildProcess | undefined;
  try {
    const proc = spawn("bun", ["run", "dev"], {
      cwd: webDir,
      detached: true,
      env: {
        ...process.env,
        /* D-#866 r6: the ACP provision cache resolves under HOME (the
           spawned engine child is LILOS_*-scrubbed, so LILOS_ACP_CACHE
           never reaches it). Isolating HOME keeps a spec's first-use
           install out of the real ~/.lilos/acp entirely. */
        HOME: home,
        LILOS_HOME: home,
        /* D-#866 r10: e2e never fetches from npm. Each stack gets a
           scratch HOME, so a per-stack provisioned adapter would mean
           ~100 copies of the npm tree per shard — the EDQUOT run.
           With provisioning off, acp:* rows report "provisioning
           disabled in tests"; the engine-fake covers the specs. */
        LILOS_ACP_PROVISION: "0",
        /* #412: the shipped default sends no-folder sessions to the user's
           home — a spec must never work there, so the scratch home pins a
           workdir explicitly. */
        LILOS_WORKDIR: path.join(home, "work"),
        LILOS_ENGINE_TAG: leakTag,
        LILOS_RELAY_PORT: String(ports.relay),
        LILOS_FEED_PORT: String(ports.feed),
        LILOS_WEB_PORT: String(ports.web),
        /* #827 / #84: one optimizer cache per worker. Two stacks in this
           worker share it, booted one after another, so the second finds
           deps already written. A sibling worker never rewrites it. */
        LILOS_VITE_CACHE_DIR: `node_modules/.vite-e2e-w${workerIndex() ?? WORKER}`,
        /* D-#836: the product's no-env default pauses the company layer,
           but the suite was written against it — sidebar agent rows are
           the shared "shell is up" wait. Stacks boot with the layer ON;
           a paused spec passes `LILOS_COMPANY: "0"` in extraEnv. */
        LILOS_COMPANY: "1",
        ...extraEnv,
      },
      /* Piped, not inherited: the readiness probe reads `[relay] instanceId`
         off this stream — captureProc tees it back to the spec's console. */
      stdio: ["ignore", "pipe", "pipe"],
    });
    spawned = proc;
    const log = captureProc(proc);
    /* Identity before web: a foreign relay/harness fails in ~a second
       instead of after vite's whole boot. Vite can't carry identity, but
       its --strictPort dies on a held port and the umbrella exits — the
       proc-exit check catches that.
       Port 0 is discovered from the child's ready line inside the same
       60s the identity/HTTP wait already had (#825). A concrete port keeps
       the full budget and is NOT gated on the line: a relay that can never
       bind (a foreign stand-in holds it, #273) still has to fail the
       identity check, and it may never print a listening line. */
    const relayBudget = 60_000;
    const relayStart = Date.now();
    const relayPort =
      ports.relay === 0
        ? await waitForListeningPort("relay", proc, log, relayBudget)
        : ports.relay;
    await waitForInstance(
      "relay",
      relayPort,
      proc,
      log,
      ports.relay === 0
        ? Math.max(relayBudget - (Date.now() - relayStart), 1)
        : relayBudget,
      { holdOursMs: opts.holdOursMs },
    );
    const feedBudget = 60_000;
    const feedStart = Date.now();
    const feedPort =
      ports.feed === 0
        ? await waitForListeningPort("harness", proc, log, feedBudget)
        : ports.feed;
    await waitForInstance(
      "harness",
      feedPort,
      proc,
      log,
      ports.feed === 0
        ? Math.max(feedBudget - (Date.now() - feedStart), 1)
        : feedBudget,
    );
    const webBudget = 60_000;
    const webStart = Date.now();
    const webPort =
      ports.web === 0
        ? await waitForListeningPort("web", proc, log, webBudget)
        : ports.web;
    const webUrl = `http://127.0.0.1:${webPort}`;
    await waitForHttp(
      webUrl,
      ports.web === 0
        ? Math.max(webBudget - (Date.now() - webStart), 1)
        : webBudget,
      proc,
    );
    /* The listening answer is the HTML shell. Pay the module compile
       before returning, on the same 60s the HTTP wait already had —
       otherwise the spec's first page.goto holds it (#827). */
    await warmDevClient(
      webUrl,
      Math.max(webBudget - (Date.now() - webStart), 1),
      proc,
    );
    const relayToken = await waitForToken(home);
    const bound: StackPorts = {
      relay: relayPort,
      feed: feedPort,
      web: webPort,
    };
    return {
      home,
      webUrl,
      ports: bound,
      relayWs: `ws://127.0.0.1:${bound.relay}/ws`,
      feedWs: `ws://127.0.0.1:${bound.feed}/ws`,
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
      stop: async (stopOpts) => {
        await killProc(proc);
        releaseVite();
        await expectNoEngineLeak(leakTag);
        if (!stopOpts?.keepHome) dropHome();
      },
    };
  } catch (e) {
    // Group kill: `bun run dev` spawns detached — killing only the shim
    // orphans stack.ts + relay + harness + vite and poisons the next boot.
    if (spawned) await killProc(spawned);
    releaseVite();
    dropHome();
    throw e;
  }
}

/**
 * Deterministic mount signal for the peek panel: `[data-thread-panel]`
 * mounts as an empty shell while the conversation resolves async, so a
 * click waiting only on the shell can outrun the header's render under
 * load (the Widen click's own actionability window then expires first).
 * The session title is the thread header's first row — once it's up, the
 * conversation is mounted.
 */
export async function panelFocusReady(
  page: import("@playwright/test").Page,
): Promise<void> {
  const { expect } = playwright;
  const panel = page.locator("[data-thread-panel]");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator("[data-session-title]")).toBeVisible({
    timeout: 30_000,
  });
}

/** Where a conversation opens in v3: beside Threads, in the URL hash (the
 *  packaged app loads from file:, so only the fragment can carry it).
 *  `full` widens the peek over the page, which IS the session view (chat
 *  beside the Workbench), what Focus used to be. */
export const threadUrl = (
  webUrl: string,
  conversationId: string,
  full = false,
): string =>
  `${webUrl}/#?page=threads&open=thread:${encodeURIComponent(conversationId)}${full ? "&full=1" : ""}`;

/** A person's page in the side peek over People. */
export const agentUrl = (webUrl: string, employeeId: string): string =>
  `${webUrl}/#?page=people&open=agent:${encodeURIComponent(employeeId)}`;

/**
 * Navigation helper: a send lands on Threads with the thread open in the
 * side peek (`#?page=threads&open=thread:<id>`); widening it over the page
 * (the peek header's button, or the panel's Focus) opens the session view.
 * Specs that need the Workbench call this: it waits for the peek URL,
 * clicks Widen, and waits for `full=1`.
 */
export async function panelIntoFocus(
  page: playwright.Page,
  focusUrl: RegExp = /[#&]full=1(&|$)/,
): Promise<void> {
  const { expect } = playwright;
  // The thread may sit anywhere in the trail (`open=agent:X,thread:Y`).
  await expect(page).toHaveURL(/[?&]open=([^&]*,)?thread:[^&,]+/, {
    timeout: 30_000,
  });
  // The URL lands before the panel mounts (the conv resolves async under
  // load) — wait for the surface, then the button.
  await panelFocusReady(page);
  await page
    .getByRole("complementary", { name: "Opened record" })
    .getByTitle("Widen over the page", { exact: true })
    .click();
  await expect(page).toHaveURL(focusUrl, { timeout: 30_000 });
}

/**
 * The way back: the peek header's Narrow (the session view's one way out,
 * beside Esc — the thread has no button of its own). Waits for the URL to
 * drop `full=1`, i.e. the thread beside the page again.
 */
export async function panelOutOfFocus(page: playwright.Page): Promise<void> {
  const { expect } = playwright;
  await page
    .getByRole("complementary", { name: "Opened record" })
    .getByTitle("Narrow, back beside the page", { exact: true })
    .click();
  await expect(page).not.toHaveURL(/[#&]full=1(&|$)/, { timeout: 30_000 });
}

/**
 * Past first run: the shell shows Welcome until `lilos-onboarded` is set, so
 * a spec that is not about first run lands on Home instead. Call before the
 * first `page.goto`.
 */
export const skipFirstRun = async (page: playwright.Page): Promise<void> => {
  await page.addInitScript(() => localStorage.setItem("lilos-onboarded", "1"));
};

/** The shell's own sidebar. The opened-record peek is an `<aside>` too, so a
 *  bare `page.locator("aside")` is ambiguous the moment a record is open. */
export const v3Sidebar = (page: playwright.Page): playwright.Locator =>
  page.locator("aside:not([aria-label])");

/** The side peek: whatever was opened (thread, person, new chat). */
export const v3Peek = (page: playwright.Page): playwright.Locator =>
  page.getByRole("complementary", { name: "Opened record" });

/** The page column: where a record lands when the open is a jump — sidebar,
 *  palette, notification, or a link the current page doesn't own (D-#769). */
export const v3Main = (page: playwright.Page): playwright.Locator =>
  page.locator("#v3-main");

/**
 * Start a chat with `agent` the way a person does: the new-chat draft beside
 * Threads, type, Send. Resolves once the draft has swapped for its thread
 * (`#?page=threads&open=thread:<id>`, the shape `panelIntoFocus` expects) and
 * returns that conversation's id.
 */
export async function startChat(
  page: playwright.Page,
  webUrl: string,
  agent: { id: string; name: string },
  text: string,
): Promise<string> {
  const { expect } = playwright;
  await page.goto(
    `${webUrl}/#?page=threads&open=newchat:${encodeURIComponent(agent.id)}`,
  );
  const box = v3Peek(page).getByPlaceholder(`Message ${agent.name}…`);
  await expect(box).toBeVisible({ timeout: 30_000 });
  await box.fill(text);
  await v3Peek(page).getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 30_000 });
  return decodeURIComponent(/open=thread:([^&,]+)/.exec(page.url())?.[1] ?? "");
}

/** One JSON-RPC call on the relay from inside the page (hello + request). */
export async function relayRpc<T>(
  page: playwright.Page,
  stack: Pick<Stack, "relayWs" | "relayToken">,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  return (await page.evaluate(
    async ({ ws, token, method, params }) => {
      const sock = new WebSocket(`${ws}?token=${encodeURIComponent(token)}`);
      const rpc = (id: number, m: string, p: Record<string, unknown>) =>
        sock.send(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }));
      return await new Promise((resolve, reject) => {
        const fail = (e: unknown) => {
          sock.close();
          reject(e instanceof Error ? e : new Error(String(e)));
        };
        sock.onerror = () => fail(new Error("ws error"));
        sock.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.error) return fail(new Error(msg.error.message));
          if (msg.id === 1) rpc(2, method, params);
          else if (msg.id === 2) {
            sock.close();
            resolve(msg.result);
          }
        };
        sock.onopen = () =>
          rpc(1, "session.hello", {
            protocolVersion: 1,
            token,
            client: { name: "e2e" },
          });
      });
    },
    { ws: stack.relayWs, token: stack.relayToken, method, params },
  )) as Promise<T>;
}

/**
 * A new chat with the company's default agent, the way a person starts one:
 * Threads → "New chat". Leaves the draft composer open in the peek and
 * returns it (placeholder `Message <name>…`). Past first run.
 */
export async function openNewChat(
  page: playwright.Page,
  webUrl: string,
): Promise<playwright.Locator> {
  const { expect } = playwright;
  await skipFirstRun(page);
  await page.goto(`${webUrl}/#?page=threads`);
  // The button exists once the directory has an agent to talk to.
  await page
    .getByRole("button", { name: "New chat" })
    .click({ timeout: 60_000 });
  const box = v3Peek(page).getByPlaceholder(/^Message /);
  await expect(box).toBeVisible({ timeout: 30_000 });
  return box;
}

/**
 * `startChat` bound to `folder`: the draft's Project chip picks the folder's
 * project (D-#771), which the relay makes over the wire first (the folder
 * joins the recents too, as a person adding it would) and the page reloaded
 * (the shell reads the company when it mounts). Past first run; resolves
 * once the draft has swapped for its thread and returns that conversation's
 * id.
 */
export async function startChatInFolder(
  page: playwright.Page,
  stack: Stack,
  agent: { id: string; name: string },
  folder: string,
  text: string,
): Promise<string> {
  const { expect } = playwright;
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  await relayRpc(page, stack, "folders.add", { path: folder });
  await relayRpc(page, stack, "projects.create", { folder });
  await page.goto(
    `${stack.webUrl}/#?page=threads&open=newchat:${encodeURIComponent(agent.id)}`,
  );
  await page.reload();
  const peek = v3Peek(page);
  const chip = peek.getByTitle(/^Project · /);
  await expect(chip).toBeVisible({ timeout: 30_000 });
  const base = path.basename(folder);
  await chip.click();
  await peek.getByRole("menuitemradio", { name: new RegExp(base) }).click();
  await expect(chip).toContainText(base, { timeout: 15_000 });
  await peek.getByPlaceholder(`Message ${agent.name}…`).fill(text);
  await peek.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 30_000 });
  return decodeURIComponent(/open=thread:([^&,]+)/.exec(page.url())?.[1] ?? "");
}

/**
 * The company's first agent (the one the harness hires when the roster is
 * empty): past first run, open its page in the side peek (`#?open=agent:<id>`)
 * and read its name off the record. D-#836 took the roster row out of the
 * paused sidebar, so the id comes off the relay's employees.list — same
 * record the row used to show (oldest hire first; "Default" on engine-fake,
 * "default" on hermes). The agent's page is left open in the peek — an
 * agent belongs to People, so the peek is where the URL keeps it (D-#769).
 */
export async function openDefaultAgent(
  page: playwright.Page,
  webUrl: string,
  timeout = 30_000,
): Promise<{ id: string; name: string }> {
  const { expect } = playwright;
  await skipFirstRun(page);
  await page.goto(`${webUrl}/`);
  const cfg = (await (
    await fetch(`${webUrl}/lilos-config.json`, { cache: "no-store" })
  ).json()) as { relayWs: string; relayToken?: string };
  const { employees } = await relayRpc<{
    employees: { id: string; name: string }[];
  }>(
    page,
    { relayWs: cfg.relayWs, relayToken: cfg.relayToken ?? "" },
    "employees.list",
    {},
  );
  const agent = employees.find((e) => /default/i.test(e.name)) ?? employees[0];
  if (!agent) throw new Error("employees.list returned nobody");
  await page.goto(agentUrl(webUrl, agent.id));
  await expect(
    v3Peek(page).getByRole("heading", { level: 1, name: agent.name }),
  ).toBeVisible({ timeout });
  return { id: agent.id, name: agent.name };
}

/**
 * Open an existing conversation as the session view (chat beside the
 * Workbench) — what "open the session row, then Focus" used to be. Past first
 * run; resolves once the thread's composer is up.
 */
export async function openSession(
  page: playwright.Page,
  webUrl: string,
  conversationId: string,
): Promise<void> {
  const { expect } = playwright;
  await skipFirstRun(page);
  await page.goto(threadUrl(webUrl, conversationId, true));
  await expect(
    page
      .locator("[data-thread-panel]")
      .getByRole("textbox", { name: /^Message [^…]+…$/ }),
  ).toBeVisible({ timeout: 45_000 });
}

/**
 * A chat in NO folder, started over the relay with no draft: exactly what a
 * send does (`channels.openDm` + `conversations.open` with no `cwd`). The
 * draft's Project chip does offer "No project · just chat", but it opens on
 * where the agent's last chat ran, so a spec that only needs a plain chat
 * (not the pick itself) skips choosing it. Resolves with the new
 * conversation's id; the page is left on `stack.webUrl` past first run.
 */
export async function startFolderlessChat(
  page: playwright.Page,
  stack: Stack,
  text: string,
): Promise<string> {
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  const { employees } = await relayRpc<{ employees: { id: string }[] }>(
    page,
    stack,
    "employees.list",
    {},
  );
  const { channel } = await relayRpc<{ channel: { id: string } }>(
    page,
    stack,
    "channels.openDm",
    { employeeId: employees[0].id },
  );
  const { conversation } = await relayRpc<{ conversation: { id: string } }>(
    page,
    stack,
    "conversations.open",
    { channelId: channel.id, authorId: "user", text },
  );
  return conversation.id;
}
