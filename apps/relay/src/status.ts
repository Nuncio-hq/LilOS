import type {
  EngineHostState,
  HarnessStatusReport,
  StatusComponent,
  StatusComponentState,
  StatusMismatch,
  SystemStatusResult,
} from "@lilos/contracts/app";
import { redactSecrets } from "./redact";

/** What the session layer knows about the registered engine host. */
export interface HostView {
  version: string;
  protocolVersion: number;
  registeredAt: number;
  lastReportAt?: number;
  engine?: { state: EngineHostState; detail?: string };
  status?: HarnessStatusReport;
}

/** A handshake that failed on protocol version — evidence for `mismatch`. */
export interface RejectedHandshake {
  kind: "hello" | "register";
  claimed: number;
  at: number;
}

export interface StatusInput {
  protocolVersion: number;
  relayVersion: string;
  now: number;
  /** A harness heartbeat older than this marks the leg degraded. */
  heartbeatFreshMs: number;
  host: HostView | null;
  lastHostDisconnectedAt?: number;
  rejected: RejectedHandshake[];
  relayLogTail: (n: number) => string[];
  logLines: number;
  /** Exact secret values masked wherever they appear. */
  secrets: (string | undefined)[];
}

const ago = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`;

const component = (
  id: StatusComponent["id"],
  label: string,
  state: StatusComponentState,
  reason: string,
): StatusComponent => ({ id, label, state, reason });

/**
 * Aggregates the four status legs from what the relay can prove itself: it is
 * answering (relay), the host socket is or isn't held (harness), and whatever
 * the host last reported (engine, model). A fresh heartbeat keeps harness ok;
 * a stale one degrades it rather than guessing the process is gone.
 */
export function buildSystemStatus(input: StatusInput): SystemStatusResult {
  const {
    protocolVersion,
    relayVersion,
    now,
    heartbeatFreshMs,
    host,
    lastHostDisconnectedAt,
    rejected,
    relayLogTail,
    logLines,
    secrets,
  } = input;
  const engineState = host?.engine?.state;
  const redact = (line: string) => redactSecrets(line, secrets);

  const components: StatusComponent[] = [
    component(
      "relay",
      "Relay",
      "ok",
      `answering (v${relayVersion}, protocol ${protocolVersion})`,
    ),
  ];

  // — harness: the registered host socket + heartbeat freshness —
  let harnessState: StatusComponentState;
  let harnessReason: string;
  const registerRejection = [...rejected]
    .reverse()
    .find((r) => r.kind === "register");
  if (host) {
    if (host.lastReportAt === undefined) {
      harnessState = "ok";
      harnessReason = `registered v${host.version}, awaiting first report`;
    } else {
      const age = now - host.lastReportAt;
      harnessState = age <= heartbeatFreshMs ? "ok" : "degraded";
      harnessReason =
        age <= heartbeatFreshMs
          ? `connected v${host.version}, heartbeat ${ago(age)} ago`
          : `heartbeat stale (${ago(age)} > ${ago(heartbeatFreshMs)})`;
    }
  } else {
    harnessState = "down";
    harnessReason = registerRejection
      ? `register rejected: harness spoke protocol ${registerRejection.claimed}, relay is ${protocolVersion}`
      : lastHostDisconnectedAt !== undefined
        ? `harness disconnected ${ago(now - lastHostDisconnectedAt)} ago`
        : "no harness connected";
  }
  components.push(component("harness", "Harness", harnessState, harnessReason));

  // — engine: the lifecycle the host reports —
  let engineOk = false;
  if (!host) {
    // Not broken itself: blocked waiting on the harness leg (#53).
    components.push(
      component(
        "engine",
        "Engine",
        "blocked",
        "waiting for a harness to register",
      ),
    );
  } else {
    switch (engineState) {
      case "running": {
        const probeAge =
          host.status?.probedAt !== undefined ? now - host.status.probedAt : 0;
        const name = host.status?.engineName;
        if (
          host.status?.probedAt !== undefined &&
          probeAge > heartbeatFreshMs
        ) {
          components.push(
            component(
              "engine",
              "Engine",
              "degraded",
              `last successful probe ${ago(probeAge)} ago`,
            ),
          );
        } else {
          engineOk = true;
          // AC-4: RSS + live sessions ride on the row reason so Oscar sees
          // them without opening the diagnostics bundle.
          const meters: string[] = [];
          if (host.status?.engineRssBytes !== undefined) {
            meters.push(
              `${Math.round(host.status.engineRssBytes / 1_048_576)} MB`,
            );
          }
          if (host.status?.sessions !== undefined) {
            const s = host.status.sessions;
            meters.push(`${s} session${s === 1 ? "" : "s"}`);
          }
          components.push(
            component(
              "engine",
              "Engine",
              "ok",
              `running ${name ?? "engine"}${meters.length ? ` · ${meters.join(", ")}` : ""}${host.engine?.detail ? ` (${host.engine.detail})` : ""}`,
            ),
          );
        }
        break;
      }
      case "starting":
      case "restarting":
      case undefined:
        components.push(
          component(
            "engine",
            "Engine",
            "connecting",
            engineState === undefined
              ? "harness has not reported engine state"
              : `engine ${engineState}`,
          ),
        );
        break;
      default:
        components.push(
          component(
            "engine",
            "Engine",
            "down",
            host.engine?.detail ?? `engine ${engineState}`,
          ),
        );
    }
  }

  // — model: what the harness will run sessions on —
  if (!engineOk) {
    // Waiting on an upstream leg is `blocked`, not `down` (#53): the model
    // itself is not the failure and should not count as an issue.
    components.push(
      component(
        "model",
        "Model",
        "blocked",
        host ? "waiting for the engine" : "waiting for a harness to register",
      ),
    );
  } else if (host?.status?.model) {
    components.push(
      component("model", "Model", "ok", `running ${host.status.model}`),
    );
  } else {
    components.push(
      component(
        "model",
        "Model",
        "degraded",
        "engine running but no model reported",
      ),
    );
  }

  // — version mismatch: which side is stale —
  let mismatch: StatusMismatch | undefined;
  if (!host && registerRejection) {
    mismatch = {
      update: registerRejection.claimed > protocolVersion ? "relay" : "harness",
      detail: `harness spoke protocol ${registerRejection.claimed}, relay speaks ${protocolVersion}`,
    };
  } else if (!host) {
    const helloRejection = [...rejected]
      .reverse()
      .find((r) => r.kind === "hello");
    if (helloRejection) {
      mismatch = {
        update: helloRejection.claimed > protocolVersion ? "relay" : "app",
        detail: `an app spoke protocol ${helloRejection.claimed}, relay speaks ${protocolVersion}`,
      };
    }
  }

  const engine = host?.status
    ? {
        name: host.status.engineName,
        version: host.status.engineVersion,
        rssBytes: host.status.engineRssBytes,
        sessions: host.status.sessions,
        capabilities: host.status.capabilities,
        models: host.status.models,
        defaultModel: host.status.defaultModel,
      }
    : host?.engine
      ? {}
      : undefined;

  const result: SystemStatusResult = {
    protocolVersion,
    generatedAt: now,
    components,
    versions: {
      relay: relayVersion,
      harness: host?.version,
      relayProtocol: protocolVersion,
      harnessProtocol: host?.protocolVersion,
    },
    engine,
    mismatch,
  };
  if (logLines > 0) {
    result.logs = {
      relay: relayLogTail(logLines).map(redact),
      harness: (host?.status?.logTail ?? []).slice(-logLines).map(redact),
    };
  }
  return result;
}
