import type { Employee } from "@lilos/contracts/app";
import { HIRE_TEMPLATES } from "@lilos/ui";
import type { HireDraft } from "@lilos/ui/types";
import { relay } from "./runtime";

/* Hiring for the real app (#115). The wire methods already exist on the
   relay — this module is the app's share of the flow: the one hire list
   (cards and soul text, `HIRE_TEMPLATES`) and the create/link + DM-open
   sequence a hire needs. The page receives that same list as data. */

export { HIRE_TEMPLATES };

/**
 * Engine profile ids are lowercase slugs (Hermes: letters, numbers, `-`/`_`,
 * leading alnum, ≤64 chars); the employee keeps the display name the user typed.
 */
const profileSlug = (name: string): string =>
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
      /* `{provider?, id}` — the id may itself contain `/` (#92 AC-8). */
      ...(d.provider ? { provider: d.provider } : {}),
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
