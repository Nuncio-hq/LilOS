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
export const HOST_POLICY_VERSION = 5;
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
  "folder",
  "project",
  "schedule",
];

const AREA_LINES: Record<ToolArea, string> = {
  root: "- `context`/`guide`/`ask`: read first; `ask` waits (`why`, `ifYes`, `ifNo`).",
  thread:
    "- `thread_*`: your threads with the user — `thread_read`/`thread_search`/`thread_list`/`thread_prs` to look around, `thread_post` to answer, `thread_set_title` to retitle yours while its title is auto, `thread_start` to ask for a new thread. Posting lands a real message; it is always allowed here and never possible in anyone else's thread.",
  team: "- `team_*`: the roster — `team_list` reads; `team_hire` and `team_update` (your own record only) ask the user to approve.",
  folder:
    "- `folder_*`: `folder_add` asks the user to add a folder you name to the recents.",
  project:
    "- `project_*`: the company's folders — `project_list` reads; `project_create` asks the user to approve.",
  schedule:
    "- `schedule_*`: your scheduled tasks — `schedule_list` reads; writes ask the user to approve.",
  workbench:
    "- `workbench_*`: the user's Workbench — `workbench_previews` lists your preview servers, `workbench_open` puts the panel on the Files/Changes/PR/Preview tab you name (it never opens an editor on the Mac).",
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
    "LilOS's own state is off-limits: never open `~/.lilos` (its relay database holds other employees' conversations, not your company's answers) — the `lilos_*` tools are your only view of the app.",
    "Files, edits, and git go through your engine's own tools in the session folder; LilOS tools are for the app, not the codebase.",
  ];
  return lines.join("\n");
}
