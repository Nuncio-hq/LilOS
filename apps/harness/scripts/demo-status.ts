import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RelayClient } from "@lilos/client-runtime";
import { APP_PROTOCOL_VERSION } from "@lilos/contracts/app";
import packageJson from "../package.json";
import { connectEngineWs } from "../src/engine/client";
import {
  commandLauncher,
  fakeEngineLauncher,
  hermesEngineLauncher,
} from "../src/engine/launcher";
import { EngineSupervisor } from "../src/engine/supervisor";
import { createFileLogger } from "../src/log";
import { StatusReporter, teeLogger } from "../src/status";

/**
 * Demo/e2e driver for issue #33: the real harness leg end to end — register
 * the version handshake with a relay, supervise an engine, report status
 * (describe probe, RSS, live sessions, log tail) on a 10s cadence.
 *
 *   LILOS_RELAY_URL   ws endpoint (default ws://127.0.0.1:4577/ws)
 *   LILOS_RELAY_TOKEN install token (default: ~/.lilos/relay-token)
 *   LILOS_ENGINE      "fake" (default) | "hermes" — hermes honours
 *                     HERMES_PROVIDER / HERMES_MODEL for a live model
 *   LILOS_MODEL       model name reported on the status surface
 *   LILOS_DEMO_SESSIONS  open N engine sessions so the live count is real
 */
const repoRoot = join(import.meta.dir, "../../..");
const url = process.env.LILOS_RELAY_URL ?? "ws://127.0.0.1:4577/ws";
const token =
  process.env.LILOS_RELAY_TOKEN ??
  readFileSync(join(homedir(), ".lilos", "relay-token"), "utf8").trim();
const engineKind = process.env.LILOS_ENGINE ?? "fake";
const model =
  process.env.LILOS_MODEL ??
  (engineKind === "hermes" ? process.env.HERMES_MODEL : "fake-model-1");
const demoSessions = Number.parseInt(
  process.env.LILOS_DEMO_SESSIONS ?? "0",
  10,
);
const statusIntervalMs = Number.parseInt(
  process.env.LILOS_STATUS_INTERVAL_MS ?? "10000",
  10,
);

const log = teeLogger(
  createFileLogger({
    file: join(homedir(), ".lilos", "harness-demo.log"),
    console: true,
  }),
);

const client = new RelayClient({
  url,
  token,
  client: { name: "harness", version: packageJson.version },
  onFatalError: (error) => {
    log.error("fatal relay error", {
      message: error.message,
      code: error.code,
    });
  },
});
await client.connect();
const { hostId } = await client.request<{ hostId: string }>(
  "harness.register",
  { protocolVersion: APP_PROTOCOL_VERSION, version: packageJson.version },
);
log.info("registered with relay", { hostId, url });

const live = new Set<string>();
const supervisor = new EngineSupervisor({
  launcher:
    engineKind === "hermes"
      ? hermesEngineLauncher({
          repoRoot,
          provider: process.env.HERMES_PROVIDER,
          model: process.env.HERMES_MODEL,
          log,
        })
      : engineKind === "broken"
        ? commandLauncher({
            name: "broken-engine",
            command: ["/nonexistent/lilos-engine"],
            readyPattern: /never/,
            startupTimeoutMs: 1_000,
            log,
          })
        : fakeEngineLauncher({ repoRoot, log }),
  connect: (engineUrl) => connectEngineWs(engineUrl),
  onConnection: (conn) => {
    // A dropped engine socket means those sessions may be gone — recount
    // against the fresh connection rather than reporting stale ids.
    conn.onClose?.(() => live.clear());
    void (async () => {
      while (live.size < demoSessions) {
        try {
          const { sessionId } = await conn.request<{ sessionId: string }>(
            "session.start",
            { agent: "status-demo", cwd: repoRoot, model },
          );
          live.add(sessionId);
          log.info("demo engine session started", { sessionId });
        } catch {
          break;
        }
      }
    })();
  },
  log,
});

const reporter = new StatusReporter({
  send: (params) => client.request("harness.report", params),
  supervisor,
  version: packageJson.version,
  model,
  liveSessions: () => live.size,
  logTail: () => log.lines,
});

// Instant propagation of lifecycle changes; the 10s cadence keeps
// heartbeat/probe/RSS fresh between them.
const stopReporting = reporter.start(statusIntervalMs);
await supervisor.start();

const shutdown = async () => {
  stopReporting();
  await supervisor.stop();
  client.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
log.info("status demo running", { engineKind, model, demoSessions });
