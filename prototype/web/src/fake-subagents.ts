import type { BackgroundJob, Msg, Reply, Step, Subagent, Thread } from "@lilos/ui"

/* Prototype data + a tiny timeline for subagents and background work (issue #170).
   Builder's "turns lost after sleep" session: turn 1 already fanned out (three own
   subagents — one failed — plus Reviewer asked in its own session); turn 2 starts live
   when the thread opens and plays its helpers to done. Real app: Hermes delegate_task /
   Claude Code Task events and the engine's background-process list. */

export const DEMO_ROOT = "d3"
const REVIEW_SESSION = "ses_rv21"
const LIVE = "r-sub-live"

const DEV_LOG = [
  "\u001b[90m$ \u001b[0mbun run dev",
  "\u001b[36mvite\u001b[0m v6 ready in 214 ms",
  "\u001b[32m➜\u001b[0m  Local:   http://localhost:5173/",
  "\u001b[90m10:48:02\u001b[0m [vite] hmr update /src/App.tsx",
  "\u001b[90m10:52:40\u001b[0m [vite] hmr update /src/thread/thread-view.tsx",
].join("\n")
const WATCH_LOG = [
  "\u001b[90m$ \u001b[0mbun test --watch apps/harness",
  "\u001b[32m✓\u001b[0m reconnect › replays afterSequence (4 ms)",
  "\u001b[32m✓\u001b[0m reconnect › backs off to 30s (2 ms)",
  "",
  " 2 pass · 0 fail · watching for changes…",
].join("\n")

const JOBS: BackgroundJob[] = [
  { id: "j-dev", command: "bun run dev", status: "running", started: "10:41", uptime: "14m", url: "http://localhost:5173", log: DEV_LOG },
  { id: "j-watch", command: "bun test --watch apps/harness", status: "running", started: "10:43", uptime: "12m", by: "Harness sleep path", log: WATCH_LOG },
  {
    id: "j-build", command: "bun run build", status: "failed", exitCode: 1, started: "10:44", uptime: "38s",
    log: "\u001b[90m$ \u001b[0mbun run build\n\u001b[31merror\u001b[0m TS2345: apps/harness/src/turns.ts:57\n  Argument of type 'number | undefined' is not assignable to parameter of type 'number'.\n\u001b[31mBuild failed\u001b[0m in 38s",
  },
  { id: "j-tsc", command: "bunx tsc -b packages/contracts", status: "exited", exitCode: 0, started: "10:42", uptime: "9s", log: "\u001b[90m$ \u001b[0mbunx tsc -b packages/contracts\n\u001b[32mDone\u001b[0m in 9s" },
]

const PATCH_TURNS: Step = {
  tool: "patch", input: { path: "apps/harness/src/turns.ts" }, output: "resume from lastSeq",
  diff: {
    path: "apps/harness/src/turns.ts", status: "modified", add: 4, del: 1,
    patch: "@@ -54,7 +54,10 @@ export function onWake(s: Session) {\n   const gap = clock.drift()\n-  if (gap > SLEEP_MS) s.turn?.end(\"interrupted\")\n+  if (gap > SLEEP_MS && s.turn) {\n+    s.turn.end(\"interrupted\")\n+    s.resumeFrom(s.lastSeq ?? 0)\n+  }\n   feed.flush()",
  },
}
const SLEEP_TEST: Step = {
  tool: "write_file", input: { path: "apps/harness/test/sleep.test.ts" }, output: "31 lines",
  diff: {
    path: "apps/harness/test/sleep.test.ts", status: "added", add: 8, del: 0,
    patch: "@@ -0,0 +1,8 @@\n+import { expect, test } from \"vitest\"\n+import { fakeClock, session } from \"./helpers\"\n+\n+test(\"a turn cut by sleep ends interrupted and resumes\", () => {\n+  const s = session(); fakeClock.jump(120_000)\n+  expect(s.turn?.state).toBe(\"interrupted\")\n+  expect(s.resumedFrom).toBe(s.lastSeq)\n+})",
  },
}

