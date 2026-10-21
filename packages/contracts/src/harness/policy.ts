import { CEO_INSTRUCTIONS } from "./ceo.js";
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
 * engine context. v9 keeps v8's areas (ticket, goal) and appends the CEO
 * brief (D-#778). Wording is shorter so that brief still fits; every v8
 * rule is still here. The `team` line does not name CEO-only tools
 * (`team_set_ceo`, `ticket_assign`): a session that does not hold the
 * position must not hear about them.
 */
export const HOST_POLICY_VERSION = 9;
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
  "ticket",
  "goal",
  "schedule",
];

const AREA_LINES: Record<ToolArea, string> = {
  /* `ask` asks the user and waits (D-#773). It is not something to read
     first — that is only `context` and `guide`. */
  root: [
    "- `context`/`guide`: who and where this session is, and how LilOS works — read them first.",
    "- `ask`: ask the user and wait (`why`, `ifYes`, `ifNo`).",
  ].join("\n"),
  thread:
    "- `thread_*`: your threads — `thread_read`/`thread_search`/`thread_list`/`thread_prs`, `thread_post` to answer, `thread_set_title` to retitle yours while its title is auto, `thread_start` to ask for a new thread. Posting is a real message, allowed here, never in another thread.",
  /* Hiring stays on this line: every agent may propose it, and it still
     asks the owner (D-#341). `team_set_ceo` is CEO-only, so it is not
     named here — a non-CEO session would otherwise hear about a tool it
     is not offered (D-#778). */
  team: "- `team_*`: the roster — `team_list` reads; `team_hire` and `team_update` (your own record only) ask the user to approve.",
  folder:
    "- `folder_*`: `folder_add` asks the user to add a folder you name to the recents.",
  project:
    "- `project_*`: the company's folders — `project_list` reads; `project_create` asks the user to approve.",
  /* D-#776: ticket writes do not ask (#746). goal_create always asks
     (D-#341). `ticket_assign` is CEO-only and is not named: non-CEO
     sessions do not hear about it (D-#778). */
  ticket: "- `ticket_*`: company tickets. Writes do not ask.",
  goal: "- `goal_*`: company goals. `goal_create` asks.",
  schedule:
    "- `schedule_*`: your scheduled tasks — `schedule_list` reads; writes ask the user to approve.",
  workbench:
    "- `workbench_*`: `workbench_previews` lists your preview servers; `workbench_open` opens the Files, Changes, PR, or Preview tab you name, never an editor on the Mac.",
  browser:
    "- `browser_*`: the session's own browser, shared with the user's Workbench — the only browser you may use for web pages.",
  terminal:
    "- `terminal_*`: the session's shell in its working folder — runs commands the user can watch live.",
};

export function renderHostPolicy(
  areas: ReadonlySet<ToolArea>,
  /* `ceo` appends the position's brief. Only a session that held the
     position at start passes it (D-#778). */
  opts?: { ceo?: boolean },
): string {
  const lines = [
    HOST_POLICY_MARKER,
    "You are an employee in LilOS. These tools are your only way to read or act, and they never touch another session.",
    ...TOOL_AREA_ORDER.filter((a) => areas.has(a)).map((a) => AREA_LINES[a]),
    "Reading is always allowed. Changes beyond your own thread — new threads, hiring, merging — need an approval: propose them, never push them through.",
    "Never open `~/.lilos` — the `lilos_*` tools are your only view of its state.",
    "Files, edits, and git use your engine's tools in the session folder; LilOS tools are for the app, not the codebase.",
    ...(opts?.ceo ? [CEO_INSTRUCTIONS] : []),
  ];
  return lines.join("\n");
}
