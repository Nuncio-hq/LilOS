/**
 * Harness entry point — the only file allowed to touch Bun/process APIs.
 * Everything else in apps/harness is runtime-neutral TS.
 *
 *   LILOS_ENGINE=fake|hermes|url|command bun run apps/harness/src/index.ts
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { systemClock, watchOrphaned, watchWake } from "@lilos/background";
import { RelayClient } from "@lilos/client-runtime";
import { createCheckpointStore } from "@lilos/host";
import packageJson from "../package.json";
import { launcherFor, resolveHarnessConfig } from "./config";
import { connectEngineWs } from "./engine/client";
import { EngineSupervisor } from "./engine/supervisor";
import { createFeedHandler } from "./feed";
import { Harness } from "./harness";
import { createHostHandler } from "./host";
import { createFileLogger } from "./log";
import { createSleepGuard } from "./sleep";
import { StatusReporter, teeLogger } from "./status";

const config = resolveHarnessConfig();
mkdirSync(config.workdir, { recursive: true });
mkdirSync(config.checkpointsDir, { recursive: true });

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
const harness = new Harness({
  relay,
  sleep: createSleepGuard(process.platform, log),
  workdir: config.workdir,
  log,
  hideCaps: config.hideCaps,
  /* #134: per-folder shadow-git checkpoints, snapshotted before each turn. */
  checkpoints: createCheckpointStore(config.checkpointsDir),
  onNeedEngine: () => supervisor.ensureRunning(),
  version: releaseVersion,
});

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
// Packaged app: compiled engine adapters sit next to this binary when the
// bundle ships them (execPath = Contents/MacOS/lilos-harness); in a repo
// checkout execPath is bun and each engine's serve.ts is used instead.
const bundledEngine = (name: string) => {
  const p = join(dirname(process.execPath), name);
  return existsSync(p) ? p : undefined;
};
const supervisor = new EngineSupervisor({
  launcher: launcherFor(config, repoRoot, log, {
    fake: bundledEngine("lilos-engine-fake"),
    // "nous" not "hermes" in the file name: managed Macs kill *hermes*
    // executables by name (#141); the engine id stays "hermes".
    hermes: bundledEngine("lilos-engine-nous"),
  }),
  connect: (url) => connectEngineWs(url),
  onConnection: (conn) => harness.attachEngine(conn),
  onState: (state, detail) => harness.onEngineStateChange(state, detail),
  log,
});

await harness.start();
void supervisor.start();

/* #33: heartbeat engine telemetry (describe probe, RSS, live sessions, log
   tail) into `harness.report` so relay `system.status` stays fresh. */
const stopStatusReporter = new StatusReporter({
  send: (params) => relay.request("harness.report", params),
  supervisor,
  version: releaseVersion,
  model: "model" in config.engine ? config.engine.model : undefined,
  liveSessions: () => harness.liveSessionCount,
  logTail: () => [...log.lines],
}).start();

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
  },
});

// Client session feed: read-only engine-protocol surface for apps (the app
// never talks to the engine itself — describe/events.since + live events).
const feed = createFeedHandler(harness);
// Host API on the same loopback port (issue #113): POST /host, Bearer = the
// install token. The /ws feed stays open — it only reads engine events.
const host = createHostHandler({ token: config.relayToken });
type FeedData = { send: (frame: string) => void };
const feedServer = Bun.serve<FeedData>({
  hostname: "127.0.0.1",
  port: config.feedPort,
  fetch(req, server) {
    const pathname = new URL(req.url).pathname;
    if (pathname === "/host") return host(req);
    if (
      pathname === "/ws" &&
      server.upgrade(req, { data: { send: () => {} } })
    ) {
      return undefined;
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

const shutdown = async () => {
  log.info("shutting down");
  stopStatusReporter();
  wakeWatch.stop();
  feedServer.stop();
  feed.close();
  await supervisor.stop();
  await harness.stop();
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
  feed: `ws://127.0.0.1:${config.feedPort}/ws`,
  workdir: config.workdir,
});
