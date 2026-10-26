/**
 * Harness entry point — the only file allowed to touch Bun/process APIs.
 * Everything else in apps/harness is runtime-neutral TS.
 *
 *   LILOS_ENGINE=fake|hermes|url|command bun run apps/harness/src/index.ts
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { systemClock, watchOrphaned, watchWake } from "@lilos/background";
import { RelayClient } from "@lilos/client-runtime";
import type {
  AppMessage,
  Conversation,
  ConversationSummary,
  Employee,
  MessageSearchHit,
  ProfileSettings,
  ScheduledTask,
  SystemStatusResult,
} from "@lilos/contracts/app";
import type { ForgePrListItem } from "@lilos/contracts/host";
import { createCheckpointStore } from "@lilos/host";
import { SURFACES_ENV } from "@lilos/surfaces";
import packageJson from "../package.json";
import { launcherFor, resolveHarnessConfig } from "./config";
import { FakeConnect, HermesConnect } from "./connect";
import { reconcileBeforeEngine } from "./connect-boot";
import { connectEngineWs } from "./engine/client";
import { resolveHermesBin } from "./engine/discover";
import { EngineSupervisor } from "./engine/supervisor";
import { authorizeFeedUpgrade, createFeedHandler } from "./feed";
import { Harness } from "./harness";
import { createAppOps } from "./harness/app-ops";
import { createHostHandler } from "./host";
import { createFileLogger } from "./log";
import { createPluginRestart } from "./plugin-restart";
import { createSleepGuard } from "./sleep";
import { StatusReporter, teeLogger } from "./status";
import { serveSurfaces } from "./surfaces/server";

const config = resolveHarnessConfig();
mkdirSync(config.workdir, { recursive: true });
mkdirSync(config.checkpointsDir, { recursive: true });

/* Boot nonce served on the feed's /healthz (#273): an e2e readiness probe
   compares it against this line so a foreign harness answering the port is
   a hard boot failure, not silent cross-talk. Logged before the feed binds
   so ours is known even when the bind retries. */
const instanceId = randomUUID();
console.log(`[harness] instanceId: ${instanceId}`);

/** Release version — stamped at bundle build time (#35); repo builds report package.json's. */
const releaseVersion = process.env.LILOS_RELEASE_VERSION ?? packageJson.version;
const log = teeLogger(
  createFileLogger({ file: join(config.homeDir, "harness.log") }),
);

const relay = new RelayClient({
  url: config.relayUrl,
  token: config.relayToken,
  client: { name: "lilos-harness", version: releaseVersion },
});
/* The agent-gateway surfaces server (#337/#339): every engine session gets
   a Workbench scope (terminal/browser/thread tools). Hermes sessions reach
   it through the in-process lilos plugin — its process env carries the
   engine token, minted here; other engines attach the stdio `lilos mcp`
   spec the session mints. */
const surfaces = await serveSurfaces(0, {
  /* `harness` is const'd below but the factory only runs once a session
     binds, long after it exists. */
  appOps: createAppOps({
    relay,
    runningTurnId: (conversationId) => harness.runningTurnFor(conversationId),
    log,
  }),

  log,
});
/* #825: surfaces already binds port 0. Report the port the kernel gave
   it — unbuffered, same reason as the relay's instance id. */
try {
  writeSync(1, `[harness] surfaces listening on ${surfaces.url}\n`);
} catch {
  // fd 1 closed (stdout ignored).
}

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
// Packaged app: compiled engine adapters sit next to this binary when the
// bundle ships them (execPath = Contents/MacOS/lilos-harness); in a repo
// checkout execPath is bun and each engine's serve.ts is used instead.
const bundledEngine = (name: string) => {
  const p = join(dirname(process.execPath), name);
  return existsSync(p) ? p : undefined;
};
/* The lilos plugin dir: packaged builds carry it under
   Contents/Resources/app/plugin/lilos (build.ts), repo checkouts read the
   workspace source. */
const bundledPlugin = (root: string) => {
  const packaged = join(
    dirname(process.execPath),
    "..",
    "Resources",
    "app",
    "plugin",
    "lilos",
  );
  return existsSync(packaged)
    ? packaged
    : join(root, "packages/engine-hermes/plugin/lilos");
};

