import type { AgentDescriptor } from "@lilos/contracts/engine";
import type { AcpLaunchSpec } from "@lilos/engine-acp";
import { ACP_AGENTS } from "@lilos/engine-acp/shims/registry";
import type { HarnessConfig } from "../config";
import type { Logger } from "../log";
import {
  acpEngineLauncher,
  type EngineLauncher,
  type LaunchedEngine,
} from "./launcher";

/**
 * D-#761 — the runtime catalog: every engine the harness may run, keyed by
 * the id `Employee.runtime` stores. `"hermes"` is the default runtime —
 * whatever `LILOS_ENGINE` configured (fake/hermes/acp/url/command), so a
 * pre-#761 install needs no migration and a dev stack's engine-fake plays
 * the default role. `"acp:<agent>"` names a curated ACP registry entry;
 * it starts lazily on first demand, never at boot.
 *
 * T3's `ProviderInstanceRegistry` idea ported as plain TS: instances keyed
 * by id, availability probed off the registry recipe, roster seeds known
 * before the engine ever runs. Not: vendor names inside generic engine
 * code — the table's only ACP knowledge is which shims/registry ids exist.
 */

export const DEFAULT_RUNTIME = "hermes";

/** One catalog row — what the registry can start and report. */
export interface RuntimeSpec {
  id: string;
  /** Display name for status rows / the hire flow (e.g. "Devin"). */
  label: string;
  /** Build the launcher on demand — nothing spawns before first use. */
  launcher: () => EngineLauncher;
  /** The curated ACP recipe — presence marks an `acp:*` row and feeds the
      install probe + roster seed. */
  acpSpec?: AcpLaunchSpec;
  /** Roster seeds served by `agents.list` before the engine has started. */
  seedAgents?: AgentDescriptor[];
  /** Engine-side env (surfaces credentials) for a launched child. */
  engineEnv?: Record<string, string>;
}

export const isAcpRuntime = (id: string): boolean => id.startsWith("acp:");
export const acpRuntimeId = (agent: string): string => `acp:${agent}`;

/**
 * Employee/stored runtime values → a registry key: absent, blank, or the
 * literal "default"/"hermes" all mean the default engine (D-#761 — every
 * pre-#761 employee row carries NULL and must keep binding where it did).
 */
export function normalizeRuntime(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  return v === "" || v === "default" || v === DEFAULT_RUNTIME
    ? DEFAULT_RUNTIME
    : v;
}

/**
 * Session refs are runtime-qualified for non-default runtimes —
 * `"acp:devin::s-1"`. The default runtime keeps the bare engine id so
 * pre-#761 engineRef rows, feed clients, and session-event payloads are
 * unchanged. `::` cannot appear in a runtime id, so splitting on the
 * FIRST occurrence is unambiguous even if an engine's session id
 * contains `:`.
 */
export function qualifySessionRef(runtime: string, sessionId: string): string {
  return runtime === DEFAULT_RUNTIME ? sessionId : `${runtime}::${sessionId}`;
}

export function parseSessionRef(ref: string): {
  runtime: string;
  sessionId: string;
} {
  const i = ref.indexOf("::");
  if (i <= 0) return { runtime: DEFAULT_RUNTIME, sessionId: ref };
  return { runtime: ref.slice(0, i), sessionId: ref.slice(i + 2) };
}

/**
 * The catalog for this install: the configured default engine plus one
 * `acp:<id>` row per curated ACP registry entry. A default that is itself
 * `--agent X` absorbs `acp:X` — the same engine must not run twice.
 */
export function buildRuntimeCatalog(options: {
  config: HarnessConfig;
  repoRoot: string;
  log: Logger;
  defaultLauncher: () => EngineLauncher;
  /** Pre-compiled `lilos-engine-acp` binary in packaged builds. */
  acpServeBin?: string;
  engineEnv?: Record<string, string>;
}): RuntimeSpec[] {
  const { config, repoRoot, log } = options;
  const defaultEngine = config.engine;
  const defaultAcpAgent =
    defaultEngine.kind === "acp"
      ? (defaultEngine.agent ??
        (defaultEngine.command?.length ? undefined : "devin"))
      : undefined;
  const rows: RuntimeSpec[] = [
    {
      id: DEFAULT_RUNTIME,
      label: options.defaultLauncher().name,
      launcher: options.defaultLauncher,
    },
  ];
  for (const [agentId, spec] of Object.entries(ACP_AGENTS)) {
    if (
      defaultEngine.kind === "acp" &&
      defaultAcpAgent === agentId &&
      !defaultEngine.command?.length
    ) {
      // The configured default already is this agent — one instance.
      const defaultRow = rows[0];
      if (defaultRow) defaultRow.seedAgents = spec.agent ? [spec.agent] : [];
      continue;
    }
    const acpArgs: Parameters<typeof acpEngineLauncher>[0] = {
      repoRoot,
      agent: agentId,
      ...(options.acpServeBin ? { serveBin: options.acpServeBin } : {}),
      ...(options.engineEnv ? { env: options.engineEnv } : {}),
      log,
    };
    rows.push({
      id: acpRuntimeId(agentId),
      label: spec.agent?.name ?? agentId,
      launcher: () => acpEngineLauncher(acpArgs),
      acpSpec: spec,
      ...(spec.agent ? { seedAgents: [spec.agent] } : {}),
      ...(options.engineEnv ? { engineEnv: options.engineEnv } : {}),
    });
  }
  return rows;
}

/** A launcher's started engine (the registry awaits this per instance). */
export type RuntimeLaunch = LaunchedEngine;
