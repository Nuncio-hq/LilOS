import {
  type AgentDescriptor,
  type AgentsCreateParams,
  type ModelOption,
  type ModelProvider,
  RPC_ERRORS,
} from "@lilos/contracts/engine";
import { RpcError } from "./errors.js";
import type { GatewayLike } from "./gateway.js";

/**
 * `agents` + `models` capabilities over `hermes serve` (#8).
 * A LilOS agent IS a Hermes profile: `agents.list/describe/create` map to
 * `profiles.list/describe/create`, and `session.start.agent` is the profile
 * `session.create` runs under. `models.list` flattens `model.options`;
 * `session.setModel` runs the CLI's own `/model` switch via `slash.exec`
 * (same path the TUI uses — proven by scripts/live/8.py).
 */

interface ProfileRow {
  name?: unknown;
  display_name?: unknown;
  description?: unknown;
  model?: unknown; // string, or ProfileModelPin {provider, default}
  provider?: unknown;
  skill_count?: unknown;
  is_default?: unknown;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined;

function pinnedModel(m: unknown): string | undefined {
  if (typeof m === "string") return str(m);
  if (m && typeof m === "object")
    return str((m as { default?: unknown }).default);
  return undefined;
}

function rowToAgent(p: ProfileRow): AgentDescriptor {
  const name = String(p.name);
  const display = str(p.display_name);
  const model = pinnedModel(p.model);
  const detail: Record<string, unknown> = {};
  const provider = str(p.provider);
  if (provider) detail.provider = provider;
  if (p.is_default === true) detail.isDefault = true;
  return {
    id: name,
    name: display || name,
    ...(str(p.description) ? { description: str(p.description) } : {}),
    ...(model ? { model } : {}),
    ...(Number.isInteger(p.skill_count)
      ? { skillCount: p.skill_count as number }
      : {}),
    ...(Object.keys(detail).length ? { detail } : {}),
  };
}

export async function listAgents(
  gw: GatewayLike,
): Promise<{ agents: AgentDescriptor[] }> {
  const r = (await gw.request("profiles.list", {})) as {
    profiles?: ProfileRow[];
  };
  const agents = (r.profiles ?? [])
    .filter((p) => str(p.name) !== undefined)
    .map(rowToAgent);
  return { agents };
}

/** Throw AGENT_NOT_FOUND when `id` is not a Hermes profile. */
export async function requireAgent(gw: GatewayLike, id: string): Promise<void> {
  const { agents } = await listAgents(gw);
  if (!agents.some((a) => a.id === id))
    throw new RpcError(RPC_ERRORS.AGENT_NOT_FOUND, `no agent ${id}`);
}

export async function describeAgent(
  gw: GatewayLike,
  id: string,
): Promise<{ agent: AgentDescriptor }> {
  await requireAgent(gw, id);
  const r = (await gw.request("profiles.describe", { name: id })) as {
    name?: unknown;
    description?: unknown;
    soul?: unknown;
    model?: unknown;
    skills?: unknown[];
    toolsets?: unknown[];
    mcp_servers?: unknown[];
  };
  const skills = Array.isArray(r.skills) ? r.skills.length : 0;
  const model = pinnedModel(r.model);
  return {
    agent: {
      id,
      name: str(r.name) ?? id,
      ...(str(r.description) ? { description: str(r.description) } : {}),
      ...(model ? { model } : {}),
      skillCount: skills,
      ...(str(r.soul) ? { soul: str(r.soul) } : {}),
      detail: {
        toolsets: Array.isArray(r.toolsets) ? r.toolsets.length : 0,
        mcpServers: Array.isArray(r.mcp_servers) ? r.mcp_servers.length : 0,
      },
    },
  };
}

export async function createAgent(
  gw: GatewayLike,
  p: AgentsCreateParams,
): Promise<{ agent: AgentDescriptor }> {
  const { agents } = await listAgents(gw);
  if (agents.some((a) => a.id === p.name))
    throw new RpcError(
      RPC_ERRORS.INVALID_STATE,
      `agent ${p.name} already exists — LilOS never overwrites a profile`,
    );
  const { model, provider } = splitModelRef(p.model);
  const detail = p.detail ?? {};
  await gw.request("profiles.create", {
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    ...(p.soul ? { soul: p.soul } : {}),
    // LilOS employees are addressed by profile name — no CLI alias shortcut.
    no_alias: true,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(typeof detail.clone_from === "string"
      ? { clone_from: detail.clone_from }
      : {}),
  });
  return describeAgent(gw, p.name);
}

interface ModelOptionsCapabilities {
  fast?: unknown;
  reasoning?: unknown;
  can_disable_reasoning?: unknown;
}

interface ModelOptionsProvider {
  slug?: unknown;
  name?: unknown;
  models?: unknown;
  /** {modelId: {fast, reasoning, can_disable_reasoning}} — inventory.py
      `_apply_capabilities`; `supported_efforts` is deliberately not
      forwarded upstream. */
  capabilities?: Record<string, ModelOptionsCapabilities> | unknown;
  /** Rows with `authenticated: false` carry no credential — they list for
      re-auth affordance, not picking. Absent on older gateways = keep. */
  authenticated?: unknown;
}

/**
 * Hermes' ordered effort ladder (`agent/reasoning_effort.py::EFFORT_LADDER`),
 * low → high. The gateway reports per-model `reasoning` booleans but no level
 * list, so a reasoning-capable model gets the full ladder (issue #92 AC-2).
 */
export const HERMES_EFFORT_LADDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export async function listModels(
  gw: GatewayLike,
  opts: { refresh?: boolean } = {},
): Promise<{
  models: ModelOption[];
  providers: ModelProvider[];
  default?: string;
}> {
  const r = (await gw.request("model.options", {
    ...(opts.refresh ? { refresh: true } : {}),
  })) as {
    providers?: ModelOptionsProvider[];
    model?: unknown;
    provider?: unknown;
  };
  /* #92 AC-1: every authenticated provider row — a pick from another
     provider switches the session's provider, not just the model. */
  const rows = (r.providers ?? []).filter((p) => p.authenticated !== false);
  const seen = new Set<string>();
  const models: ModelOption[] = [];
  const providers: ModelProvider[] = [];
  for (const prov of rows) {
    const slug = str(prov.slug) ?? str(prov.name);
    if (!slug) continue;
    providers.push({
      id: slug,
      ...(str(prov.name) ? { name: str(prov.name) } : {}),
    });
    const caps =
      typeof prov.capabilities === "object" && prov.capabilities !== null
        ? (prov.capabilities as Record<string, ModelOptionsCapabilities>)
        : {};
    const list = Array.isArray(prov.models) ? prov.models : [];
    for (const m of list) {
      /* A model entry is either a bare id string or a `{id}`-ish row; the id
         is opaque and may itself contain `/` (aggregator rows) — never split
         or rejoin it (issue #92 AC-8). */
      const id = typeof m === "string" ? str(m) : undefined;
      if (!id) continue;
      const key = `${slug}::${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cap = caps[id];
      const efforts =
        cap?.reasoning === true
          ? cap.can_disable_reasoning === false
            ? HERMES_EFFORT_LADDER.filter((e) => e !== "none")
            : [...HERMES_EFFORT_LADDER]
          : undefined;
      models.push({
        id,
        name: id,
        provider: slug,
        ...(efforts ? { efforts } : {}),
        ...(cap?.fast === true ? { fast: true } : {}),
      });
    }
  }
  const dflt = str(r.model);
  return { models, providers, ...(dflt ? { default: dflt } : {}) };
}

/**
 * Split a `provider/model` ref into the fields `session.create` /
 * `profiles.create` take. Bare names keep the ambient provider.
 */
export function splitModelRef(
  ref: string | undefined,
  ambientProvider?: string,
): { model?: string; provider?: string } {
  if (!ref) return ambientProvider ? { provider: ambientProvider } : {};
  const slash = ref.indexOf("/");
  if (slash > 0)
    return {
      provider: ref.slice(0, slash),
      model: ref.slice(slash + 1),
    };
  return {
    model: ref,
    ...(ambientProvider ? { provider: ambientProvider } : {}),
  };
}

/**
 * Model ids the gateway can enumerate, keyed per provider + globally;
 * undefined when `model.options` fails (older builds) — the `config.set`
 * answer is then the only signal, like before.
 */
async function knownModelIds(
  gw: GatewayLike,
): Promise<
  { all: Set<string>; byProvider: Map<string, Set<string>> } | undefined
> {
  try {
    const r = (await gw.request("model.options", {})) as {
      providers?: ModelOptionsProvider[];
    };
    const all = new Set<string>();
    const byProvider = new Map<string, Set<string>>();
    for (const prov of r.providers ?? []) {
      const slug = str(prov.slug) ?? str(prov.name);
      const list = Array.isArray(prov.models) ? prov.models : [];
      for (const m of list) {
        const id = str(m);
        if (!id) continue;
        all.add(id);
        if (slug) {
          const set = byProvider.get(slug) ?? new Set<string>();
          set.add(id);
          byProvider.set(slug, set);
        }
      }
    }
    return all.size ? { all, byProvider } : undefined;
  } catch {
    return undefined;
  }
}

interface ConfigSetResult {
  key?: unknown;
  value?: unknown;
  warning?: unknown;
  confirm_required?: unknown;
  confirm_message?: unknown;
  deferred?: unknown;
}

/**
 * `config.set` with the model-confirm handshake answered (issue #92 AC-4):
 * an expensive-model guard replies `confirm_required: true` and the pick is
 * re-issued once with `confirm_expensive_model` — the user's picker choice
 * IS the confirmation, no second ask surfaces in LilOS.
 */
async function configSet(
  gw: GatewayLike,
  runtimeSid: string,
  key: string,
  value: string,
): Promise<ConfigSetResult> {
  const send = (confirmed: boolean) =>
    gw.request("config.set", {
      key,
      value,
      session_id: runtimeSid,
      ...(confirmed ? { confirm_expensive_model: true } : {}),
    }) as Promise<ConfigSetResult>;
  let r = await send(false);
  if (r?.confirm_required === true) r = await send(true);
  return r;
}

/**
 * Session-scoped model pick via `config.set` (#92): `model` takes
 * `parse_model_switch_args` flags — `<id> --provider <slug> --reasoning
 * <level>` switches provider + effort atomically with the model; `fast`
 * toggles the session's service tier (`on`/`off` → `fast`/`normal`). A
 * running session defers the model leg to the next turn (`deferred: true`)
 * and never errors — effort/fast still apply live to the current agent.
 */
export async function setSessionModel(
  gw: GatewayLike,
  runtimeSid: string,
  pick: { model: string; provider?: string; effort?: string; fast?: boolean },
): Promise<{
  model: string;
  provider?: string;
  effort?: string;
  fast?: boolean;
  deferred?: boolean;
}> {
  // #50 AC-3 kept: validate against `model.options` first so an unknown id
  // is MODEL_NOT_FOUND here, not a lazy failure at the next prompt.
  const known = await knownModelIds(gw);
  if (known) {
    const scoped = pick.provider
      ? known.byProvider.get(pick.provider)
      : known.all;
    const ok = scoped ? scoped.has(pick.model) : known.all.has(pick.model);
    if (!ok)
      throw new RpcError(
        RPC_ERRORS.MODEL_NOT_FOUND,
        `no model ${pick.model} — see models.list`,
      );
  }
  const modelValue = [
    pick.model,
    pick.provider ? `--provider ${pick.provider}` : undefined,
    pick.effort ? `--reasoning ${pick.effort}` : undefined,
  ]
    .filter((x): x is string => Boolean(x))
    .join(" ");
  const r = await configSet(gw, runtimeSid, "model", modelValue);
  const applied = str(r.value) ?? pick.model;
  if (pick.fast !== undefined) {
    await configSet(gw, runtimeSid, "fast", pick.fast ? "on" : "off");
  }
  return {
    model: applied,
    ...(pick.provider ? { provider: pick.provider } : {}),
    ...(pick.effort ? { effort: pick.effort } : {}),
    ...(pick.fast !== undefined ? { fast: pick.fast } : {}),
    ...(r.deferred === true ? { deferred: true } : {}),
  };
}