/* #339 Connect: reconciles the bundled lilos plugin onto each employee's
   Hermes profile once the Connect approval lands (relay setting
   `connect.hermes`), keeps it updated, disables it when the employee
   leaves — never deleting a profile. The real reconciler needs profiles +
   plugins, so hermes carries it; engine-fake gets FakeConnect only under
   `LILOS_CONNECT_FAKE=1` (the #413 e2e opts in — the fake has no plugin to
   install, so rows must not change the default fake stack's first-run
   flow); other engines report no rows.
   #413: `onChange` fires when the reported rows move — it re-sends
   `harness.report` immediately so the relay broadcasts `connect.changed`
   and the app patches live instead of waiting for the heartbeat. */
let statusReporter: StatusReporter | undefined;
const onConnectRows = () => {
  void statusReporter?.sendNow().catch(() => {});
};
/* Wired to the supervisor below. A copy during the boot reconcile sees
   `engineStarted` still false and does not schedule a restart (D-#817). */
let notePluginCopied = (): void => {};
const connect =
  config.engine.kind === "hermes"
    ? new HermesConnect({
        relay,
        hermesBin: () => resolveHermesBin(),
        hermesHome: process.env.HERMES_HOME ?? join(homedir(), ".hermes"),
        pluginSrc: bundledPlugin(repoRoot),
        env: {
          [SURFACES_ENV.baseUrl]: surfaces.url,
          [SURFACES_ENV.engineToken]: surfaces.engineToken,
        },
        log,
        onChange: onConnectRows,
        onPluginCopied: () => notePluginCopied(),
      })
    : config.engine.kind === "fake" && process.env.LILOS_CONNECT_FAKE === "1"
      ? new FakeConnect({ relay, log, onChange: onConnectRows })
      : undefined;

const harness = new Harness({
  relay,
  sleep: createSleepGuard(process.platform, log),
  workdir: config.workdir,
  /* Harness-owned state root — folder-less sessions' attachment files
     land under it. */
  stateDir: config.homeDir,
  log,
  hideCaps: config.hideCaps,
  /* #134: per-folder shadow-git checkpoints, snapshotted before each turn. */
  checkpoints: createCheckpointStore(config.checkpointsDir),
  surfaces,
  /* Hermes attaches via its plugin; ACP-shaped engines carry `lilos mcp`
     on `session.start`. */
  surfacesAttach: config.engine.kind === "hermes" ? "plugin" : "mcp",
  connect,
  onNeedEngine: () => supervisor.ensureRunning(),
  version: releaseVersion,
  /* #346 AC-3: idle-close — suspend a session quiet past the timeout so
     the next message resumes it; `0` keeps every session live. */
  sessionIdleMs: config.sessionIdleMs,
  /* #459: e2e bind-delay probe — see config.ts. */
  bindDelayMs: config.bindDelayMs,
});

const supervisor = new EngineSupervisor({
  launcher: launcherFor(
    config,
    repoRoot,
    log,
    {
      fake: bundledEngine("lilos-engine-fake"),
      // "nous" not "hermes" in the file name: managed Macs kill *hermes*
      // executables by name (#141); the engine id stays "hermes".
      hermes: bundledEngine("lilos-engine-nous"),
      acp: bundledEngine("lilos-engine-acp"),
    },
    {
      [SURFACES_ENV.baseUrl]: surfaces.url,
      [SURFACES_ENV.engineToken]: surfaces.engineToken,
    },
  ),
  connect: (url) => connectEngineWs(url),
  onConnection: (conn, _reconnect, gapCause) =>
    harness.attachEngine(conn, gapCause),
  onState: (state, detail) => harness.onEngineStateChange(state, detail),
  log,
});

let engineStarted = false;
const pluginRestart = createPluginRestart({
  engineStarted: () => engineStarted,
  idle: () => harness.engineIdle(),
  restart: () => supervisor.restartForPluginRefresh(),
  log,
});
notePluginCopied = () => pluginRestart.noteCopied();

await harness.start();
/* D-#817: replace the plugin before the engine can import it. The wait
   is bounded (CONNECT_BOOT_RECONCILE_MS in connect-boot.ts) so a pass
   stuck awaiting the relay cannot pin boot. The callback flips
   `engineStarted` first so a copy that finishes after the bound still
   restarts the new process. */
await reconcileBeforeEngine(
  () => (connect ? connect.reconcile() : Promise.resolve()),
  () => {
    engineStarted = true;
    void supervisor.start();
  },
  { log },
);

/* #33: heartbeat engine telemetry (describe probe, RSS, live sessions, log
   tail) into `harness.report` so relay `system.status` stays fresh. */
