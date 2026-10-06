import type { Conversation, Employee } from "@lilos/contracts/app";
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

export function sessionParams(
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
  // A pick pinned on the conversation (#30/#92) wins over the profile
  // default — each field falls back independently so a bare `model` pin
  // (old rows) still resolves its provider/effort on the engine.
  const model = conv?.model ?? base.model;
  const provider = conv?.provider ?? base.provider;
  const effort = conv?.effort ?? base.effort;
  const fast = conv?.fast ?? base.fast;
  // The session's folder is owned by the conversation (#113); absent → the
  // harness default workdir, as before.
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
