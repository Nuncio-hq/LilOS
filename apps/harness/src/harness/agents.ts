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
     on the row) > the stored per-agent default (the codingAgents KV,
     D-#835) > the employee/sessionParamsFor pin > the agent's own default
     (its advertised currentValue). The KV holds model + effort only;
     provider and fast keep their existing sources. */
  const stored = await this.codingAgentDefaults(employee);
  // A pick pinned on the conversation (#30/#92) wins over the profile
  // default — each field falls back independently so a bare `model` pin
  // (old rows) still resolves its provider/effort on the engine.
  const model = conv?.model ?? stored?.model ?? base.model;
  const provider = conv?.provider ?? base.provider;
  const effort = conv?.effort ?? stored?.effort ?? base.effort;
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
    ...(mcpServer ? { mcpServers: [mcpServer] } : {}),
  };
}
