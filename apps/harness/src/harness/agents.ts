import type { Conversation, Employee } from "@lilos/contracts/app";
import {
  CODING_AGENTS_SETTING_KEY,
  type CodingAgentDefaults,
  CodingAgentId,
  parseCodingAgents,
} from "@lilos/contracts/app";
import type { AgentDescriptor, McpServer } from "@lilos/contracts/engine";
import { expandPath } from "@lilos/host";
import type { EngineConnection } from "../engine/client";
import { normalizeRuntime } from "../engine/runtimes";
import type { HarnessCtx } from "./ctx";

/**
 * Engine agents and `session.start` params (was the `helpers`
 * section of `../harness.ts`).
 *
 * Moved verbatim out of `../harness.ts` (#441) — bodies byte-identical except each signature gained
 * `export function` + a `this: HarnessCtx` first parameter — `this` is
 * still the Harness: these functions sit on `Harness.prototype` via the
 * `Object.assign` at the bottom of `../harness.ts`.
 */

/**
 * The `agents` capability (D-#8): `session.start.agent` must be an
 * engine-registered agent id, so the harness hires the LilOS employee onto
 * the engine — `agents.list` for an existing profile, `agents.create`
 * otherwise. Engines without the capability (the method errors) take the
 * employee name verbatim.
 */
export async function ensureAgent(
  this: HarnessCtx,
  conn: EngineConnection,
  employee: Employee | undefined,
): Promise<string> {
  // `profile` is the employee's engine-agent handle; name is the fallback.
  const preferred = employee?.profile || employee?.name || "default";
  const want = preferred.toLowerCase();
  try {
    const list = async () =>
      (await conn.request<{ agents: AgentDescriptor[] }>("agents.list", {}))
        .agents;
    // Engines may normalize agent ids (Hermes lowercases profile names),
    // so match case-insensitively and always send back the engine's id.
    const match = (agents: AgentDescriptor[]) =>
      agents.find(
        (a) =>
          a.id === preferred ||
          a.id.toLowerCase() === want ||
          a.id === employee?.id ||
          a.name.toLowerCase() === want,
      );
    const agents = await list();
    const found = match(agents);
    if (found) return found.id;
    // Hire under the engine's default agent when it reports one — Hermes
    // clones that profile (config, providers, skills) so the employee can
    // actually run; engines ignoring `detail` are unaffected.
    const cloneFrom =
      agents.find((a) => a.detail?.isDefault === true)?.id ?? undefined;
    const create = (model?: string) =>
      conn.request<{ agent: AgentDescriptor }>("agents.create", {
        name: preferred,
        ...(employee?.instructions ? { soul: employee.instructions } : {}),
        /* #872: the record's description mirrors back — an in-memory
           roster (ACP) loses it on restart, the record is the source. */
        ...(employee?.description ? { description: employee.description } : {}),
        ...(model ? { model } : {}),
        ...(cloneFrom ? { detail: { clone_from: cloneFrom } } : {}),
      });
    try {
      return (await create(employee?.model || undefined)).agent.id;
    } catch {
      // The create may have partially succeeded (profile created but the
      // response lookup failed on a normalized id) or raced — re-list
      // before retrying unpinned.
      const retry = match(await list());
      if (retry) return retry.id;
      return (await create()).agent.id;
    }
  } catch (error) {
    this.opts.log.debug("agents capability unavailable; using employee name", {
      error: String(error),
    });
    return preferred;
  }
}

/**
 * The owner's stored default for this employee's coding agent (D-#835): the
 * `codingAgents` KV row, keyed by agent id — which is the employee's
 * engine handle when the hire named the CLI itself (Devin → "devin").
 * Non-coding profiles and unreadable rows get nothing; the row is a
 * fallback, never an override — a thread pick, a per-job `task_create`
 * stamp, or an employee pin still wins (#846).
 */
export async function codingAgentDefaults(
  this: HarnessCtx,
  employee: Employee | undefined,
): Promise<CodingAgentDefaults | undefined> {
  const id = CodingAgentId.safeParse(
    (employee?.profile ?? employee?.name ?? "").toLowerCase(),
  );
  if (!id.success) return undefined;
  try {
    const r = await this.opts.relay.request<{ value: unknown }>(
      "settings.get",
      { key: CODING_AGENTS_SETTING_KEY },
    );
    return parseCodingAgents(r.value)[id.data];
  } catch {
    return undefined;
  }
}

