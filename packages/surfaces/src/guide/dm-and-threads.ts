/**
 * Guide page: DMs and threads (#340 AC-3).
 */
export const dmAndThreads = {
  title: "DMs and threads",
  body: `A DM is the private channel between Oscar and one employee. A thread
inside it is one engine session — it owns a title, a working folder, a model
pin and the conversation's visible messages.

What Oscar sees:
- The employee's DM page lists its threads with state (idle/active/closed),
  last activity and linked PRs; opening one shows the visible messages plus
  the live turn overlay.
- Messages in the thread are what the relay stores: Oscar's prompts, the
  employee's answers and system notes. Rewound history hides, never deletes.
- A thread's title can be auto-generated (the engine may upgrade it) or
  user-typed (the human's title always wins — an engine can never overwrite it).

Tools that apply:
- \`thread_read\` — read messages; the session's own thread by default, or any
  thread of the same DM by id/title. \`before\`/\`afterSeq\`/\`limit\` window it.
- \`thread_post\` — post a message into the session's own thread; Oscar sees
  it as a normal employee reply.
- \`thread_list\` — the DM's threads with title, state, last activity, PRs.
- \`thread_search\` — full-text search inside this DM only.
- \`thread_set_title\` — retitle the session's own thread while its title is
  still auto; a user-typed title returns \`user_title\` and stays.
- \`thread_prs\` — pull requests linked to the session's own thread.

Context fullness:
- \`context\` answers \`usage { used, window }\` for this session — the same
  numbers Oscar's context meter shows (\`window\` is absent when the engine
  reports none, \`usage\` absent until a turn completes).
- When \`used\` approaches \`window\` the session is nearly full: say so
  plainly in the reply (or \`thread_post\`) and suggest continuing in a new
  thread of this DM — a thread is one engine session, so a new thread starts
  with an empty context. Raise it when the context is nearly full, not on
  every turn.`,
};
