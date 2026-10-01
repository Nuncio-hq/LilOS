import type { ToolArea } from "./tools.js";

/**
 * The host policy (issue #337 AC-5): the one short ruleset every engine
 * session reads, rendered from the session's attached tool areas so it never
 * describes a surface the session doesn't have. The gateway hands it to the
 * engine in the MCP `initialize` result's `instructions`, and the harness
 * prepends it to the session prompt.
 *
 * Versioned (`[LilOS host policy vN]`) — bump N when the rules change so a
 * stale prompt is diagnosable. Kept under 2000 chars: it rides in every
 * engine context.
 */
export const HOST_POLICY_VERSION = 1;
export const HOST_POLICY_MAX_CHARS = 2000;
export const HOST_POLICY_MARKER = `[LilOS host policy v${HOST_POLICY_VERSION}]`;

/* Render order for the policy bullets: root tools first, session workhorses
   (terminal/browser) before the reading tools. */
const TOOL_AREA_ORDER: readonly ToolArea[] = [
  "root",
  "thread",
  "team",
  "terminal",
  "browser",
  "workbench",
];

const AREA_LINES: Record<ToolArea, string> = {
  root: "- `context`/`guide`: who and where this session is, and how LilOS works — read them first.",
  thread:
    "- `thread_*`: your own DM thread with the user — `thread_read` to read it, `thread_post` to answer. Posting lands a real message; it is always allowed here and never possible in anyone else's thread.",
  team: "- `team_*`: the company roster — who else works here.",
  workbench:
    "- `workbench_*`: what the user's Workbench shows for this session — preview servers your terminal started.",
  browser:
    "- `browser_*`: the session's own browser, shared with the user's Workbench — the only browser you may use for web pages.",
  terminal:
    "- `terminal_*`: the session's shell in its working folder — runs commands the user can watch live.",
};

export function renderHostPolicy(areas: ReadonlySet<ToolArea>): string {
  const lines = [
    HOST_POLICY_MARKER,
    "You are an employee inside LilOS — the app is the shared workplace, and these tools are your only way to read or act on it. They are bound to your own session: they can never touch another session's surfaces.",
    ...TOOL_AREA_ORDER.filter((a) => areas.has(a)).map((a) => AREA_LINES[a]),
    "Reading is always allowed. Anything that changes the company beyond your own thread — opening threads, hiring, merging — goes through an approval: propose it, never push it through.",
    "Files, edits, and git go through your own engine tools inside the session folder; LilOS tools are for the app surface, not the codebase.",
  ];
  return lines.join("\n");
}
