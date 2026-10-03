/**
 * Guide page: the Agent Gateway itself (#340 AC-3).
 */
export const gateway = {
  title: "The Agent Gateway",
  body: `The Agent Gateway is how employees use LilOS: one tool catalog
declared in contracts, served per session over HTTP (\`POST /tools/<name>\`),
MCP (streamable HTTP + \`lilos mcp\` stdio), the \`lilos\` CLI and the engine's
own plugin (Hermes shows them as \`lilos_*\`).

What Oscar sees:
- Employees answering from real app state — the roster, the DM's threads,
  the Workbench — not from hallucinated URLs or ids.
- Every session's tools are scoped to its own surfaces: the bearer token is
  the identity, and an agent can never address another session's browser,
  terminal or thread.
- Each session gets a short host policy (versioned, rendered from its
  attached areas) inside its MCP initialize result and prompt.

Tools that apply:
- The catalog: \`context\`, \`guide\`, \`team_list\`, \`thread_read\`,
  \`thread_post\`, \`thread_list\`, \`thread_search\`, \`thread_set_title\`,
  \`thread_prs\`, \`workbench_open\`, \`workbench_previews\`, \`browser_*\`,
  \`terminal_*\` — filtered to the session's attached areas.
- Areas attach per session: \`root\` always, \`thread\`/\`team\` on a DM
  binding, \`browser\` when a browser can launch, \`terminal\`/\`workbench\`
  always.`,
};
