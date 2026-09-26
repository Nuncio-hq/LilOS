import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EngineLauncher } from "./engine/launcher";
import {
  commandLauncher,
  externalEngineLauncher,
  fakeEngineLauncher,
  hermesEngineLauncher,
} from "./engine/launcher";
import type { Logger } from "./log";

/**
 * Harness configuration from env (runtime-portable: the same build runs on
 * Oscar's Mac or any other host — nothing macOS-specific outside `caffeinate`,
 * which is itself platform-gated).
 */
export interface HarnessConfig {
  relayUrl: string;
  relayToken: string;
  /** Harness state dir: logs + the default engine workdir live here. */
  homeDir: string;
  /** Engine sessions' cwd (a repo/workspace the agents edit). */
  workdir: string;
  engine:
    | {
        kind: "command";
        command: string[];
        readyPattern?: RegExp;
        url?: string;
      }
    | { kind: "fake"; tick?: number }
    | { kind: "hermes"; provider?: string; model?: string }
    | { kind: "url"; url: string };
  /** ws port of the client-facing session feed (read-only engine surface). */
  feedPort: number;
  /** Capability ids hidden from clients and disabled in the harness driver. */
  hideCaps: string[];
}

export const DEFAULT_RELAY_URL = "ws://127.0.0.1:4577/ws";

export function resolveHarnessConfig(
  env: Record<string, string | undefined> = process.env,
): HarnessConfig {
  const relayHome = env.LILOS_RELAY_HOME ?? join(homedir(), ".lilos");
  const relayToken =
    env.LILOS_RELAY_TOKEN ?? readToken(join(relayHome, "relay-token"));
  const homeDir =
    env.LILOS_HARNESS_HOME ?? join(homedir(), ".lilos", "harness");
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const engineKind = env.LILOS_ENGINE ?? "fake";
  const engine: HarnessConfig["engine"] =
    engineKind === "url"
      ? { kind: "url", url: required(env.LILOS_ENGINE_URL, "LILOS_ENGINE_URL") }
      : engineKind === "hermes"
        ? {
            kind: "hermes",
            ...(env.HERMES_PROVIDER ? { provider: env.HERMES_PROVIDER } : {}),
            ...(env.HERMES_MODEL ? { model: env.HERMES_MODEL } : {}),
          }
        : engineKind === "command"
          ? {
              kind: "command",
              command: required(
                env.LILOS_ENGINE_COMMAND,
                "LILOS_ENGINE_COMMAND",
              ).split(" "),
              ...(env.LILOS_ENGINE_URL ? { url: env.LILOS_ENGINE_URL } : {}),
            }
          : {
              kind: "fake",
              ...(env.ENGINE_FAKE_TICK
                ? { tick: Number(env.ENGINE_FAKE_TICK) }
                : {}),
            };
  return {
    relayUrl: env.LILOS_RELAY_URL ?? DEFAULT_RELAY_URL,
    relayToken,
    homeDir,
    workdir: env.LILOS_WORKDIR ?? join(homeDir, "work"),
    engine,
    feedPort: Number(env.LILOS_FEED_PORT ?? 4581),
    hideCaps: (env.LILOS_HIDE_CAPS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export function launcherFor(
  config: HarnessConfig,
  repoRoot: string,
  log: Logger,
  fakeServeBin?: string,
): EngineLauncher {
  switch (config.engine.kind) {
    case "fake":
      return fakeEngineLauncher({
        repoRoot,
        ...(config.engine.tick !== undefined
          ? { tick: config.engine.tick }
          : {}),
        ...(fakeServeBin ? { serveBin: fakeServeBin } : {}),
        log,
      });
    case "hermes":
      return hermesEngineLauncher({
        repoRoot,
        ...(config.engine.provider ? { provider: config.engine.provider } : {}),
        ...(config.engine.model ? { model: config.engine.model } : {}),
        log,
      });
    case "command":
      return commandLauncher({
        name: config.engine.command[0] ?? "engine",
        command: config.engine.command,
        readyPattern: config.engine.readyPattern ?? /LISTENING (ws:\/\/\S+)/,
        ...(config.engine.url ? { url: config.engine.url } : {}),
        log,
      });
    case "url":
      return externalEngineLauncher(config.engine.url);
  }
}

const readToken = (path: string): string => {
  if (!existsSync(path)) {
    throw new Error(
      `relay token not found at ${path} — start the relay first or set LILOS_RELAY_TOKEN`,
    );
  }
  const token = readFileSync(path, "utf8").trim();
  if (!token) throw new Error(`relay token at ${path} is empty`);
  return token;
};

const required = (value: string | undefined, name: string): string => {
  if (!value) throw new Error(`${name} is required`);
  return value;
};
