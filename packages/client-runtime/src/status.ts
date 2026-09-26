import type { StatusComponent, SystemStatusResult } from "@lilos/contracts/app";
import type { RelayConnectionState, RelayError } from "./client";

/** Latest `system.status` poll plus the transport state it was taken under. */
export interface StatusPollState {
  connection: RelayConnectionState;
  result?: SystemStatusResult;
  /** ms epoch of the last successful poll. */
  fetchedAt?: number;
  error?: string;
}

/**
 * Wire result → the four rows the status UI renders (`packages/ui` shares the
 * shape exactly). With no result — socket down, handshake fatal — the rows
 * are synthesized so Oscar always sees all four legs with a reason.
 */
export function toStatusComponents(input: {
  result?: SystemStatusResult;
  connection: RelayConnectionState;
  fatal?: RelayError;
}): StatusComponent[] {
  const { result, connection, fatal } = input;
  if (result) return result.components;

  const relay: StatusComponent = {
    id: "relay",
    label: "Relay",
    state: "down",
    reason: "",
  };
  if (fatal?.code === "protocol_version_mismatch") {
    const data = fatal.data as { update?: string } | undefined;
    relay.reason = `protocol mismatch — update the ${
      data?.update === "server" ? "relay" : "app"
    }`;
  } else if (fatal?.code === "unauthenticated") {
    relay.reason = "authentication failed — bad relay token";
  } else if (connection === "connecting" || connection === "reconnecting") {
    relay.state = "connecting";
    relay.reason =
      connection === "connecting"
        ? "connecting to relay"
        : "reconnecting to relay";
  } else {
    relay.reason =
      connection === "idle" ? "not connected yet" : "relay unreachable";
  }
  const waiting =
    relay.state === "connecting"
      ? "waiting for relay"
      : "unreachable — relay down";
  return [
    relay,
    { id: "harness", label: "Harness", state: "down", reason: waiting },
    { id: "engine", label: "Engine", state: "down", reason: waiting },
    { id: "model", label: "Model", state: "down", reason: waiting },
  ];
}

const humanBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
};

/**
 * The text the "Copy diagnostics" button lands on the clipboard (issue #33).
 * Log tails arrive already redacted by the relay; this formats only.
 */
export function formatDiagnostics(input: {
  result?: SystemStatusResult;
  connection: RelayConnectionState;
  fatal?: RelayError;
  error?: string;
  app?: { name?: string; version?: string };
}): string {
  const { result, connection, fatal, error, app } = input;
  const lines: string[] = [
    `LilOS diagnostics — ${new Date(result?.generatedAt ?? Date.now()).toISOString()}`,
    `connection: ${connection}`,
  ];
  if (app?.name) lines.push(`app: ${app.name} ${app.version ?? ""}`.trim());
  if (result) lines.push(`protocol: ${result.protocolVersion}`);
  if (error) lines.push(`error: ${error}`);
  if (fatal) lines.push(`fatal: ${fatal.message}`);

  // Synthesized rows when the relay couldn't answer — the bundle still says
  // which leg is broken rather than coming back empty.
  lines.push("", "Components");
  for (const c of toStatusComponents({ result, connection, fatal })) {
    lines.push(`- ${c.id.padEnd(8)} ${c.state.padEnd(10)} ${c.reason}`);
  }

  if (result) {
    lines.push("", "Versions");
    lines.push(
      `relay: ${result.versions.relay} (protocol ${result.versions.relayProtocol})`,
    );
    if (result.versions.harness !== undefined) {
      lines.push(
        `harness: ${result.versions.harness} (protocol ${result.versions.harnessProtocol ?? "?"})`,
      );
    } else {
      lines.push("harness: not registered");
    }
    if (result.engine) {
      lines.push("", "Engine");
      if (result.engine.name) {
        lines.push(
          `name: ${result.engine.name}${result.engine.version ? ` ${result.engine.version}` : ""}`,
        );
      }
      if (result.engine.rssBytes !== undefined) {
        lines.push(
          `rss: ${humanBytes(result.engine.rssBytes)} (${result.engine.rssBytes} bytes)`,
        );
      }
      if (result.engine.sessions !== undefined) {
        lines.push(`sessions: ${result.engine.sessions}`);
      }
    }
    if (result.mismatch) {
      lines.push("", "Mismatch");
      lines.push(
        `update the ${result.mismatch.update} — ${result.mismatch.detail}`,
      );
    }
    if (result.logs) {
      if (result.logs.relay.length > 0) {
        lines.push("", "Relay log (recent)");
        lines.push(...result.logs.relay);
      }
      if (result.logs.harness.length > 0) {
        lines.push("", "Harness log (recent)");
        lines.push(...result.logs.harness);
      }
    }
  }
  return lines.join("\n");
}
