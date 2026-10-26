import type { ToolArea } from "./tools.js";

/**
 * The host policy (issue #337 AC-5): the one short ruleset every engine
 * session reads, rendered from the session's attached tool areas so it never
 * describes a surface the session doesn't have. The gateway hands it to the
 * engine in the MCP `initialize` result's `instructions`, and the harness
 * prepends it to the session prompt.
 *
 * Versioned (`[LilOS host policy vN]`) — bump N when the rules change so a
 * stale prompt is diagnosable. Kept short: it rides in every engine
 * context — the cap moved to 2200 when v11 added the `task` area
 * (D-#844); v10 added `coding` (D-#835). The CEO brief is not in this
 * text: it has its own section and its own cap (D-#777). The `team` line
 * does not name CEO-only tools (`team_set_ceo`, `ticket_assign`,
 * `update_post`): a session that does not hold the position must not
 * hear about them.
 */
export const HOST_POLICY_VERSION = 11;
export const HOST_POLICY_MAX_CHARS = 2200;
export const HOST_POLICY_MARKER = `[LilOS host policy v${HOST_POLICY_VERSION}]`;

/* Render order for the policy bullets: root tools first, session workhorses
   (terminal/browser) before the reading tools. */
const TOOL_AREA_ORDER: readonly ToolArea[] = [
  "root",
  "thread",
  "task",
  "team",
  "terminal",
  "browser",
  "workbench",
  "folder",
  "project",
  "ticket",
  "goal",
  "schedule",
  "coding",
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
  /* D-#844: the child is an agent's ordinary thread; `thread` takes its
     task or thread id so `thread_read`/`thread_post` follow up there. */
  task: "- `task_*`: `task_create` hands a job to another agent as a child thread that reports back on its own; `task_read`/`task_wait`/`task_cancel` manage it, and `thread_*`'s `thread` param reaches the child.",
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
  /* D-#835: hand-off skills read these before running a coding-agent CLI. */
  coding:
    "- `coding_*`: `coding_agents` reads the user's stored model + effort default per outside coding agent; `coding_agents_set` asks the user to change it.",
  workbench:
    "- `workbench_*`: `workbench_previews` lists your preview servers; `workbench_open` opens the Files, Changes, PR, or Preview tab you name, never an editor on the Mac.",
  browser:
    "- `browser_*`: the session's own browser, shared with the user's Workbench — the only browser you may use for web pages.",
  terminal:
    "- `terminal_*`: the session's shell in its working folder — runs commands the user can watch live.",
  /* D-#777: `update_post` is CEO-only and described in the CEO brief, not
     in this shared text. The area exists so the name matches
     `<area>_<action>`. Empty, so it never adds a bullet. */
  update: "",
};

export function renderHostPolicy(areas: ReadonlySet<ToolArea>): string {
  const lines = [
    HOST_POLICY_MARKER,
    "You are an employee in LilOS. These tools are your only way to read or act, and they never touch another session.",
    ...TOOL_AREA_ORDER.filter((a) => areas.has(a))
      .map((a) => AREA_LINES[a])
      .filter((line) => line !== ""),
    "Reading is always allowed. Changes beyond your own thread — new threads, hiring, merging — need an approval: propose them, never push them through.",
    "Never open `~/.lilos` — the `lilos_*` tools are your only view of its state.",
    "Files, edits, and git use your engine's tools in the session folder; LilOS tools are for the app, not the codebase.",
  ];
  return lines.join("\n");
}
