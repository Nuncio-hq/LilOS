import {
  LILOS_TOOLS,
  TOOL_AREAS,
  type ToolArea,
} from "@lilos/contracts/harness";

/**
 * Guide page: the Agent Gateway itself (#340 AC-3).
 *
 * The tool list is rendered from `LILOS_TOOLS` / `TOOL_AREAS` (D-#36, #754).
 * A hand-written list drifted: the approval writes (#341) and the schedule
 * tools (#136) never appeared, so `guide` topic `gateway` taught a catalog
 * the code no longer has.
 *
 * Which areas a session actually has is decided in SessionSurfaces
 * (`scope.ts`): `root`, `terminal` and `workbench` always; `browser` when
 * one can launch; `thread`, `team`, `folder`, `project`, `ticket`, `goal`
 * and `schedule` on a
 * session bound to an employee's thread. The closing sentence states that.
 * The names above it come from the catalog, not from this sentence.
 */
function renderGatewayTools(): string {
  const grouped = new Map<ToolArea, { name: string; approval: boolean }[]>(
    TOOL_AREAS.map((area) => [area, []]),
  );
  for (const [name, tool] of Object.entries(LILOS_TOOLS)) {
    const row = grouped.get(tool.area);
    if (!row) {
      throw new Error(
        `gateway guide: ${name} area "${tool.area}" is not in TOOL_AREAS`,
      );
    }
    row.push({ name, approval: tool.access === "approval" });
  }

  const lines = [
    "Tools that apply — rendered from the catalog, one line per area:",
  ];
  const approvals: string[] = [];
  for (const [area, tools] of grouped) {
    const parts = tools.map((tool) => {
      if (!tool.approval) return `\`${tool.name}\``;
      approvals.push(tool.name);
      return `\`${tool.name}\` (opens an approval ask)`;
    });
    lines.push(`- \`${area}\`: ${parts.join(", ") || "(none)"}`);
  }
  const listed = approvals.map((name) => `\`${name}\``).join(", ");
  lines.push(
    "",
    listed
      ? `These tools open an approval ask — the call waits, and nothing is written until Oscar approves: ${listed}.`
      : "No tool opens an approval ask.",
  );
  return lines.join("\n");
}

export const gateway = {
  title: "The Agent Gateway",
  body: `The Agent Gateway is how employees use LilOS: one tool catalog
declared in contracts, served per session over HTTP (\`POST /tools/<name>\`),
MCP (streamable HTTP + \`lilos mcp\` stdio), the \`lilos\` CLI and the engine's
own plugin (Hermes shows them as \`lilos_*\`).

What Oscar sees:
- Employees answering from real app state — the roster, their threads, the
  projects, the Workbench — not from hallucinated URLs or ids.
- Every session's tools are scoped to its own surfaces: the bearer token is
  the identity, and an agent can never address another session's browser,
  terminal or thread.
- Each session gets a short host policy (versioned, rendered from its
  attached areas) inside its MCP initialize result and prompt.

${renderGatewayTools()}

\`ask\` waits until the user answers. Optional \`why\`, \`ifYes\` and \`ifNo\` are the lines Needs you shows for that ask. An engine approval keeps its command and does not use them.

A session only sees the areas it has attached: \`root\`, \`terminal\` and
\`workbench\` always; \`browser\` when a browser can launch; \`thread\`,
\`team\`, \`folder\`, \`project\`, \`ticket\`, \`goal\` and \`schedule\` when the session is bound
to an employee's thread.`,
};
