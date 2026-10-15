import { homedir } from "node:os";
import { join } from "node:path";

/**
 * D-#25: the relay is its own process (`apps/relay/src/index.ts`, its own
 * launchd agent on the desktop), local first — it binds 127.0.0.1 and
 * clients authenticate with the per-install token (`./auth.ts`). Going
 * remote means changing the address here (`LILOS_RELAY_HOST`), not the code.
 * Not: embedded in apps/web, or remote-first.
 */
export interface RelayConfig {
  /** Bind address. Local first: 127.0.0.1; remote later = change this. */
  host: string;
  /** TCP port; 0 asks the OS for a free one (tests). */
  port: number;
  /** Per-install state dir (SQLite file + auth token live here). */
  homeDir: string;
  dbPath: string;
  tokenPath: string;
}

const DEFAULT_RELAY_PORT = 4577;

export function resolveRelayConfig(
  env: Record<string, string | undefined> = process.env,
): RelayConfig {
  const homeDir = env.LILOS_RELAY_HOME ?? join(homedir(), ".lilos");
  const portRaw = env.LILOS_RELAY_PORT;
  const port =
    portRaw === undefined ? DEFAULT_RELAY_PORT : Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `LILOS_RELAY_PORT must be an integer 0-65535, got ${portRaw}`,
    );
  }
  return {
    host: env.LILOS_RELAY_HOST ?? "127.0.0.1",
    port,
    homeDir,
    dbPath: join(homeDir, "relay.sqlite"),
    tokenPath: join(homeDir, "relay-token"),
  };
}
