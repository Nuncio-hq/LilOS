import type { Employee } from "@lilos/contracts/app";
import type { EngineProfile, HireDraft } from "@lilos/ui/types";
import { relay } from "./runtime";

/* Hire/edit/remove for the real app (#115). The dialogs live in @lilos/ui; the
   wire methods already exist on the relay — this module is the app's share of
   the flow: starter templates, the engine profile roster for the picker, and
   the create/link + DM-open sequence a hire needs. */

/**
 * Starter personas for Hire → New profile (LilOS starter content, moved here
 * from the prototype). `model: ""` means the engine's default — the app
 * resolves it against the live `models.list` catalog when the dialog opens
 * (D-#85: the engine owns defaults; LilOS stores none).
 */
export const HIRE_TEMPLATES: HireDraft[] = [
  {
    name: "Engineer",
    role: "Engineer",
    model: "",
    instructions:
      "You are a full-stack engineer. Work only on assigned tickets, on a branch. Run checks before reporting. Report scope creep instead of expanding.",
  },
  {
    name: "Reviewer",
    role: "QA",
    model: "",
    instructions:
      "You review changes for correctness, tests and boundaries. Comment with file:line. Never push to main.",
  },
  {
    name: "Researcher",
    role: "Research",
    model: "",
    instructions:
      "You research questions with cited sources and a one-paragraph answer first.",
  },
  {
    name: "Marketer",
    role: "Growth",
    model: "",
    instructions:
      "You write marketing copy and plans in the founder's voice: plain, specific, no hype.",
  },
];

/**
 * Engine profiles for the "Use profile" list. `agents.list` rows are light —
 * the soul preview needs one `agents.describe` per agent. A profile the
 * engine stopped describing still lists, just without its preview.
 */
export async function listHirableProfiles(): Promise<EngineProfile[]> {
  const agents = await relay.listAgents();
  return await Promise.all(
    agents.map(async (a) => {
      const full = await relay.describeAgent(a.id).catch(() => a);
      return {
        id: a.id,
        name: full.name ?? a.name,
        model: full.model ?? a.model ?? "",
        soul: full.soul ?? "",
        skills: full.skillCount ?? a.skillCount ?? 0,
      };
    }),
  );
}

/**
 * Engine profile ids are lowercase slugs (Hermes: letters, numbers, `-`/`_`,
 * leading alnum, ≤64 chars); the employee keeps the display name the user typed.
 */
export const profileSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+|[-_]+$/g, "")
    .slice(0, 64);

/**
 * Hire a draft onto the roster. `profile` links an existing engine profile;
 * null creates one on the engine first (`agents.create` with the slug, not
 * the display name) — LilOS never owns or deletes profiles (D-#29). The DM
 * channel opens up front so the new employee's DM renders ready instead of a
 * perpetual skeleton (AC-5). An engine rejection propagates before anything
 * is created.
 */
export async function hireEmployee(
  d: HireDraft,
  profile: string | null,
): Promise<Employee> {
  let profileId = profile;
  if (profileId === null) {
    const agent = await relay.createAgent({
      name: profileSlug(d.name),
      ...(d.instructions ? { soul: d.instructions } : {}),
      ...(d.model ? { model: d.model } : {}),
    });
    profileId = agent.id;
  }
  const employee = await relay.createEmployee({
    name: d.name.trim(),
    role: d.role.trim(),
    status: "online",
    profile: profileId,
    model: d.model,
    instructions: d.instructions,
  });
  await relay.request("channels.openDm", { employeeId: employee.id });
  return employee;
}

/** Edit in this slice = display name + role on the company record. */
export async function saveEmployee(
  id: string,
  name: string,
  role: string,
): Promise<void> {
  await relay.updateEmployee(id, { name, role });
}

/**
 * Remove deletes the LilOS record and its DM channel/conversations — never
 * the engine profile (D-#29); there is no profile-delete call anywhere.
 */
export async function removeEmployee(id: string): Promise<void> {
  await relay.removeEmployee(id);
}