const TURN_1: Subagent[] = [
  {
    id: "sa-relay", name: "Trace relay replay", status: "done", dur: 41,
    task: "Read apps/relay: how does it replay events after a harness reconnects? Report file:line, no edits.",
    steps: [
      { tool: "search_files", input: { pattern: "afterSequence", path: "apps/relay" }, output: "3 matches" },
      { tool: "read_file", input: { path: "apps/relay/src/feed.ts" }, output: "212 lines" },
    ],
    result: "Relay replays from `afterSequence` correctly (`apps/relay/src/feed.ts:88`). **The gap is not in the relay.**",
  },
  {
    id: "sa-harness", name: "Harness sleep path", status: "done", dur: 63,
    task: "Find what the harness does with a running turn when the clock jumps (Mac slept). Start a test watcher.",
    steps: [
      { tool: "read_file", input: { path: "apps/harness/src/turns.ts" }, output: "140 lines" },
      { tool: "terminal", input: { command: "bun test --watch apps/harness" }, output: "Started in background" },
    ],
    result: "`onWake` ends the turn as interrupted but never resumes the feed from `lastSeq` (`apps/harness/src/turns.ts:56`), so events emitted during sleep are dropped.",
  },
  {
    id: "sa-issues", name: "Search Hermes issues", status: "failed", dur: 12,
    task: "Check NousResearch/hermes-agent issues for known sleep/resume bugs.",
    steps: [{ tool: "web_search", input: { query: "hermes-agent resume after sleep site:github.com" }, output: "403 rate limited" }],
    result: "GitHub search was rate-limited (403). Stopped without an answer.",
  },
  {
    id: "sa-review", name: "Check envelope seq contract", status: "done", dur: 120,
    task: "Confirm envelope seq is monotonic per session.", steps: [],
    employee: { id: "reviewer", session: REVIEW_SESSION },
    result: "`ses_9d51` check: `seq` is monotonic per session; the contract holds.",
  },
]

/* Turn 2's helpers at t=0 of the timeline — all running. */
const TURN_2: Subagent[] = [
  {
    id: "sb-fix", name: "Fix harness resume", status: "running",
    task: "Make onWake resume the feed from lastSeq after ending the turn. Minimal change.",
    steps: [{ tool: "read_file", input: { path: "apps/harness/src/turns.ts" }, output: "", running: true }],
  },
  {
    id: "sb-test", name: "Write sleep regression test", status: "running",
    task: "Add a test: a turn cut by a clock jump ends interrupted and resumes from lastSeq.",
    steps: [{ tool: "search_files", input: { pattern: "fakeClock", path: "apps/harness/test" }, output: "", running: true }],
  },
  {
    id: "sb-review", name: "Review the fix", status: "running",
    task: "Review Builder's harness resume fix once the test is green.", steps: [],
    employee: { id: "reviewer", session: REVIEW_SESSION },
  },
]

export const SUBAGENT_DMS: Record<string, Msg[]> = {
  "dm-builder": [
    {
      kind: "msg", id: DEMO_ROOT, from: "oscar", time: "10:40",
      text: "Turns get lost when the Mac sleeps. Find out why: look at relay and harness in parallel, and ask **@Reviewer** to check the envelope contract.",
      thread: {
        session: "ses_9d51", title: "Why turns get lost after sleep",
        usage: { input: 91800, output: 7400, reasoning: 3100, cache: 64000 },
        ticket: "LIL-9", branch: "lil-9-sleep-replay",
        jobs: JOBS,
        replies: [
          {
            from: "builder", time: "10:41", thought: 5, dur: 128,
            reasoning: "Relay replay and harness wake handling are independent reads: two subagents. The contract question belongs to Reviewer. A third helper checks upstream issues.",
            steps: [{ tool: "terminal", input: { command: "bun run dev" }, output: "Started in background · http://localhost:5173" }],
            subagents: TURN_1,
            text: "Found it. The relay replays fine; the **harness** drops events: `onWake` ends the turn but never resumes from `lastSeq` (`apps/harness/src/turns.ts:56`). Reviewer confirmed `seq` is monotonic, so resuming from it is safe.\n\nThe upstream search failed (rate limit); not needed for the fix.",
          },
          { from: "oscar", time: "10:50", text: "Good. Write the fix and a regression test, and have Reviewer look at it." },
          { id: LIVE, from: "builder", time: "10:51", live: true, phase: "tools", thought: 3, reasoning: "Fix and test touch different files: two subagents in parallel, then Reviewer.", text: "", steps: [], subagents: TURN_2 },
        ],
      },
    },
  ],
  "dm-reviewer": [
    {
      kind: "msg", id: "v2", from: "builder", time: "10:42",
      text: "Asked by **Builder** (session ses_9d51): confirm envelope `seq` is monotonic per session.",
      thread: {
        session: REVIEW_SESSION, title: "Envelope seq contract (for Builder)",
        replies: [
          {
            from: "reviewer", time: "10:44", thought: 2, dur: 120,
            steps: [
              { tool: "read_file", input: { path: "packages/contracts/src/envelope.ts" }, output: "58 lines" },
              { tool: "search_files", input: { pattern: "seq\\s*[:=]", path: "apps/relay" }, output: "2 matches" },
            ],
            text: "`seq` is assigned in one place (`apps/relay/src/feed.ts:41`) and only increments. Monotonic per session; the contract holds.",
          },
        ],
      },
    },
  ],
}

