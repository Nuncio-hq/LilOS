import { approvalAskMarks, approvalAskSection } from "./approval-tools.js";

/**
 * Guide page: employees (#340 AC-3).
 *
 * Hiring and editing open an approval ask (`team_hire`, `team_update`).
 * The page used to say that gate ships separately (D-#36, #783). The
 * names, and every other approval tool, come from `LILOS_TOOLS` where
 * `access === "approval"`.
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
- Hiring and editing your own record open an approval ask:
  ${approvalAskMarks("team")}.
  The call waits, and nothing is written until Oscar approves. Removing an
  employee is done in the app.

${approvalAskSection()}`,
};
