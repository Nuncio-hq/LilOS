/**
 * Harness entry point — the only file allowed to touch Bun/process APIs.
 * Everything else in apps/harness is runtime-neutral TS.
 *
 *   LILOS_ENGINE=fake|hermes|url|command bun run apps/harness/src/index.ts
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { systemClock, watchWake } from "@lilos/background";
import { RelayClient } from "@lilos/client-runtime";
import packageJson from "../package.json";
import { launcherFor, resolveHarnessConfig } from "./config";
import { connectEngineWs } from "./engine/client";
import { EngineSupervisor } from "./engine/supervisor";
import { Harness } from "./harness";
import { createFileLogger } from "./log";
import { createSleepGuard } from "./sleep";
import { StatusReporter, teeLogger } from "./status";

const config = resolveHarnessConfig();
mkdirSync(config.workdir, { recursive: true });
const log = teeLogger(
  createFileLogger({ file: join(config.homeDir, "harness.log") }),
);

const relay = new RelayClient({
  url: config.relayUrl,
  token: config.relayToken,
  client: { name: "lilos-harness", version: packageJson.version },
});
const harness = new Harness({
  relay,
  sleep: createSleepGuard(process.platform, log),
  workdir: config.workdir,
  log,
  onNeedEngine: () => supervisor.ensureRunning(),
  version: packageJson.version,
});

const repoRoot = process.env.LILOS_REPO_ROOT ?? process.cwd();
// Packaged app: a compiled engine-fake sits next to this binary when the
// bundle ships one (execPath = Contents/MacOS/lilos-harness); in a repo
// checkout execPath is bun and the repo's serve.ts is used instead.
const bundledFakeEngine = join(
  dirname(process.execPath),
  "lilos-engine-fake",
);
const serveBin = existsSync(bundledFakeEngine) ? bundledFakeEngine : undefined;
const supervisor = new EngineSupervisor({
  launcher: launcherFor(config, repoRoot, log, serveBin),
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
  version: packageJson.version,
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

const shutdown = async () => {
  log.info("shutting down");
  stopStatusReporter();
  wakeWatch.stop();
  await supervisor.stop();
  await harness.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
log.info("harness up", {
  relay: config.relayUrl,
  engine: config.engine.kind,
  workdir: config.workdir,
});
