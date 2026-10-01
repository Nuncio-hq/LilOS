/**
 * Harness entry point — the only file allowed to touch Bun/process APIs.
 * Everything else in apps/harness is runtime-neutral TS.
 *
 *   LILOS_ENGINE=fake|hermes|url|command bun run apps/harness/src/index.ts
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { systemClock, watchOrphaned, watchWake } from "@lilos/background";
import { RelayClient } from "@lilos/client-runtime";
import type { AppMessage } from "@lilos/contracts/app";
import { createCheckpointStore } from "@lilos/host";
import { SURFACES_ENV } from "@lilos/surfaces";
import packageJson from "../package.json";
import { launcherFor, resolveHarnessConfig } from "./config";
import { HermesConnect } from "./connect";
import { connectEngineWs } from "./engine/client";
import { resolveHermesBin } from "./engine/discover";
import { EngineSupervisor } from "./engine/supervisor";
import { createFeedHandler } from "./feed";
import { Harness } from "./harness";
import { createHostHandler } from "./host";
import { createFileLogger } from "./log";
import { createSleepGuard } from "./sleep";
import { StatusReporter, teeLogger } from "./status";
import { serveSurfaces } from "./surfaces/server";

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
/* The agent-gateway surfaces server (#337/#339): every engine session gets
   a Workbench scope (terminal/browser/thread tools). Hermes sessions reach
   it through the in-process lilos plugin — its process env carries the
   engine token, minted here; other engines attach the stdio `lilos mcp`
   spec the session mints. */
const surfaces = await serveSurfaces(0, {
  appOps: (_session, binding) => {
    if (!binding) return undefined;
    return {
      postMessage: async (text) => {
        const { message } = await relay.request<{ message: AppMessage }>(
          "messages.post",
          {
            channelId: binding.channelId,
            conversationId: binding.conversationId,
            authorKind: "employee",
            authorId: binding.employeeId,
            text,
          },
        );
        return message;
      },
      readConversation: async (afterSeq) => {
        const page = await relay.request<{ messages: AppMessage[] }>(
          "messages.list",
          {
            channelId: binding.channelId,
            conversationId: binding.conversationId,
            ...(afterSeq !== undefined ? { afterSeq } : {}),
          },
        );
        return page.messages;
      },
    };
  },
  log,
});

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
   leaves — never deleting a profile. Only the hermes engine has profiles
   + plugins to connect. */
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
      })
    : undefined;

const harness = new Harness({
  relay,
  sleep: createSleepGuard(process.platform, log),
  workdir: config.workdir,
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
    },
    {
      [SURFACES_ENV.baseUrl]: surfaces.url,
      [SURFACES_ENV.engineToken]: surfaces.engineToken,
    },
  ),
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
  connect: connect ? () => connect.report() : undefined,
  logTail: () => [...log.lines],
}).start();

/* Connect self-heals on a timer too (AC-6 version drift) — events alone
   can miss (harness was down when the approval or a hire landed). */
const connectTimer = connect
  ? setInterval(() => void connect.reconcile(), 30_000)
  : undefined;
void connect?.reconcile();

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
  if (connectTimer !== undefined) clearInterval(connectTimer);
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
  feed: `ws://127.0.0.1:${config.feedPort}/ws`,
  workdir: config.workdir,
});
