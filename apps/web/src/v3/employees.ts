import type { EmployeePatch } from "@lilos/contracts/app";
import type { V3AgentPatch, V3Profile } from "@lilos/ui";
import { hireEmployee } from "../lib/employees";
import { engine, relay } from "../lib/runtime";
import { refreshScheduledTasks } from "../lib/schedules";
import { modelLabel, pickFromLabel } from "./models";
import { noteProfile, updatableOf } from "./profiles";
import { defaultRuntimeId, pickForRuntime } from "./runtimes";

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
  /* #872 — everything engine-side routes to the runtime that owns the
     profile (D-#761): a Devin agent's description/model land on acp:devin,
     never silently on Hermes, and the fields it may write are that
     runtime's own `updatable` — absent means read-only, not a try that
     fails. */
  const runtime =
    employee.runtime && employee.runtime !== defaultRuntimeId()
      ? employee.runtime
      : undefined;
  const row = runtime
    ? relay.status.get()?.result?.runtimes?.find((r) => r.id === runtime)
    : undefined;
  const can = new Set(
    runtime
      ? (row?.agentsUpdatable ?? [])
      : updatableOf(engine.description.get()),
  );
  /* #872 — never fake Saved: a field the owning engine must take but
     hasn't declared writable (or hasn't reported yet) is a loud error,
     not a silent drop. Record-owned fields (name, mute, effort, skills)
     never reach this gate — they persist below either way. */
  const engineField = (
    flag: "description" | "soul" | "model",
    what: string,
  ) => {
    if (can.has(flag)) return;
    if (runtime && row?.state === "failed")
      throw new Error(
        `${row.label ?? "The engine"} isn't running${row.detail ? ` — ${row.detail}` : ""}`,
      );
    if (runtime && row?.agentsUpdatable === undefined)
      throw new Error(
        `${row?.label ?? "The engine"} hasn't said what it can change yet — try again in a moment.`,
      );
    if (!runtime && engine.description.get() === undefined)
      throw new Error(
        "The engine hasn't said what it can change yet — try again in a moment.",
      );
    throw new Error(
      `${row?.label ?? "This engine"} doesn't let LilOS change ${what}.`,
    );
  };
  if (patch.description !== undefined)
    engineField("description", "the description");
  if (patch.instructions !== undefined) engineField("soul", "the instructions");
  // The page shows a model by its picker label; the engine wants its id and
  // provider. A label that names no catalog model has nothing to write.
  const pick =
    patch.model === undefined
      ? undefined
      : runtime
        ? pickForRuntime(runtime, patch.model)
        : pickFromLabel(patch.model);
  if (patch.model !== undefined) {
    if (!can.has("model")) engineField("model", "the model");
    else if (!pick)
      throw new Error(
        `"${patch.model}" isn't in ${row?.label ?? "the engine"}'s model list.`,
      );
  }
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
    const r = await relay.updateAgent({
      id: employee.profile,
      ...(runtime ? { runtime } : {}),
      ...engineEdit,
    });
    noteProfile(employee.profile, runtime, r.agent);
    confirmModel = r.confirmModel;
  }
  const record: EmployeePatch = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.role !== undefined ? { role: patch.role } : {}),
    ...(patch.muted !== undefined ? { muted: patch.muted } : {}),
    ...("soul" in engineEdit ? { instructions: patch.instructions } : {}),
    /* #872: the description's durable home is the record — an engine whose
       personas live in memory (ACP rosters) re-seeds from it on restart. */
    ...("description" in engineEdit ? { description: patch.description } : {}),
    // A held model is not pinned yet: the record keeps the old one.
    /* #872: a model change clears the effort pin — a level named for the
       old model's ladder may not exist on the new one. */
    ...("model" in engineEdit && !confirmModel
      ? { model: engineEdit.model, effort: "" }
      : {}),
    /* The effort pin is the relay record's own (every runtime's sessions
       read it at start, D-#846) — no engine write, no updatable flag. */
    ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
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
  /* A seed row for an unstarted runtime is already complete enough to
     hire from — describing it would launch (maybe npm-install) the engine
     just because the dialog opened (D-#866). Only a runtime already up
     earns the describe. */
  const rows = relay.status.get()?.result?.runtimes ?? [];
  const defaultId = rows[0]?.id;
  const describable = (runtime?: string): boolean => {
    if (!runtime || runtime === defaultId) return true;
    const row = rows.find((r) => r.id === runtime);
    return (
      !!row &&
      (row.state === "running" ||
        row.state === "starting" ||
        row.state === "restarting")
    );
  };
  return await Promise.all(
    agents.map(async (a) => {
      // The merged roster stamps the runtime the profile lives on (D-#761).
      const full = describable(a.runtime)
        ? await relay.describeAgent(a.id, a.runtime).catch(() => a)
        : a;
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
  /** The profile row's own description — used when the runtime can't be
     asked (idle runtimes are never started just to hire, D-#866). */
  description?: string;
}): Promise<string> {
  /* The describe lands only when the runtime is already up — hiring an
     idle coding runtime's seed must not launch it (D-#866); the seed
     row's own description/model mirror onto the record either way. */
  const rows = relay.status.get()?.result?.runtimes ?? [];
  const row = rows.find((r) => r.id === p.runtime);
  const live =
    row &&
    (row.state === "running" ||
      row.state === "starting" ||
      row.state === "restarting");
  const agent =
    !p.runtime || p.runtime === rows[0]?.id || live
      ? await relay.describeAgent(p.profile, p.runtime).catch(() => undefined)
      : undefined;
  const employee = await hireEmployee(
    {
      name: p.name,
      role: p.role,
      model: agent?.model ?? "",
      instructions: agent?.soul ?? "",
      ...((agent?.description ?? p.description)
        ? { description: agent?.description ?? p.description }
        : {}),
    },
    p.profile,
    p.runtime,
  );
  return employee.id;
}