/* ---- The live turn's timeline. Each tick edits the thread; Stop marks what's still running as stopped. */
type Edit = (t: Thread) => Thread
const agents = (t: Thread, fn: (a: Subagent) => Subagent): Thread => ({
  ...t,
  replies: t.replies.map((r) => (r.id === LIVE ? { ...r, subagents: r.subagents?.map(fn) } : r)),
})
const reply = (t: Thread, fn: (r: Reply) => Reply): Thread => ({ ...t, replies: t.replies.map((r) => (r.id === LIVE ? fn(r) : r)) })
const done = (s: Step): Step => ({ ...s, running: false })
const at = (id: string, fn: (a: Subagent) => Subagent) => (t: Thread) => agents(t, (a) => (a.id === id ? fn(a) : a))

const TIMELINE: [number, Edit][] = [
  [1800, at("sb-fix", (a) => ({ ...a, steps: [{ ...done(a.steps[0]), output: "140 lines" }, { ...PATCH_TURNS, running: true }] }))],
  [3600, at("sb-test", (a) => ({ ...a, steps: [{ ...done(a.steps[0]), output: "helpers.ts: fakeClock" }, { ...SLEEP_TEST, running: true }] }))],
  [5400, at("sb-fix", (a) => ({ ...a, status: "done", dur: 6, steps: a.steps.map(done), result: "`onWake` now ends the turn **and** resumes from `lastSeq` (+4 −1 in `apps/harness/src/turns.ts`)." }))],
  [6800, at("sb-test", (a) => ({ ...a, steps: [...a.steps.map(done), { tool: "terminal", input: { command: "bun test apps/harness/test/sleep.test.ts" }, output: "", running: true }] }))],
  [8600, (t) => ({
    ...at("sb-test", (a) => ({
      ...a, status: "done", dur: 9, result: "Regression test added and passing (3 pass).",
      steps: a.steps.map((s) => (s.tool === "terminal" ? { ...done(s), output: "\u001b[32m✓\u001b[0m a turn cut by sleep ends interrupted and resumes\n\n 3 pass · 0 fail" } : done(s))),
    }))(t),
    jobs: t.jobs?.map((j) => (j.id === "j-watch" ? { ...j, log: `${j.log}\n\u001b[32m✓\u001b[0m sleep › a turn cut by sleep ends interrupted and resumes (6 ms)\n\n 3 pass · 0 fail · watching for changes…` } : j)),
  })],
  [10400, at("sb-review", (a) => ({ ...a, status: "done", dur: 11, result: "Approved: resume uses the monotonic seq." }))],
  [11200, (t) => reply(t, (r) => ({ ...r, phase: "typing", streaming: "Fixed on `lil-9-sleep-replay`." }))],
  [12400, (t) => reply(t, (r) => ({
    ...r, live: false, phase: "done", streaming: undefined, dur: 12,
    text: "Fixed on `lil-9-sleep-replay`: the harness now resumes from `lastSeq` after the Mac wakes, with a regression test. **Reviewer approved.** The test watcher and dev server are still running in the background.",
  }))],
]

const STOPPED: Edit = (t) => reply(agents(t, (a) => (a.status === "running" ? { ...a, status: "stopped", steps: a.steps.map(done) } : a)), (r) => ({ ...r, live: false, phase: "stopped" }))

/* Plays the timeline once; `stopped()` is polled each tick (the composer's Stop). Returns a cancel. */
export function playSubagents(edit: (fn: Edit) => void, stopped: () => boolean): () => void {
  const timers = TIMELINE.map(([ms, fn]) =>
    setTimeout(() => {
      if (stopped()) return
      edit(fn)
    }, ms),
  )
  const guard = setInterval(() => {
    if (!stopped()) return
    edit(STOPPED)
    cancel()
  }, 300)
  const cancel = () => {
    timers.forEach(clearTimeout)
    clearInterval(guard)
  }
  setTimeout(() => clearInterval(guard), TIMELINE[TIMELINE.length - 1][0] + 100)
  return cancel
}

/* Workbench → Background → Stop. */
export const stopJob = (id: string): Edit => (t) => ({
  ...t,
  jobs: t.jobs?.map((j) => (j.id === id ? { ...j, status: "stopped", log: `${j.log}\n^C` } : j)),
})
