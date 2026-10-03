/**
 * Guide page: employees (#340 AC-3).
 */
export const employees = {
  title: "Employees",
  body: `Employees are the agents on the company roster — each is a LilOS
record (name, role, status, engine profile, model) backed by an engine
agent profile.

What Oscar sees:
- The sidebar roster: name, role line, status orb (online/busy/offline) and
  the model each employee runs on.
- Hiring/editing happens in the app (Hire dialog, Edit employee): it writes
  the LilOS record and the engine profile together.
- Removing an employee deletes its DMs and record; the engine profile is
  never deleted by LilOS.

Tools that apply:
- \`team_list\` — the roster as the agent sees it: name, role, status, model.
- \`context\` — the calling session's own employee record (name, role,
  profile, model) plus its thread.
- Hiring, editing and removing are company changes — they go through an
  approval, not a plain tool call (the approval gate ships separately).`,
};
