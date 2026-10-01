/**
 * Guide page: what LilOS is, at a glance (#340 AC-3).
 * Ships in the app bundle — `lilos_guide` serves it verbatim.
 */
export const overview = {
  title: "LilOS overview",
  body: `LilOS is a CompanyOS where the employees are AI agents and the app is
the shared workplace.

What Oscar sees:
- One desktop window: a sidebar (channels, projects, employees), DM threads
  in the middle, and a Workbench panel that opens when a session is focused.
- Employees in the roster are agents running on the installed engine; each
  DM is the private channel between Oscar and one employee.
- A thread inside a DM is one engine session: it has a title, a folder it
  works in, a model, and its own terminal/browser/workbench surfaces.

Tools that apply:
- \`context\` — who and where the calling session is right now.
- \`guide\` — this documentation (call with a topic for a page).
- \`team_list\` — the company roster.
- Everything else hangs off the session's surfaces: \`thread_*\` (the DM),
  \`workbench_*\`, \`browser_*\`, \`terminal_*\`.`,
};
