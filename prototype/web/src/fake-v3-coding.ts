import type { V3Data } from "@lilos/ui/v3-data"

/* ?v3 mock: the coding agents a thread can hand work to (D-#844, #847).
   `runtime` is the roster's runtime id (`acp:<agent>`, D-#761) — the page
   resolves the plain label from `data.runtimes`, so an agent never carries
   a display string here (#872). A helper whose runtime is not installed
   (Cursor, Antigravity) shows the page's read-only/can't-run treatment. */

export const CODING_AGENTS: V3Data["agents"] = [
  {
    id: "claude-code",
    name: "Claude Code",
    tone: "m",
    role: "Coding agent",
    hired: "8 Oct",
    runtime: "acp:claude",
    profile: "claude",
    description: "Coding agent by Anthropic.",
    model: "Opus 5.5 · High",
    schedule: "When a thread hands it work",
    skills: [],
    spend: { used: 6.2, cap: 20, period: "week" },
    instructions: ["Take the brief, work in the folder it names, report back in the thread."],
    week: { done: 3, typical: "18m", stuck: 0, handed: 0 },
  },
  {
    id: "devin",
    name: "Devin",
    tone: "b",
    role: "Coding agent",
    hired: "8 Oct",
    runtime: "acp:devin",
    profile: "devin",
    description: "Coding agent by Cognition.",
    model: "SWE-2 · High",
    schedule: "When a thread hands it work",
    skills: [],
    spend: { used: 8.9, cap: 20, period: "week" },
    instructions: ["Take the brief, work in the folder it names, report back in the thread."],
    week: { done: 2, typical: "26m", stuck: 0, handed: 0 },
  },
  {
    id: "cursor",
    name: "Cursor",
    tone: "r",
    role: "Coding agent",
    hired: "12 Oct",
    runtime: "acp:cursor",
    profile: "cursor",
    description: "Cursor's coding agent over ACP.",
    model: "Composer 1 · Medium",
    schedule: "When a thread hands it work",
    skills: [],
    spend: { used: 3.1, cap: 15, period: "week" },
    instructions: ["Take the brief, work in the folder it names, report back in the thread."],
    week: { done: 1, typical: "21m", stuck: 0, handed: 0 },
  },
  {
    id: "antigravity",
    name: "Antigravity",
    tone: "s",
    role: "Coding agent",
    hired: "12 Oct",
    runtime: "acp:antigravity",
    profile: "antigravity",
    description: "Google's Antigravity agent over ACP.",
    model: "Gemini 3 Pro · High",
    schedule: "When a thread hands it work",
    skills: [],
    spend: { used: 2.4, cap: 15, period: "week" },
    instructions: ["Take the brief, work in the folder it names, report back in the thread."],
    week: { done: 1, typical: "19m", stuck: 0, handed: 0 },
  },
]

/* One parent, four helpers in different states: two still running, one
   finished, one stopped to ask. The parent itself is `working` — it
   delegated mid-turn and is still on the merge prep. Stopping it ends its
   own turn only; the helpers outlive it (D-#847). A parent that waited or
   went idle with helpers live would read the same Working on the boards. */
