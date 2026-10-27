import type { Conversation, Employee } from "@lilos/contracts/app";
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
  /* D-#846/D-#835: precedence is conversation pick / per-job override
     (both live on the row) > the Employee record (the agent page's
     "Default model"/"Default effort", #872 — the one source of an agent's
     default) > the sessionParamsFor pin > the runtime's own default (its
     advertised currentValue). Nothing else: the old `codingAgents` KV is
     no longer read. The employee's effort is a rung on ITS model's ladder,
     so it rides only when the session runs that model. */
  const model = conv?.model ?? (employee?.model || undefined) ?? base.model;
  const ownModel = !conv?.model || conv.model === employee?.model;
  const provider = conv?.provider ?? base.provider;
  const effort =
    conv?.effort ??
    (ownModel ? employee?.effort || undefined : undefined) ??
    base.effort;
  const fast = conv?.fast ?? base.fast;
  // D-#113: a thread owns its folder through its project — the folder is
  // the conversation's `cwd` (`conversations.open { cwd }`, stored nullable
  // on the relay row), and the relay files it under the project whose
  // folder contains it, if one exists (D-#854: a folder is never made a
  // project on a thread's behalf). The engine gets it as `cwd` on
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

type CatalogRow = { id: string; name?: string; provider?: string };

/* One `models.list` per runtime, the answer cached as a promise so
   concurrent callers share it. */
function fetchCatalog(
  ctx: HarnessCtx,
  runtime: string,
): Promise<readonly CatalogRow[]> {
  const rows = (async () => {
    const conn =
      ctx.connForRuntime(runtime) ?? (await ctx.ensureRuntime(runtime));
    if (!conn) return [];
    const r = await conn.request<{ models?: CatalogRow[] }>("models.list", {});
    return r.models ?? [];
  })().catch(() => []);
  ctx.modelCatalogs.set(runtime, rows);
  return rows;
}

/* #872 — `task_create`'s explicit model is checked against the CHILD
   agent's own runtime catalog: a name only the parent's engine knows
   throws here, never silently starts on the wrong runtime. The answer is
   the catalog's own id/provider (a display name resolves to its id) —
   matched on id AND provider, since Hermes ids are per provider (D-#8).
   A cached catalog that is empty or lacks the pick is asked again once
   (it may have been unreachable, or grown since), so neither a stale nor
   an empty first answer settles the check for good. A runtime whose
   catalog cannot be listed passes the pick through raw — the engine itself
   then accepts or rejects it. */
export async function checkTaskModel(
  this: HarnessCtx,
  employee: Employee,
  model: string,
  provider?: string,
): Promise<{ model: string; provider?: string }> {
  const runtime = normalizeRuntime(employee.runtime);
  const find = (list: readonly CatalogRow[]) =>
    list.find(
      (m) =>
        (m.id === model || m.name === model) &&
        (!provider || !m.provider || m.provider === provider),
    );
  let list = await (this.modelCatalogs.get(runtime) ??
    fetchCatalog(this, runtime));
  let hit = find(list);
  if (!hit) {
    list = await fetchCatalog(this, runtime);
    hit = find(list);
  }
  if (!list.length) return { model, ...(provider ? { provider } : {}) };
  if (!hit) {
    const named = list.find((m) => m.id === model || m.name === model);
    throw new Error(
      named
        ? `"${model}" runs on provider "${named.provider}" for ${employee.name}, not "${provider}"`
        : `model "${model}" isn't one of ${employee.name}'s models — its runtime offers: ${list
            .slice(0, 6)
            .map((m) => m.name ?? m.id)
            .join(", ")}`,
    );
  }
  const chosen = hit.provider ?? provider;
  return { model: hit.id, ...(chosen ? { provider: chosen } : {}) };
}
