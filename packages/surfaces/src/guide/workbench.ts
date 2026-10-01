/**
 * Guide page: the Workbench (#340 AC-3).
 */
export const workbench = {
  title: "The Workbench",
  body: `The Workbench is the right-hand panel of a focused session — where
Oscar watches the session's real work surfaces live.

What Oscar sees:
- Tabs: Files (the session folder's tree), Changes (live git diff), PR,
  Preview/Browser (the session's own browser), Terminal (its real PTY),
  Background (jobs and delegated helpers), Plan, Subagents.
- The terminal and preview are the session's actual processes — a keystroke
  into the Workbench terminal takes it over (agent calls report user-control
  until he hands it back).

Tools that apply:
- \`workbench_previews\` — dev-server preview URLs the Workbench knows
  (scanned terminal output + PREVIEW: markers).
- \`workbench_open\` — put the panel on a target: \`{file, line?}\` opens the
  file, \`{diff, path?}\` opens Changes filtered to the path, \`{pr}\` opens
  the PR tab, \`{url}\` opens Preview and points the session browser at it.
  It shows inside the app — it never opens an editor on the Mac.
- \`terminal_*\` and \`browser_*\` drive the same surfaces Oscar watches.`,
};
