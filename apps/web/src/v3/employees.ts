import type { EmployeePatch } from "@lilos/contracts/app";
import type { V3AgentPatch, V3Profile } from "@lilos/ui";
import { hireEmployee } from "../lib/employees";
import { engine, relay } from "../lib/runtime";
import { refreshScheduledTasks } from "../lib/schedules";
import { modelLabel, pickFromLabel } from "./models";
import { noteProfile, updatableOf } from "./profiles";

/* Hire-from-profile, edit and remove for the real app (the calls the pre-v3
   Hire and Edit dialogs made). The company record (name, role, mute) always
   saves; the profile fields (name mirror, persona, description, model) only
   where the engine's `agents` capability lists them under `detail.updatable`
   (D-#19), and the page offers exactly those. */

/**
 * Save an edit: the engine write lands first (`agents.update` on the
 * employee's profile), then the company record follows once it sticks — its
 * `model`/`instructions` mirror the profile because the harness reads
 * `employee.model` when a new session starts, and the per-session model
 * picker (#30/#92) still overrides it on that session. A running session is
 * untouched.
 *
 * An engine may hold a guarded model back behind a confirm: the reply then
 * carries `confirmModel` (the engine's own words). Everything else already
 * applied; only the model is left, and the caller sends it again alone with
 * `confirmModel: true`.
 */
export async function saveAgent(
  id: string,
  patch: V3AgentPatch,
): Promise<{ confirmModel?: string } | undefined> {
  const employee = relay.employees.get().find((e) => e.id === id);
  if (!employee) throw new Error("This agent is no longer on the team");
  const can = new Set(updatableOf(engine.description.get()));
  // The page shows a model by its picker label; the engine wants its id and
  // provider. A label that names no catalog model has nothing to write.
  const pick =
    patch.model === undefined ? undefined : pickFromLabel(patch.model);
  const engineEdit = {
    ...(patch.name !== undefined && can.has("name")
      ? { name: patch.name }
      : {}),
    ...(patch.instructions !== undefined && can.has("soul")
      ? { soul: patch.instructions }
      : {}),
    ...(patch.description !== undefined && can.has("description")
      ? { description: patch.description }
      : {}),
    ...(pick && can.has("model")
      ? {
          model: pick.model,
          ...(pick.provider ? { provider: pick.provider } : {}),
          ...(patch.confirmModel ? { confirmModel: true } : {}),
        }
      : {}),
  };
  let confirmModel: string | undefined;
  if (employee.profile && Object.keys(engineEdit).length > 0) {
    const r = await relay.updateAgent({ id: employee.profile, ...engineEdit });
    noteProfile(employee.profile, r.agent);
    confirmModel = r.confirmModel;
  }
  const record: EmployeePatch = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.role !== undefined ? { role: patch.role } : {}),
    ...(patch.muted !== undefined ? { muted: patch.muted } : {}),
    ...("soul" in engineEdit ? { instructions: patch.instructions } : {}),
    // A held model is not pinned yet: the record keeps the old one.
    ...("model" in engineEdit && !confirmModel
      ? { model: engineEdit.model }
      : {}),
  };
  if (Object.keys(record).length > 0) await relay.updateEmployee(id, record);
  return confirmModel ? { confirmModel } : undefined;
}

/**
 * Remove deletes the LilOS record and its channel, conversations and
 * scheduled tasks — never the engine profile (D-#29); there is no
 * profile-delete call anywhere. The relay broadcasts the removed record and
 * channels but not the tasks it deleted with them, so the app's copy of the
 * schedules is read again.
 */
export async function removeAgent(id: string): Promise<void> {
  await relay.removeEmployee(id);
  await refreshScheduledTasks().catch(() => {});
}

/**
 * The engine's profiles, for the Hire page's "existing profile" section.
 * `agents.list` rows are light, so the persona and skill count take one
 * `agents.describe` per profile; a profile the engine stopped describing
 * still lists, just without its persona. The page hides the ones an agent
 * already runs on, so this is every profile the engine has.
 */
export async function listHirableProfiles(): Promise<V3Profile[]> {
  const agents = await relay.listAgents();
  return await Promise.all(
    agents.map(async (a) => {
      const full = await relay.describeAgent(a.id).catch(() => a);
      const model = full.model ?? a.model;
      const description = full.description ?? a.description;
      return {
        id: a.id,
        name: full.name ?? a.name,
        ...(description ? { description } : {}),
        ...(model ? { model: modelLabel(model) } : {}),
        skills: full.skillCount ?? a.skillCount ?? 0,
        ...(full.soul ? { soul: full.soul } : {}),
        /* The merged roster stamps which runtime lists the profile; a
           coding runtime's row hires there, not onto the default. */
        ...(a.runtime ? { runtime: a.runtime } : {}),
      };
    }),
  );
}

/**
 * Hire onto a profile the engine already has: the company record links it
 * (no `agents.create`) and mirrors its model and persona, which the engine
 * keeps owning — the profile itself is never written (D-#29).
 */
export async function hireFromProfile(p: {
  profile: string;
  name: string;
  role: string;
  runtime?: string;
}): Promise<string> {
  const agent = await relay
    .describeAgent(p.profile, p.runtime)
    .catch(() => undefined);
  const employee = await hireEmployee(
    {
      name: p.name,
      role: p.role,
      model: agent?.model ?? "",
      instructions: agent?.soul ?? "",
    },
    p.profile,
    p.runtime,
  );
  return employee.id;
}
