import {
  type AgentDescriptor,
  type AgentsCreateParams,
  type ModelOption,
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

/**
 * Throw AGENT_NOT_FOUND when `id` is not a Hermes profile; resolve to the
 * canonical profile id otherwise. Hermes lowercases profile names, so callers
 * passing a display-style name (`Engineer`) still resolve to `engineer`.
 */
export async function requireAgent(
  gw: GatewayLike,
  id: string,
): Promise<string> {
  const { agents } = await listAgents(gw);
  const hit = agents.find(
    (a) => a.id === id || a.id.toLowerCase() === id.toLowerCase(),
  );
  if (!hit) throw new RpcError(RPC_ERRORS.AGENT_NOT_FOUND, `no agent ${id}`);
  return hit.id;
}

export async function describeAgent(
  gw: GatewayLike,
  id: string,
): Promise<{ agent: AgentDescriptor }> {
  const realId = await requireAgent(gw, id);
  const r = (await gw.request("profiles.describe", { name: realId })) as {
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
      id: realId,
      name: str(r.name) ?? realId,
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
  // Case-insensitive: Hermes lowercases profile names, so `Engineer` collides
  // with an existing `engineer` — reject before profiles.create half-applies.
  if (agents.some((a) => a.id.toLowerCase() === p.name.toLowerCase()))
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

interface ModelOptionsProvider {
  slug?: unknown;
  name?: unknown;
  models?: unknown;
}

export async function listModels(
  gw: GatewayLike,
  provider?: string,
): Promise<{
  models: ModelOption[];
  default?: string;
}> {
  const r = (await gw.request("model.options", {})) as {
    providers?: ModelOptionsProvider[];
    model?: unknown;
    provider?: unknown;
  };
  // The selectable set is the engine's provider's models: `model.options`
  // lists every provider Hermes knows, but only the ambient one is actually
  // usable by sessions this engine starts (a session.create provider pin is
  // what opts.provider feeds).
  const want = provider ?? str(r.provider);
  const provs = (r.providers ?? []).filter(
    (p) => !want || (str(p.slug) ?? str(p.name)) === want,
  );
  const rows = provs.length > 0 ? provs : (r.providers ?? []);
  const seen = new Set<string>();
  const models: ModelOption[] = [];
  for (const prov of rows) {
    const slug = str(prov.slug) ?? str(prov.name);
    const list = Array.isArray(prov.models) ? prov.models : [];
    for (const m of list) {
      const id = str(m);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, name: id, ...(slug ? { provider: slug } : {}) });
    }
  }
  const dflt = str(r.model);
  return { models, ...(dflt ? { default: dflt } : {}) };
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

const MODEL_OK = /✓|switched/i;
const BUSY = /busy|running|in progress/i;

/**
 * Union of every provider's model ids from `model.options`; undefined when
 * the gateway can't enumerate them (older builds) — then the slash output
 * marker is the only signal and we keep relying on it.
 */
async function knownModelIds(
  gw: GatewayLike,
): Promise<Set<string> | undefined> {
  try {
    const r = (await gw.request("model.options", {})) as {
      providers?: ModelOptionsProvider[];
    };
    const ids = new Set<string>();
    for (const prov of r.providers ?? []) {
      const list = Array.isArray(prov.models) ? prov.models : [];
      for (const m of list) {
        const id = str(m);
        if (id) ids.add(id);
      }
    }
    return ids.size ? ids : undefined;
  } catch {
    return undefined;
  }
}

/** `slash.exec /model <id>` — the TUI's own session-scoped switch. */
export async function setSessionModel(
  gw: GatewayLike,
  runtimeSid: string,
  model: string,
): Promise<{ model: string }> {
  // #50 AC-3: `/model` on Hermes switches lazily — it answers success for an
  // id the session can't actually use and the failure only surfaces at the
  // next prompt. Validate against `model.options` first so an unknown id is
  // MODEL_NOT_FOUND here, where the caller can react.
  const known = await knownModelIds(gw);
  if (known) {
    const bare = splitModelRef(model).model ?? model;
    if (!known.has(bare) && !known.has(model))
      throw new RpcError(
        RPC_ERRORS.MODEL_NOT_FOUND,
        `no model ${model} — see models.list`,
      );
  }
  const r = (await gw.request("slash.exec", {
    session_id: runtimeSid,
    command: `/model ${model}`,
  })) as { output?: unknown; warning?: unknown };
  const output = `${str(r.output) ?? ""}`.trim();
  const out = `${output}\n${str(r.warning) ?? ""}`.trim();
  if (BUSY.test(out))
    throw new RpcError(
      RPC_ERRORS.INVALID_STATE,
      `session is busy — ${out.split("\n")[0]}`,
    );
  // `warning` carries soft notices even on success (e.g. the model missing
  // from the endpoint's /models listing): the switch only failed when the
  // output lacks the success marker, so check success first.
  if (!MODEL_OK.test(output))
    throw new RpcError(
      RPC_ERRORS.MODEL_NOT_FOUND,
      out.split("\n")[0] || `no model ${model}`,
    );
  return { model };
}
