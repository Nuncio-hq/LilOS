/**
 * Guide page: threads, projects and plain chats (#340 AC-3, D-#25, D-#771).
 *
 * A thread is the only unit of work: one engine session with one agent, in a
 * project or a plain chat. There are no DMs — the per-employee channel is
 * the relay's internal routing scope, so this page never names it as a place.
 */
export const threads = {
  title: "Threads, projects and plain chats",
  body: `A thread is one engine session with one agent — it owns a title, a
model pin and the conversation's visible messages. Every thread is either in
a project or a plain chat; there is no third home.

What Oscar sees:
- A project is a folder the company works in: a name, a short key like LIL,
  the folder's path (like ~/Code/LilOS) and a line about it. The sidebar lists projects
  with their threads under them; threads with no project are plain chats.
- A thread in a project works in that project's folder (its working folder
  and Workbench are the project's); a plain chat has no folder of its own and
  runs in the default workdir.
- Projects are Oscar's to make — the sidebar's ＋ adds one from a folder,
  a chat's folder chip offers Add as project, and a project row's ⋯ removes
  it (its threads stay as chats; the folder is untouched). A thread in a
  folder no project covers is a plain chat that keeps working there.
- A thread's list row shows state (idle/active/closed), last activity and
  linked PRs; opening one shows the visible messages plus the live turn
  overlay.
- Messages in the thread are what the relay stores: Oscar's prompts, the
  employee's answers and system notes. Rewound history hides, never deletes.
- A thread's title can be auto-generated (the engine may upgrade it) or
  user-typed (the human's title always wins — an engine can never overwrite it).

Tools that apply:
- \`thread_read\` — read messages; the session's own thread by default, or any
  other of your threads by id/title. \`before\`/\`afterSeq\`/\`limit\` window it.
- \`thread_post\` — post a message into the session's own thread; Oscar sees
  it as a normal employee reply.
- \`thread_list\` — your threads with title, state, last activity, PRs.
- \`thread_search\` — full-text search across your threads only.
- \`thread_set_title\` — retitle the session's own thread while its title is
  still auto; a user-typed title returns \`user_title\` and stays.
- \`thread_prs\` — pull requests linked to the session's own thread.
- \`project_list\` — the company's projects: id, name, key, folder, about.
  Read it before starting work in a folder, to reuse a project instead of
  proposing a duplicate.
- \`project_create\` — propose a project for a folder (optional name, about).
  It opens an approval ask and nothing is made until Oscar approves; a folder
  that already has a project answers that project.
- \`thread_start\` — propose a new thread with a first message (opens an
  approval ask). Pass \`project\` — a project's id or its key, any case — to
  start it in that project's folder; leave it out for a plain chat. An unknown
  project is an error that lists the keys you can use.

Context fullness:
- \`context\` answers \`usage { used, window }\` for this session — the same
  numbers Oscar's context meter shows (\`window\` is absent when the engine
  reports none, \`usage\` absent until a turn completes).
- When \`used\` approaches \`window\` the session is nearly full: say so
  plainly in the reply (or \`thread_post\`) and suggest continuing in a new
  thread (\`thread_start\`, in the same project when it has one) — a thread
  is one engine session, so a new thread starts with an empty context. Raise
  it when the context is nearly full, not on every turn.`,
};