statusReporter = new StatusReporter({
  send: (params) => relay.request("harness.report", params),
  supervisor,
  version: releaseVersion,
  model: "model" in config.engine ? config.engine.model : undefined,
  liveSessions: () => harness.liveSessionCount,
  connect: connect ? () => connect.report() : undefined,
  logTail: () => [...log.lines],
});
const stopStatusReporter = statusReporter.start();

/* Connect self-heals on a timer too (D-#817 content hash) — events alone
   can miss (harness was down when the approval or a hire landed). The
   boot pass already ran, before supervisor.start. A hire does not need
   Connect approved again: employee.upserted reconciles too, and a pass
   that copies while the engine is up restarts it once idle. */
const connectTimer = connect
  ? setInterval(() => void connect.reconcile(), 30_000)
  : undefined;

// Sleep detection (AC-4): a frozen heartbeat that fires late means the Mac
// slept — drop the presumed-dead engine socket so the supervisor reconnects
// and resyncs sessions now rather than when TCP times out.
const wakeWatch = watchWake({
  clock: systemClock,
  wall: () => Date.now(),
  intervalMs: 5_000,
  driftMs: 15_000,
  onWake: (gapMs) => {
    log.info("woke from sleep", { gapMs });
    supervisor.notifyWake();
    /* Slept-through schedule slots surface on the next tick anyway — this
       just makes them land on wake, not up to 30s later. */
    void harness.scheduler?.tick();
  },
});

// Client session feed: read-only engine-protocol surface for apps (the app
// never talks to the engine itself — describe/events.since + live events).
const feed = createFeedHandler(harness, config.feedDelayMs);
// Host API on the same loopback port (issue #113): POST /host, Bearer = the
// install token. The /ws feed authenticates the same credential (#564) —
// read-only still broadcasts live agent output, so nothing here is open.
const host = createHostHandler({ token: config.relayToken });
type FeedData = { send: (frame: string) => void };
const feedServer = Bun.serve<FeedData>({
  hostname: "127.0.0.1",
  port: config.feedPort,
  fetch(req, server) {
    const pathname = new URL(req.url).pathname;
    if (pathname === "/host") return host(req);
    // Identity for e2e readiness probes (#273) — mirrors the relay's /healthz.
    if (pathname === "/healthz") return Response.json({ ok: true, instanceId });
    if (pathname === "/ws") {
      /* D-#564 AC-1: credential + app-origin gate BEFORE the socket
         upgrades — a refused request never attaches, so no held/live frame
         reaches it. */
      const denied = authorizeFeedUpgrade(req, config.relayToken);
      if (denied) return denied;
      if (server.upgrade(req, { data: { send: () => {} } })) {
        return undefined;
      }
      return new Response("websocket upgrade failed\n", { status: 400 });
    }
    return new Response("lilos harness feed\n", { status: 200 });
  },
  websocket: {
    open(ws) {
      ws.data.send = (frame) => ws.send(frame);
      feed.attach(ws.data.send);
    },
    close(ws) {
      feed.detach(ws.data.send);
    },
    async message(ws, message) {
      await feed.handleFrame(String(message), ws.data.send);
    },
  },
});
/* #825: `LILOS_FEED_PORT=0` asks the kernel for a port. The number in
   config is then 0; the one that was bound is `feedServer.port`. Parents
   (bun run dev, e2e) read this line instead of choosing the port. */
try {
  writeSync(1, `[harness] listening on http://127.0.0.1:${feedServer.port}\n`);
} catch {
  // fd 1 closed (stdout ignored).
}

const shutdown = async () => {
  log.info("shutting down");
  stopStatusReporter();
  wakeWatch.stop();
  feedServer.stop();
  feed.close();
  if (connectTimer !== undefined) clearInterval(connectTimer);
  pluginRestart.stop();
  await supervisor.stop();
  await harness.stop();
  await surfaces.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Orphan watchdog (#347): die with the tree that spawned us — a killed test
// worker or `bun run dev` umbrella otherwise leaves the harness holding the
// feed port and the engine it launched. Safe under launchd: a daemon's ppid
// is 1 from the start and never moves.
watchOrphaned({
  clock: systemClock,
  intervalMs: 1_000,
  onOrphaned: (reason) => {
    log.info("orphaned, shutting down", { reason });
    void shutdown();
  },
});
log.info("harness up", {
  relay: config.relayUrl,
  engine: config.engine.kind,
  feed: `ws://127.0.0.1:${feedServer.port}/ws`,
  workdir: config.workdir,
});