export async function sessionParams(
  this: HarnessCtx,
  employee: Employee | undefined,
  agentId: string,
  conv?: Conversation,
  mcpServer?: McpServer,
) {
  const base = this.opts.sessionParamsFor?.(employee, agentId) ?? {
    agent: agentId,
    ...(employee?.model ? { model: employee.model } : {}),
  };
  /* D-#846: precedence is conversation pick / per-job override (both live
     on the row) > the employee pin (the agent page's "Default model" —
     `employee.model`/`effort`, #872) > the stored per-agent default (the
     codingAgents KV, D-#835) > the sessionParamsFor pin > the agent's own
     default (its advertised currentValue). The KV holds model + effort
     only; provider and fast keep their existing sources. */
  const stored = await this.codingAgentDefaults(employee);
  // A pick pinned on the conversation (#30/#92) wins over the profile
  // default — each field falls back independently so a bare `model` pin
  // (old rows) still resolves its provider/effort on the engine.
  /* `""` is the record's empty, not a pick — fold it so the KV/engine
     defaults still apply. */
  const model =
    conv?.model ??
    (employee?.model || undefined) ??
    stored?.model ??
    base.model;
  const provider = conv?.provider ?? base.provider;
  const effort =
    conv?.effort ??
    (employee?.effort || undefined) ??
    stored?.effort ??
    base.effort;
  const fast = conv?.fast ?? base.fast;
  // D-#113: a thread owns its folder through its project — the folder is
  // the conversation's `cwd` (`conversations.open { cwd }`, stored nullable
  // on the relay row), and a folder used for the first time becomes a project
  // (the relay files it, D-#771). The engine gets it as `cwd` on
  // `session.start`; absent = a plain chat → the harness default workdir. A
  // live move goes through `session.moveWorkspace` (D-#581).
  // Not: a per-employee fixed workdir — one employee works many folders.
  const cwd = expandPath(conv?.cwd ?? this.opts.workdir, this.home);
  return {
    ...base,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(effort ? { effort } : {}),
    ...(fast !== undefined ? { fast } : {}),
    cwd,
    /* #106: the conversation's access level rides session.start — the
       engine may take it as a native hint (WS yolo / ACP set_mode). */
    ...(conv?.access ? { access: conv.access } : {}),
    /* D-#866 r9: the conversation id is the caller key a wedged-create
       guard scopes to — two threads sharing one folder must not share
       a wedge fate. */
    ...(conv?.id ? { callerKey: conv.id } : {}),
    ...(mcpServer ? { mcpServers: [mcpServer] } : {}),
  };
}

/* #872 — `task_create`'s explicit model is checked against the CHILD
   agent's own runtime catalog: a name only the parent's engine knows
   throws here, never silently starts on the wrong runtime. The answer is
   the catalog's own id/provider (a display name resolves to its id). A
   runtime whose catalog cannot be listed passes the pick through raw —
   the engine itself then accepts or rejects it. */
export async function checkTaskModel(
  this: HarnessCtx,
  employee: Employee,
  model: string,
  provider?: string,
): Promise<{ model: string; provider?: string }> {
  const runtime = normalizeRuntime(employee.runtime);
  let rows = this.modelCatalogs.get(runtime);
  if (!rows) {
    const conn =
      this.connForRuntime(runtime) ?? (await this.ensureRuntime(runtime));
    rows = conn
      ? conn
          .request<{
            models?: { id: string; name?: string; provider?: string }[];
          }>("models.list", {})
          .then((r) => r.models ?? [])
          .catch(() => [])
      : Promise.resolve([]);
    this.modelCatalogs.set(runtime, rows);
  }
  const list = await rows;
  if (!list.length) return { model, ...(provider ? { provider } : {}) };
  const hit = list.find((m) => m.id === model || m.name === model);
  if (!hit)
    throw new Error(
      `model "${model}" isn't one of ${employee.name}'s models — its runtime offers: ${list
        .slice(0, 6)
        .map((m) => m.name ?? m.id)
        .join(", ")}`,
    );
  if (provider && hit.provider && hit.provider !== provider)
    throw new Error(
      `"${model}" runs on provider "${hit.provider}" for ${employee.name}, not "${provider}"`,
    );
  return {
    model: hit.id,
    ...((hit.provider ?? provider)
      ? { provider: hit.provider ?? provider }
      : {}),
  };
}
