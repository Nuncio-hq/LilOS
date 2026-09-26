/**
 * Harness entry point — the only file allowed to touch Bun/process APIs.
 * Everything else in apps/harness is runtime-neutral TS.
 *
 *   LILOS_ENGINE=fake|hermes|url|command bun run apps/harness/src/index.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RelayClient } from "@lilos/client-runtime";
import { resolveHarnessConfig, launcherFor } from "./config";
import { connectEngineWs } from "./engine/client";
import { EngineSupervisor } from "./engine/supervisor";
import { Harness } from "./harness";
import { createFileLogger } from "./log";
import { createSleepGuard } from "./sleep";

const config = resolveHarnessConfig();
mkdirSync(config.workdir, { recursive: true });
const log = createFileLogger({
  file: join(config.homeDir, "harness.log"),
});

const relay = new RelayClient({
  url: config.relayUrl,
  token: config.relayToken,
  client: { name: "lilos-harness", version: "0" },
});
const harness = new Harness({
  relay,
  sleep: createSleepGuard(process.platform, log),
  workdir: config.workdir,
  log,
  onNeedEngine: () => supervisor.ensureRunning(),
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

const shutdown = async () => {
  log.info("shutting down");
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
