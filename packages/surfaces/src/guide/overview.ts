/**
 * Guide page: what LilOS is, at a glance (#340 AC-3).
 * Ships in the app bundle — `lilos_guide` serves it verbatim.
 */
export const overview = {
  title: "LilOS overview",
  body: `LilOS is a CompanyOS where the employees are AI agents and the app is
the shared workplace.

What Oscar sees:
- One desktop window: a sidebar (channels, projects, employees), threads in
  the middle, and a Workbench panel that opens when a session is focused.
- Employees in the roster are agents running on the installed engine; Oscar
  talks to one by starting a thread with it.
- A thread is one engine session with one agent: it has a title, a model and
  its own terminal/browser/workbench surfaces. It lives in a project — a
  folder the company works in — or is a plain chat with no folder.

Tools that apply:
- \`context\` — who and where the calling session is right now.
- \`guide\` — this documentation (call with a topic for a page).
- \`team_list\` — the company roster.
- \`project_list\` — the company's projects (folders).
- Everything else hangs off the session's surfaces: \`thread_*\` (your
  threads), \`project_*\`, \`workbench_*\`, \`browser_*\`, \`terminal_*\`.`,
};
