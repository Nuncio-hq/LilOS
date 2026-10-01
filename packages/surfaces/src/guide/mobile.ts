/**
 * Guide page: the mobile app (#340 AC-3).
 */
export const mobile = {
  title: "LilOS on the phone",
  body: `The paired iPhone app mirrors the DM: same threads, messages, asks
and turn stream — through the relay, not the desktop's screen.

What Oscar sees:
- The same DM thread list and messages as on the desktop, plus live turns
  reduced from the engine event stream.
- Approvals and plan reviews as tappable cards; thread info (folder, branch,
  model, context meter, PRs, background jobs) in the Session sheet.
- When an employee calls \`workbench_open\`, the phone can't open a desktop
  panel — the thread shows a tappable card that opens the same thing
  (the diff view, the PR list, or the URL in the browser).

Tools that apply:
- Every DM tool works identically (\`thread_*\`, \`context\`, \`team_list\`,
  \`guide\`) — the phone is another client of the same session.
- \`workbench_open\` is the one whose rendering differs: a thread card on the
  phone, the Workbench panel on the desktop.`,
};
