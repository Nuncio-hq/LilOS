/**
 * Harness entry point — the only file allowed to touch Bun/process APIs.
 * Everything else in apps/harness is runtime-neutral TS.
 *
 *   LILOS_ENGINE=fake|hermes|url|command bun run apps/harness/src/index.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
const supervisor = new EngineSupervisor({
  launcher: launcherFor(config, repoRoot, log),
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

const shutdown = async () => {
  log.info("shutting down");
  stopStatusReporter();
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
