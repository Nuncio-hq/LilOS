import {
  type AgentDescriptor,
  type AgentsCreateParams,
  type AgentsUpdateParams,
  type AgentsUpdateResult,
  type ModelOption,
  type ModelProvider,
  RPC_ERRORS,
} from "@lilos/contracts/engine";
import { RpcError } from "./errors.js";
import type { GatewayLike } from "./gateway.js";
import { contextWindowFromId, displayModelName } from "./model-label.js";

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
  const provider =
    r.model && typeof r.model === "object"
      ? str((r.model as { provider?: unknown }).provider)
      : undefined;
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
        ...(provider ? { provider } : {}),
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
  /* The model ref is `{provider?, id}` end to end (D-#8): `model` is the
     opaque id — it may itself contain `/` — and `provider` is a separate
     field. No `provider/model` join ever reaches `profiles.create`. */
  const detail = p.detail ?? {};
  await gw.request("profiles.create", {
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    ...(p.soul ? { soul: p.soul } : {}),
    // LilOS employees are addressed by profile name — no CLI alias shortcut.
    no_alias: true,
    ...(p.model ? { model: p.model } : {}),
    ...(p.provider ? { provider: p.provider } : {}),
    ...(typeof detail.clone_from === "string"
      ? { clone_from: detail.clone_from }
      : {}),
  });
  return describeAgent(gw, p.name);
}

/**
 * `agents.update` → `profiles.configure` (#123): the gateway's own profile
 * editor write — `soul` overwrites SOUL.md, `description` lands in
 * profile.yaml, `model`+`provider` pins config.yaml's `model.{provider,
 * default}`. Hermes can't rename a profile over the gateway (rename is
 * CLI-only), so `name` is refused — it's not in this engine's `updatable`.
 *
 * The gateway guards expensive/data-policy models: without
 * `confirm_expensive_model` a guarded pick answers `confirm_required` +
 * `confirm_message` and skips the model section (other sections still
 * apply). That handshake rides back to the caller as `confirmModel` so the
 * app can ask and re-send — never auto-confirmed here.
 */
export async function updateAgent(
  gw: GatewayLike,
  p: AgentsUpdateParams,
  ambientProvider?: string,
): Promise<AgentsUpdateResult> {
  const realId = await requireAgent(gw, p.id);
  const params: Record<string, unknown> = { name: realId };
  if (p.name !== undefined)
    throw new RpcError(
      RPC_ERRORS.INVALID_PARAMS,
      "Hermes cannot rename a profile over the wire — 'name' is not in this engine's updatable fields",
    );
  if (typeof p.soul === "string") params.soul = p.soul;
  if (typeof p.description === "string") params.description = p.description;
  if (p.model !== undefined) {
    /* `model` is the opaque id verbatim (D-#8); provider is a separate
       field — `p.provider`, else the ambient, else the profile's current
       pin. Hermes's `profiles.configure` writes the pair together. */
    let provider = p.provider ?? ambientProvider;
    if (!provider) {
      const cur = await describeAgent(gw, realId);
      provider = str(cur.agent.detail?.provider);
    }
    if (!provider)
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        "updating the model needs a provider — pass `provider` or pin one on the harness",
      );
    params.model = p.model;
    params.provider = provider;
    if (p.confirmModel === true) params.confirm_expensive_model = true;
  }
  const r = (await gw.request("profiles.configure", params)) as {
    ok?: unknown;
    applied?: Record<string, unknown>;
    confirm_required?: unknown;
    confirm_message?: unknown;
  };
  const after = await describeAgent(gw, realId);
  if (r.confirm_required === true)
    return {
      agent: after.agent,
      confirmModel:
        str(r.confirm_message) ?? "the engine wants a confirm for this model",
    };
  const failed = Object.entries(r.applied ?? {})
    .filter(([, ok]) => ok === false)
    .map(([k]) => k);
  if (failed.length)
    throw new RpcError(
      RPC_ERRORS.INTERNAL_ERROR,
      `profiles.configure could not write: ${failed.join(", ")}`,
    );
  return { agent: after.agent };
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
 * low → high — minus `ultra`, which Hermes documents as internal ("no wire
 * accepts it; every declared set stops at max"). The gateway reports
 * per-model `reasoning` booleans but no level list, so a reasoning-capable
 * model gets the full ladder (issue #92 AC-2).
 */
export const HERMES_EFFORT_LADDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export async function listModels(
  gw: GatewayLike,
  opts: { refresh?: boolean } = {},
): Promise<{
  models: ModelOption[];
  providers: ModelProvider[];
  default?: string;
  defaultProvider?: string;
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
      /* The only window Hermes exposes per catalog row is the `[1m]`/`[Nk]`
         route suffix inside the id itself (model.options carries no
         context length) — an id-declared claim, not a guess (#294). */
      const contextWindow = contextWindowFromId(id);
      models.push({
        id,
        /* Hermes reports ids only — the display name is derived with the
           same rules Hermes Desktop's picker uses (model-label.ts, #194). */
        name: displayModelName(id),
        provider: slug,
        ...(efforts ? { efforts } : {}),
        ...(cap?.fast === true ? { fast: true } : {}),
        ...(contextWindow ? { contextWindow } : {}),
      });
    }
  }
  const dflt = str(r.model);
  const dfltProvider = str(r.provider);
  return {
    models,
    providers,
    ...(dflt ? { default: dflt } : {}),
    /* model.options reports the ambient provider separately — carry it so a
       same-id-under-two-providers default still resolves to the right row. */
    ...(dfltProvider ? { defaultProvider: dfltProvider } : {}),
  };
}