export const CODING_THREADS: V3Data["threads"] = [
  {
    id: "t-lil-helpers",
    projectId: "lilos",
    agentId: "builder",
    title: "Prove the ac-544 fix across the suite",
    status: "working",
    startedAt: "11:30",
    minutes: 34,
    step: 9,
    context: 36,
    model: "Opus 5.5 · High",
    folder: "~/Code/LilOS",
    branch: "fix/ac-544",
    now: { kind: "edit", text: "merge.ts · staging the landed fixes", elapsed: "40s" },
    tail: ["4 helpers on it", "Devin · Claude Code · Cursor · Antigravity"],
    plan: [
      { text: "Hand the four tracks to helpers", state: "done" },
      { text: "Collect their results", state: "current" },
      { text: "Merge the patch and open the PR", state: "todo" },
    ],
    turns: [
      {
        n: 2,
        from: "woke on a helper's question at 11:58",
        took: "1m",
        prompt: {
          by: "cursor",
          at: "11:58",
          text: "task_ask: the port needs the full verify suite — may I run it?",
        },
        summary: "Cursor's ask went to Oscar. Still waiting on Devin and Antigravity.",
      },
      {
        n: 1,
        from: "you at 11:30",
        took: "3m",
        prompt: {
          by: "you",
          at: "11:30",
          text: "The ac-544 patch is in. Split the proof: one helper digs the CI traces, one sweeps the other callers, one ports the fix to the legacy list, one reviews the diff. Come back when they land.",
        },
        steps: [
          { kind: "delegate", target: "Devin · find the flake in the CI traces", meta: "task_trace" },
          { kind: "delegate", target: "Claude Code · sweep callers of restoreScroll", meta: "task_sweep" },
          { kind: "delegate", target: "Cursor · port the fix to the legacy list", meta: "task_port" },
          { kind: "delegate", target: "Antigravity · review the patch diff", meta: "task_review" },
        ],
        answer:
          "Four helpers are on it — trace, sweep, port and review. I'll prep the merge here while they run.",
      },
    ],
  },
  {
    id: "t-h-devin",
    parentId: "t-lil-helpers",
    projectId: "lilos",
    agentId: "devin",
    title: "Find the flake in the CI traces",
    status: "working",
    startedAt: "11:31",
    minutes: 33,
    step: 14,
    context: 47,
    model: "SWE-2 · High",
    folder: "~/Code/LilOS",
    branch: "fix/ac-544-trace",
    now: { kind: "read", text: "trace-7.zip · frame timings", elapsed: "50s" },
    live: {
      cmd: "$ unzip -o test-results/trace-7.zip -d /tmp/trace-7 && ls /tmp/trace-7",
      lines: [
        "trace.zip · 41 MB · 12 frames",
        "run 7 · AC-6 · scrolled to 0",
        "run 11 · AC-6 · scrolled to 0",
        "run 7 · paint at +212 ms",
        "run 11 · paint at +204 ms",
        "comparing against passing run 3…",
      ],
    },
    tail: ["7 traces read", "paint lands one frame late in every failure"],
    plan: [
      { text: "Pull the failing traces", state: "done" },
      { text: "Compare frame timings with passing runs", state: "current" },
      { text: "Name the race in one line", state: "todo" },
    ],
    turns: [
      {
        n: 1,
        from: "asked by Builder at 11:31",
        took: "33m so far",
        prompt: {
          by: "builder",
          at: "11:31",
          text: "task_trace: ac-544 fails about one run in seven on CI, always on AC-6 (scroll position). Pull the failing traces and tell me what differs from a passing run. Don't patch anything.",
        },
        steps: [
          { kind: "run", target: "gh run list --workflow e2e --limit 20", meta: "14 runs" },
          { kind: "run", target: "gh run download -n trace-ac-544", meta: "7 traces" },
          { kind: "read", target: "trace-7.zip · frames", meta: "12 frames" },
          { kind: "think", target: "Every failure paints the file list a frame after the restore runs. Passing runs paint first." },
          { kind: "read", target: "trace-7.zip · frame timings", running: true },
        ],
      },
    ],
  },
  {
    id: "t-h-claude",
    parentId: "t-lil-helpers",
    projectId: "lilos",
    agentId: "claude-code",
    title: "Sweep callers of restoreScroll",
    status: "done",
    startedAt: "11:31",
    minutes: 12,
    context: 22,
    model: "Opus 5.5 · High",
    folder: "~/Code/LilOS",
    branch: "fix/ac-544-sweep",
    summary: "4 callers; two already wait a frame, workbench.tsx was the only one racing",
    quote: "Only workbench.tsx restores before the list paints.",
    turns: [
      {
        n: 1,
        from: "asked by Builder at 11:31",
        took: "12m",
        prompt: {
          by: "builder",
          at: "11:31",
          text: "task_sweep: find every caller of restoreScroll and check which ones can still run before the list paints. Report the callers, don't edit.",
        },
        steps: [
          { kind: "search", target: "restoreScroll", meta: "4 callers" },
          { kind: "read", target: "packages/ui/src/workbench/workbench.tsx", meta: "call site + frame" },
          { kind: "read", target: "packages/ui/src/v3/v3-peek.tsx", meta: "waits a frame already" },
          { kind: "think", target: "Only workbench.tsx races; the v3 peek and the file tree both wait one paint." },
        ],
        answer:
          "**4 callers**, one races: `workbench.tsx` restores on cache-hydrate, one frame before the list paints. `v3-peek.tsx` and the file tree already wait a frame; the workbench's own list is the fourth caller and it was the patch's target.\n\nNo other edits needed.",
      },
    ],
  },
  {
    id: "t-h-cursor",
    parentId: "t-lil-helpers",
    projectId: "lilos",
    agentId: "cursor",
    title: "Port the fix to the legacy list",
    status: "needs",
    startedAt: "11:33",
    minutes: 31,
    step: 8,
    context: 28,
    model: "Composer 1 · Medium",
    folder: "~/Code/LilOS",
    branch: "fix/ac-544-legacy",
    askId: "a-4",
    quote: "Wants to run the full verify before it calls the port done.",
    plan: [
      { text: "Read the workbench fix", state: "done" },
      { text: "Port it to the legacy file list", state: "done" },
      { text: "Prove it: full verify", state: "current" },
    ],
    turns: [
      {
        n: 1,
        from: "asked by Builder at 11:33",
        took: "25m so far",
        prompt: {
          by: "builder",
          at: "11:33",
          text: "task_port: the workbench fix waits two frames before restoreScroll. Port the same wait to the legacy file list (apps/web's old Files pane). Targeted tests pass; ask before anything bigger.",
        },
        steps: [
          { kind: "read", target: "packages/ui/src/workbench/workbench.tsx", meta: "the two-frame wait" },
          { kind: "read", target: "apps/web/src/files/FilesPane.tsx", meta: "legacy list" },
          { kind: "edit", target: "apps/web/src/files/FilesPane.tsx", add: 9, del: 2 },
          { kind: "run", target: "bun test apps/web/src/files", meta: "12 passed · 14s" },
          { kind: "delegate", target: "Asked Oscar: run bun run verify", meta: "waiting 6m" },
        ],
      },
    ],
  },
  {
    id: "t-h-anti",
    parentId: "t-lil-helpers",
    projectId: "lilos",
    agentId: "antigravity",
    title: "Review the patch diff",
    status: "working",
    startedAt: "11:40",
    minutes: 24,
    step: 6,
    context: 19,
    model: "Gemini 3 Pro · High",
    folder: "~/Code/LilOS",
    branch: "fix/ac-544",
    now: { kind: "think", text: "Weighing the two-frame wait", elapsed: "30s" },
    live: {
      cmd: "Reviewing fix/ac-544 · 2 files · +18 −4",
      lines: [
        "wb-probe-cache.ts  +12 −3  ✓ read",
        "workbench.tsx  +6 −1  ✓ read",
        "checking the rAF pair against the paint…",
      ],
    },
    tail: ["2 files read", "one question so far"],
    plan: [
      { text: "Read the patch", state: "done" },
      { text: "Check the frame ordering", state: "current" },
      { text: "Sign off or object", state: "todo" },
    ],
    turns: [
      {
        n: 1,
        from: "asked by Builder at 11:40",
        took: "24m so far",
        prompt: {
          by: "builder",
          at: "11:40",
          text: "task_review: read the ac-544 patch (wb-probe-cache.ts, workbench.tsx) and say whether the two-frame wait is the right fix or a band-aid. Object if you see one.",
        },
        steps: [
          { kind: "read", target: "packages/ui/src/lib/wb-probe-cache.ts", meta: "+12 −3" },
          { kind: "read", target: "packages/ui/src/workbench/workbench.tsx", meta: "+6 −1" },
          { kind: "think", target: "Two rAFs is the same wait the v3 peek uses, so it matches the codebase's own rule." },
          { kind: "think", target: "Weighing whether a MutationObserver would be sturdier — probably overkill for a paint that is always one frame late.", running: true },
        ],
      },
    ],
  },
]

/* A helper's ask lands on Needs you like anyone else's (D-#847): it names
   its thread, so the ask opens the helper, and the helper links back to the
   parent waiting on it. */
export const CODING_ASKS: V3Data["asks"] = [
  {
    id: "a-4",
    threadId: "t-h-cursor",
    from: "cursor",
    kind: "approval",
    title: "Allow `bun run verify`?",
    waiting: 6,
    ask: "Cursor wants to run the full verify — typecheck, lint and the test suite, about six minutes — before it calls the port done.",
    why: "The legacy list shares the scroll path; a green suite is the only proof the port did not regress it.",
    ifYes: "Cursor runs verify, then reports the port done.",
    ifNo: "Cursor reports the port with the targeted tests only; the legacy list stays unproven.",
    allowRule: "Let coding helpers run `bun run verify` without asking",
  },
]
