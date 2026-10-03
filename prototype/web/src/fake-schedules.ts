import type { Msg, ScheduledTask } from "@lilos/ui"

/* Scheduled tasks demo (prototype #366 for #136): seed tasks per employee and
   the past runs they left in the DMs. The real app keeps tasks on the relay
   and the harness fires runs; here Run now is the only clock. */

export const SEED_TASKS: ScheduledTask[] = [
  {
    id: "task-triage", employee: "builder", name: "Morning triage", folder: "lilos", access: "full",
    prompt: "Triage new GitHub issues on Nuncio-hq/LilOS: label `agent-ready` what has clear acceptance criteria, hand those to Devin, and post a short summary of what needs me.",
    schedule: { kind: "weekdays", time: "09:00" },
    lastRun: { at: "9:00", result: "finished", rootId: "sched-r1" },
  },
  {
    id: "task-verify", employee: "builder", name: "Nightly verify", folder: "lilos", access: "ask",
    prompt: "Pull main, run `bun run verify`, and open an issue for anything red with the failing test and the commit that broke it.",
    schedule: { kind: "daily", time: "23:30" },
    lastRun: { at: "Yesterday 23:30", result: "failed", rootId: "sched-r2" },
  },
  {
    id: "task-prs", employee: "reviewer", name: "Friday PR sweep", folder: "lilos", access: "ask", paused: true,
    prompt: "Review every open PR older than two days. Comment with file:line, never push.",
    schedule: { kind: "weekly", time: "16:00", day: 5 },
  },
]

/* Past runs: normal sessions in the DM, marked with the task that started them. */
export const SCHEDULED_RUNS: Record<string, Msg[]> = {
  "dm-builder": [
    {
      kind: "msg", id: "sched-r2", from: "oscar", time: "Yesterday", text: SEED_TASKS[1].prompt,
      thread: {
        session: "ses_77c1", title: "Nightly verify · Tue 30 Sep", scheduled: { task: "task-verify", name: "Nightly verify" },
        replies: [
          {
            id: "sched-r2a", from: "builder", time: "Yesterday",
            steps: [{ tool: "terminal", input: { command: "git fetch origin main" }, output: "From github.com:Nuncio-hq/LilOS\n * branch main -> FETCH_HEAD" }],
            text: "I need to reset my checkout to `origin/main` before verifying. That's a risky command and this task runs on Ask, so I stopped: nobody answered the approval before the run timed out.",
          },
        ],
      },
    },
    {
      kind: "msg", id: "sched-r1", from: "oscar", time: "9:00", text: SEED_TASKS[0].prompt,
      thread: {
        session: "ses_51d0", title: "Morning triage · Wed 1 Oct", scheduled: { task: "task-triage", name: "Morning triage" },
        replies: [
          {
            id: "sched-r1a", from: "builder", time: "9:02", thought: 4,
            steps: [
              { tool: "terminal", input: { command: "gh issue list --label later --json number,title" }, output: "21 issues" },
              { tool: "terminal", input: { command: "gh issue edit 106 --add-label agent-ready" }, output: "✓ #106" },
            ],
            text: "Triage done.\n\n- **#106** Approval modes is unblocked (Settings merged), labelled `agent-ready`.\n- **#107 / #108** have their prototypes accepted, back to `agent-ready`.\n- **Needs you:** #135 shortcuts (are the bindings right?) and #117 sessions list.",
          },
        ],
      },
    },
  ],
}

/* A run's session title: "<task name> · Thu 2 Oct". */
export const runTitle = (name: string, d = new Date()) =>
  `${name} · ${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "")}`