interface KnownModelIds {
  all: Set<string>;
  byProvider: Map<string, Set<string>>;
}

/**
 * Model ids the gateway can enumerate, keyed per provider + globally;
 * undefined when `model.options` fails (older builds) — the `config.set`
 * answer is then the only signal, like before. `refresh` asks the account's
 * live catalog instead of the gateway's cached read (#140 AC-2).
 */
async function knownModelIds(
  gw: GatewayLike,
  opts: { refresh?: boolean } = {},
): Promise<KnownModelIds | undefined> {
  try {
    const r = (await gw.request("model.options", {
      ...(opts.refresh ? { refresh: true } : {}),
    })) as {
      providers?: ModelOptionsProvider[];
    };
    const all = new Set<string>();
    const byProvider = new Map<string, Set<string>>();
    for (const prov of r.providers ?? []) {
      // Same gate the picker applies (#92 AC-1): an unauthenticated
      // provider's model must fail here, not lazily at the next prompt.
      if (prov.authenticated === false) continue;
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

/* Whether the enumerated ids contain the pick: provider-scoped when the pick
   names one (ids are unique only per provider), else global; a pick whose
   provider the catalog doesn't know falls back to the global set. */
function pickIsKnown(
  known: KnownModelIds,
  pick: { model: string; provider?: string },
): boolean {
  const scoped = pick.provider
    ? known.byProvider.get(pick.provider)
    : known.all;
  return scoped ? scoped.has(pick.model) : known.all.has(pick.model);
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
 * `parse_model_flags` args — `<id> --provider <slug> --reasoning <level>`
 * switches provider + effort atomically with the model; `--session` keeps
 * the pick off `config.yaml` (Hermes' `resolve_persist_behavior` persists a
 * bare switch on a fresh install or with `persist_switch_by_default`, which
 * would silently retarget every employee's default). `fast` toggles the
 * session's service tier (`on`/`off` → `priority`/normal). A running
 * session defers only the model leg (`deferred: true` — Hermes stashes it
 * as `pending_model_switch` and applies it at turn start). The fast leg is
 * sent live in every case: `_set_fast` has no running check — it mutates
 * service_tier + request_overrides immediately, and the deferred apply
 * keeps those keys through `switch_model` (#92 AC-4 review).
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
  let known = await knownModelIds(gw);
  if (known && !pickIsKnown(known, pick)) {
    /* The pick may be valid on the engine's LIVE catalog while this cached
       read still omits it — e.g. a model Refresh just offered the user
       (account-gated rows like Astra appear only in the live list, #140
       AC-2). Re-check once with refresh:true before failing; an id missing
       from both reads still fails early (#50 AC-3). */
    known = (await knownModelIds(gw, { refresh: true })) ?? known;
  }
  if (known && !pickIsKnown(known, pick)) {
    throw new RpcError(
      RPC_ERRORS.MODEL_NOT_FOUND,
      `no model ${pick.model} — see models.list`,
    );
  }
  // The pick is interpolated into a config.set arg string upstream — a value
  // with whitespace or a leading dash would be parsed as extra flags.
  for (const v of [pick.model, pick.provider, pick.effort]) {
    if (v !== undefined && (/\s/.test(v) || v.startsWith("-")))
      throw new RpcError(
        RPC_ERRORS.INVALID_PARAMS,
        `invalid model pick value: ${JSON.stringify(v)}`,
      );
  }
  const modelValue = [
    pick.model,
    pick.provider ? `--provider ${pick.provider}` : undefined,
    pick.effort ? `--reasoning ${pick.effort}` : undefined,
    "--session",
  ]
    .filter(Boolean)
    .join(" ");
  const r = await configSet(gw, runtimeSid, "model", modelValue);
  const applied = str(r.value) ?? pick.model;
  /* The fast leg is a second config.set, always sent — `_set_fast`
     mutates the live session with no running check, and its tier survives
     the engine's own deferred model apply. Only a 4002 means "fast not
     available for this model" (the catalog row said it was → the engine
     disagreed): the tier did NOT change, so report the pick without `fast`
     rather than claim a flip to off. Transport drops and any other code
     (5001, …) still fail the whole pick — a swallowed error would leave
     LilOS believing a state the engine never applied. */
  let fast: boolean | undefined;
  if (pick.fast !== undefined) {
    try {
      await configSet(gw, runtimeSid, "fast", pick.fast ? "on" : "off");
      fast = pick.fast;
    } catch (e) {
      if (!(e instanceof RpcError && e.code === 4002)) throw e;
    }
  }
  return {
    model: applied,
    ...(pick.provider ? { provider: pick.provider } : {}),
    ...(pick.effort ? { effort: pick.effort } : {}),
    ...(fast !== undefined ? { fast } : {}),
    ...(r.deferred === true ? { deferred: true } : {}),
  };
}
