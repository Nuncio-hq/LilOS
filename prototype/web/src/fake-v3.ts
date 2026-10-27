import { HIRE_TEMPLATES, type V3Data, type V3Draft, type V3Profile } from "@lilos/ui/v3-data"
import { ATTENTION_ASKS, ATTENTION_THREADS } from "./fake-v3-attention"
import { CODING_AGENTS, CODING_ASKS, CODING_THREADS } from "./fake-v3-coding"
import { CONNECTORS, OUTSIDE_THREADS, OUTSIDE_TICKETS, OUTSIDE_WORKERS } from "./fake-v3-outside"
import { MODEL_OPTIONS, MODEL_PROVIDERS, MODEL_VISIBILITY, modelIdOf } from "./fake-v3-models"
import { AGENT_NOTES, SKILLS } from "./fake-v3-files"
import { BROWSER, DEVICES, SCHEDULES, SETTINGS, WORKBENCHES } from "./fake-v3-tools"

/* ?v3 mock company: one Monday at 12:04. Every number on every screen comes
   from these records, so Home, Work, Threads and People always agree. */

const AGENTS: V3Data["agents"] = [
  {
    id: "ceo",
    name: "Chief",
    tone: "c",
    role: "Runs the company",
    hired: "1 Oct",
    runtime: "hermes",
    profile: "ceo",
    model: "Opus 5.5 · High",
    schedule: "Always on · checks every ticket every 15 min",
    skills: ["planning", "code-review", "weekly-report"],
    spend: { used: 9.8, cap: 25, period: "week" },
    instructions: [
      "You run Oscar Co. Split every goal into tickets with one owner each, check every result before it ships, and write Oscar a short update at 9:00 and 12:00.",
      "Ask Oscar before anything goes public or costs money. Decide everything else yourself.",
    ],
    week: { done: 14, typical: "6m", stuck: 0, handed: 0 },
  },
  {
    id: "builder",
    name: "Builder",
    tone: "b",
    role: "Engineer",
    reportsTo: "ceo",
    hired: "1 Oct",
    runtime: "hermes",
    profile: "builder",
    model: "Opus 5.5 · High",
    schedule: "When given a ticket",
    skills: ["typescript", "playwright", "git-pr"],
    spend: { used: 31.2, cap: 60, period: "week" },
    instructions: [
      "You write and fix code in the project's folder. Keep every change small enough to review in five minutes.",
      "Open a PR for every ticket; never push to main.",
    ],
    week: { done: 11, typical: "52m", stuck: 1, handed: 0 },
  },
  {
    id: "reviewer",
    name: "Reviewer",
    tone: "r",
    role: "QA",
    reportsTo: "ceo",
    hired: "4 Oct",
    runtime: "hermes",
    profile: "reviewer",
    model: "Sonnet 5 · Medium",
    schedule: "When a ticket needs review",
    skills: ["ios-simulator", "screenshots"],
    spend: { used: 3.4, cap: 15, period: "week" },
    instructions: ["Check every result on a real device or browser before you call it done. Attach screenshots."],
    week: { done: 8, typical: "16m", stuck: 0, handed: 0 },
  },
  {
    id: "marketer",
    name: "Marketer",
    tone: "m",
    role: "Growth",
    reportsTo: "ceo",
    hired: "2 Oct",
    runtime: "hermes",
    profile: "marketer",
    model: "Sonnet 5 · Medium",
    schedule: "When given a ticket · posts at 9:00",
    skills: ["copywriting", "meta-ads", "x-threads"],
    spend: { used: 112, cap: 300, period: "month" },
    instructions: ["You write copy and run growth tests. Every claim needs a number behind it."],
    week: { done: 7, typical: "41m", stuck: 0, handed: 0 },
  },
  {
    id: "scout",
    name: "Scout",
    tone: "s",
    role: "Researcher",
    reportsTo: "ceo",
    hired: "2 Oct",
    runtime: "hermes",
    profile: "scout",
    model: "Sonnet 5 · Medium",
    schedule: "When given a ticket · checks in every 30 min",
    skills: ["web-research", "creator-vetting", "sheets"],
    spend: { used: 4.1, cap: 10, period: "week" },
    instructions: [
      "You find people, numbers and sources for the rest of the team. Return a sheet, never a wall of text.",
      "Cite every row. If you are unsure a creator is real, say so in the row.",
    ],
    suggestion: {
      text: "If two searches in a row return nothing new, stop and tell the CEO what you tried.",
      after: "HB-14",
    },
    week: { done: 9, typical: "38m", stuck: 2, handed: 1 },
  },
  {
    id: "designer",
    name: "Designer",
    tone: "d",
    role: "Design",
    reportsTo: "ceo",
    hired: "6 Oct",
    runtime: "hermes",
    profile: "designer",
    model: "Sonnet 5 · Medium",
    schedule: "Weekdays 14:00–18:00",
    skills: ["figma-export", "app-store-assets"],
    spend: { used: 2.2, cap: 10, period: "week" },
    instructions: ["You make screens and store assets. Show two options, never one."],
    week: { done: 4, typical: "1h 10m", stuck: 0, handed: 0 },
    next: "Starts the onboarding copy at 14:00 · QR-7",
  },
]

const PROJECTS: V3Data["projects"] = [
  { id: "lilos", name: "LilOS", key: "LIL", tone: "b", folder: "~/Code/LilOS", about: "The company OS you're looking at." },
  { id: "heardback", name: "HeardBack", key: "HB", tone: "r", folder: "~/Code/heardback", about: "A voice journal for iPhone." },
  { id: "qrit", name: "QRit", key: "QR", tone: "d", folder: "~/Code/qrit", about: "QR codes that look good. Pro tier ships Wednesday." },
]

const GOALS: V3Data["goals"] = [
  { id: "g-hb", title: "Grow HeardBack conversion", projectId: "heardback", due: "Fri 23 Oct", why: "Trial-to-paid is 3.1%; the target is 5%." },
  { id: "g-qr", title: "Launch QRit Pro", projectId: "qrit", due: "Wed 21 Oct", why: "The Pro tier is built; it needs a name, a listing and a launch." },
  { id: "g-lil", title: "Ship the company screen", projectId: "lilos", due: "Fri 30 Oct", why: "Oscar should see the whole company at a glance." },
]

const done = (id: string, title: string, projectId: string, owner: string, doneAgo: number, goalId?: string): V3Data["tickets"][number] => ({
  id,
  title,
  projectId,
  goalId,
  owner,
  status: "done",
  since: doneAgo,
  doneAgo,
  progress: [],
  updates: [],
})

const TICKETS: V3Data["tickets"] = [
  {
    id: "HB-11",
    title: "Run the Meta Ads test",
    projectId: "heardback",
    goalId: "g-hb",
    owner: "marketer",
    status: "needs",
    waitingOn: { kind: "you", askId: "a-1" },
    since: 41,
    started: "Today 10:40",
    progress: [
      { text: "Pick the 3 best hooks from HB-9", by: "marketer", took: "12m", state: "done" },
      { text: "Build 3 ad variants", by: "marketer", took: "30m", state: "done" },
      { text: "Approval to spend $40", by: "you", took: "41m so far", state: "current" },
      { text: "Run for 3 days and report", by: "marketer", took: "", state: "todo" },
    ],
    updates: [{ by: "marketer", ago: 41, text: "Three ads are ready. I need $40 to run them for three days." }],
  },
  {
    id: "HB-12",
    title: "Paywall copy A/B test",
    projectId: "heardback",
    goalId: "g-hb",
    owner: "builder",
    reviewer: "reviewer",
    status: "waiting",
    waitingOn: { kind: "agent", agentId: "ceo", why: "for sign-off" },
    since: 26,
    started: "Today 09:14",
    progress: [
      { text: "Planned the test", by: "ceo", took: "5m", state: "done" },
      { text: "Built two paywall variants", by: "builder", took: "1h 50m", state: "done" },
      { text: "Tests green after one retry", by: "builder", took: "12m", state: "done" },
      { text: "Checked both variants on device", by: "reviewer", took: "18m", state: "done" },
      { text: "Sign-off", by: "ceo", took: "26m so far", state: "current" },
      { text: "Ship variant B to half of new users", by: "builder", took: "", state: "todo" },
    ],
    result: {
      pr: { num: 66, branch: "paywall-copy-ab", add: 214, del: 38 },
      files: [{ name: "2 screenshots", note: "Variant A · Variant B" }],
    },
    updates: [
      { by: "reviewer", ago: 26, text: "Copy B reads better and both variants work on device. Ready for sign-off." },
      { by: "ceo", ago: 4, text: "Reading PR #66 now. If the diff is clean I’ll ship B to half of new users." },
    ],
  },
  {
    id: "HB-13",
    title: "Ship variant B to half of new users",
    projectId: "heardback",
    goalId: "g-hb",
    owner: "builder",
    status: "planned",
    startsAt: "after HB-12",
    since: 0,
    progress: [],
    updates: [],
  },
  {
    id: "HB-14",
    title: "Find 20 journaling creators",
    projectId: "heardback",
    goalId: "g-hb",
    owner: "scout",
    status: "stuck",
    stuckWhy: "same web search 6×",
    fallback: { at: "12:30", does: "hands it to Marketer" },
    since: 45,
    started: "Today 10:52",
    progress: [
      { text: "List search terms", by: "scout", took: "4m", state: "done" },
      { text: "Collect 20 creators with 5k–50k followers", by: "scout", took: "1h 12m so far", state: "current" },
      { text: "Vet each one and fill the sheet", by: "scout", took: "", state: "todo" },
    ],
    updates: [
      { by: "scout", ago: 50, text: "Found 7 so far. Search results are drying up." },
      { by: "ceo", ago: 14, text: "Scout has run the same search six times. I’ll hand this to Marketer at 12:30 unless Oscar says otherwise." },
    ],
  },
  done("HB-9", "Collect 50 hooks from X", "heardback", "scout", 190, "g-hb"),
  done("HB-10", "Write three paywall headlines", "heardback", "marketer", 300, "g-hb"),
  {
    id: "QR-3",
    title: "Rename the app to “QRit Pro”?",
    projectId: "qrit",
    goalId: "g-qr",
    owner: "ceo",
    status: "needs",
    waitingOn: { kind: "you", askId: "a-2" },
    since: 12,
    started: "Today 11:52",
    progress: [
      { text: "Check the name in the App Store", by: "ceo", took: "3m", state: "done" },
      { text: "Your answer", by: "you", took: "12m so far", state: "current" },
    ],
    updates: [{ by: "ceo", ago: 12, text: "“QRit Pro” is free in the App Store. Your call; I lean towards keeping one name." }],
  },
  {
    id: "QR-7",
    title: "Onboarding copy pass",
    projectId: "qrit",
    goalId: "g-qr",
    owner: "designer",
    status: "planned",
    startsAt: "14:00",
    since: 0,
    progress: [],
    updates: [],
  },
  done("QR-2", "App Store screenshots", "qrit", "designer", 1300, "g-qr"),
  done("QR-4", "Price check: 12 QR apps", "qrit", "scout", 260, "g-qr"),
  done("QR-5", "Pro tier paywall", "qrit", "builder", 900, "g-qr"),
  done("QR-6", "Store listing copy", "qrit", "marketer", 400, "g-qr"),
  {
    id: "LIL-80",
    title: "Draft the agent contract",
    projectId: "lilos",
    goalId: "g-lil",
    owner: "builder",
    status: "waiting",
    waitingOn: { kind: "ticket", ticketId: "LIL-81" },
    since: 120,
    progress: [],
    updates: [{ by: "ceo", ago: 120, text: "Starts once LIL-81 is green; both touch the workbench." }],
  },
  {
    id: "LIL-81",
    title: "Fix the flaky ac-544 e2e test",
    projectId: "lilos",
    goalId: "g-lil",
    owner: "builder",
    status: "working",
    since: 62,
    started: "Today 11:02",
    progress: [
      { text: "Reproduce the flake", by: "builder", took: "6m", state: "done" },
      { text: "Find the race", by: "builder", took: "9m", state: "done" },
      { text: "Patch the scroll restore", by: "builder", took: "12m", state: "done" },
      { text: "Pass 15 runs in a row", by: "builder", took: "1m so far", state: "current" },
      { text: "Open the PR", by: "builder", took: "", state: "todo" },
    ],
    updates: [{ by: "ceo", ago: 12, text: "Builder found the race. Waiting for 15 green runs before the PR." }],
  },
  {
    id: "LIL-82",
    title: "Company screen in the prototype",
    projectId: "lilos",
    goalId: "g-lil",
    owner: "designer",
    status: "planned",
    startsAt: "Thu",
    since: 0,
    progress: [],
    updates: [],
  },
  done("LIL-77", "Fold the docs into one page", "lilos", "builder", 120),
  done("LIL-74", "How T3 Code settles quiet threads", "lilos", "scout", 2900),
]

/* The list's clock (#862): `BACK(m)` is "this many minutes ago" for
   cameBackAt ordering, pins and the shelf's ages; `TOMORROW_9` is the
   snooze preset's tomorrow-morning wake. */
const BACK = (min: number) => Date.now() - min * 60_000
const TOMORROW_9 = (() => {
  const d = new Date(Date.now() + 86_400_000)
  d.setHours(9, 0, 0, 0)
  return d.getTime()
})()

const THREADS: V3Data["threads"] = [
  {
    id: "t-lil81",
    ticketId: "LIL-81",
    agentId: "builder",
    title: "Fix the flaky ac-544 e2e test",
    status: "working",
    startedAt: "11:02",
    minutes: 62,
    step: 23,
    context: 42,
    model: "Opus 5.5 · High",
    folder: "~/Code/LilOS",
    branch: "fix/ac-544",
    now: { kind: "run", text: "playwright test × 15", elapsed: "1m 42s" },
    live: {
      cmd: "$ playwright test ac-544-workbench-reopen.spec.ts --repeat-each=15",
      lines: [
        "✓ ac-544 › reopens the cached workbench  (run 1)",
        "✓ ac-544 › AC-6 restores the scroll position  (run 1)",
        "✓ ac-544 › reopens the cached workbench  (run 2)",
        "✓ ac-544 › AC-6 restores the scroll position  (run 2)",
        "✓ ac-544 › reopens the cached workbench  (run 3)",
        "✓ ac-544 › AC-6 restores the scroll position  (run 3)",
        "✓ ac-544 › reopens the cached workbench  (run 4)",
        "✓ ac-544 › AC-6 restores the scroll position  (run 4)",
        "✓ ac-544 › reopens the cached workbench  (run 5)",
        "✓ ac-544 › AC-6 restores the scroll position  (run 5)",
      ],
    },
    tail: ["✓ 11 passed", "running 12 of 15…"],
    plan: [
      { text: "Reproduce the flake", state: "done" },
      { text: "Find the race", state: "done" },
      { text: "Patch the scroll restore", state: "done" },
      { text: "Pass 15 runs in a row", state: "current" },
      { text: "Open the PR", state: "todo" },
    ],
    helpers: [{ text: "Search Playwright issues", took: "2m" }],
    turns: [
      {
        n: 3,
        from: "asked by CEO at 11:52",
        took: "12m so far",
        prompt: {
          by: "ceo",
          at: "11:52",
          text: "Good find. Patch the restore so it waits for the first paint, then prove it: 15 green runs in a row before you open the PR.",
        },
        steps: [
          { kind: "read", target: "e2e/ac-544-workbench-reopen.spec.ts", meta: "212 lines" },
          { kind: "search", target: "waitForScroll", meta: "4 matches" },
          { kind: "edit", target: "packages/ui/src/lib/wb-probe-cache.ts", add: 12, del: 3 },
          { kind: "run", target: "bun run typecheck", meta: "exit 0 · 18s" },
          { kind: "run", target: "playwright test --repeat-each=15", meta: "2 of 15 failed · 2m", failed: true },
          { kind: "think", target: "The scroll restore runs before the cached files paint. Wait for the first frame, then restore." },
          { kind: "edit", target: "packages/ui/src/workbench/workbench.tsx", add: 6, del: 1 },
          { kind: "run", target: "playwright test --repeat-each=15", meta: "1m 42s", running: true },
        ],
      },
      {
        n: 2,
        from: "11:20",
        took: "9m",
        prompt: { by: "ceo", at: "11:20", text: "Where's the race? Don't patch yet, just tell me." },
        answer:
          "Found it. On reopen, `restoreScroll()` runs as soon as the cache **hydrates**, but the cached file list paints one frame later. When the paint is slow the restore targets a list that is still empty, so it lands at `0`.\n\n```ts\n// workbench.tsx, today\nuseEffect(() => {\n  if (cache.ready) restoreScroll(saved)\n}, [cache.ready])\n```\n\nThe fix is to wait for the first painted frame (`requestAnimationFrame` twice) before restoring. It only touches `workbench.tsx` and the probe cache.",
        attachments: [
          {
            kind: "diff",
            path: "packages/ui/src/workbench/workbench.tsx",
            add: 6,
            del: 1,
            lines: [
              { kind: "ctx", text: "useEffect(() => {" },
              { kind: "del", text: "  if (cache.ready) restoreScroll(saved)" },
              { kind: "add", text: "  if (!cache.ready) return" },
              { kind: "add", text: "  // The list paints a frame after the cache hydrates." },
              { kind: "add", text: "  const id = requestAnimationFrame(() =>" },
              { kind: "add", text: "    requestAnimationFrame(() => restoreScroll(saved)))" },
              { kind: "add", text: "  return () => cancelAnimationFrame(id)" },
              { kind: "ctx", text: "}, [cache.ready])" },
            ],
          },
        ],
      },
      {
        n: 1,
        from: "11:02",
        took: "6m",
        prompt: {
          by: "ceo",
          at: "11:02",
          text: "LIL-81: ac-544 fails on main about one run in seven (AC-6, scroll position). Reproduce it first and tell me how often it fails.",
        },
        steps: [
          { kind: "read", target: "e2e/ac-544-workbench-reopen.spec.ts", meta: "212 lines" },
          { kind: "run", target: "playwright test ac-544 --repeat-each=20", meta: "3 of 20 failed · 3m", failed: true },
          { kind: "read", target: "test-results/ac-544-AC-6/trace.zip", meta: "3 traces" },
        ],
        answer:
          "Reproduced: **3 of 20** runs fail, all on AC-6 (*restores the scroll position*). In every failing trace the list is scrolled to `0` instead of `1,840`. Nothing else in the spec fails.",
      },
    ],
  },
  {
    id: "t-hb12-ceo",
    ticketId: "HB-12",
    agentId: "ceo",
    title: "Sign off and ship",
    status: "working",
    startedAt: "12:00",
    minutes: 4,
    step: 6,
    context: 18,
    model: "Opus 5.5 · High",
    folder: "~/Code/heardback",
    branch: "paywall-copy-ab",
    now: { kind: "read", text: "Reading copy.ts", elapsed: "20s" },
    live: {
      cmd: "Reading PR #66 · paywall-copy-ab",
      lines: [
        "src/paywall/variants.ts  +142 −20  ✓ read",
        "src/paywall/Paywall.tsx  +58 −18  ✓ read",
        "src/paywall/copy.ts  +14 −0  reading…",
      ],
    },
    tail: ["PR #66 · 3 files · +214 −38", "2 of 3 files read"],
    plan: [
      { text: "Read the PR", state: "current" },
      { text: "Check Reviewer's screenshots", state: "todo" },
      { text: "Merge and start HB-13", state: "todo" },
    ],
    turns: [
      {
        n: 1,
        from: "woke on Reviewer's result at 12:00",
        took: "4m so far",
        prompt: { by: "reviewer", at: "12:00", text: "Copy B reads better and both variants work on device. Ready for sign-off." },
        steps: [
          { kind: "read", target: "HB-12 · Reviewer's report", meta: "2 screenshots" },
          { kind: "run", target: "gh pr view 66 --json files", meta: "3 files" },
          { kind: "read", target: "src/paywall/variants.ts", meta: "188 lines" },
          { kind: "read", target: "src/paywall/Paywall.tsx", meta: "96 lines" },
          { kind: "think", target: "Variant B's headline is the one readers chose in HB-10. Copy matches the screenshots." },
          { kind: "read", target: "src/paywall/copy.ts", meta: "20s", running: true },
        ],
      },
    ],
  },
  {
    id: "t-hb11",
    ticketId: "HB-11",
    agentId: "marketer",
    title: "Run the Meta Ads test",
    status: "needs",
    // Its hand has been up for the 41 minutes the ask reads (#862: Active
    // orders by when each thread last came back to you).
    cameBackAt: BACK(41),
    startedAt: "10:40",
    minutes: 83,
    step: 31,
    context: 31,
    model: "Sonnet 5 · Medium",
    folder: "~/Code/heardback-growth",
    askId: "a-1",
    quote: "Wants to spend $40 on a 3-day Meta Ads test with the 3 best hooks.",
    plan: [
      { text: "Pick the 3 best hooks", state: "done" },
      { text: "Build 3 ad variants", state: "done" },
      { text: "Get approval to spend", state: "current" },
      { text: "Run 3 days, report Thursday", state: "todo" },
    ],
    turns: [
      {
        n: 2,
        from: "11:10",
        took: "12m",
        prompt: { by: "ceo", at: "11:10", text: "Go with hooks 2, 5 and 11. Budget is your call, but ask Oscar before anything is spent." },
        answer:
          "Three ads are ready, one per hook. **$40** over 3 days buys about 4,000 impressions per hook, which is enough to see a winner.\n\nI've asked Oscar to approve the spend. Nothing goes live until he does.",
        attachments: [{ kind: "sheet", name: "Ad variants · hooks 2, 5, 11", rows: 3 }],
        steps: [
          { kind: "read", target: "hooks/scored.csv", meta: "50 rows" },
          { kind: "edit", target: "ads/meta-test.json", add: 48, del: 0 },
          { kind: "web", target: "business.facebook.com · audience size", meta: "1.2M" },
          { kind: "think", target: "$40 over 3 days gives ~4,000 impressions per hook, enough to see a winner." },
          { kind: "delegate", target: "Asked Oscar: approve $40", meta: "waiting 41m" },
        ],
      },
      {
        n: 1,
        from: "asked by CEO at 10:40",
        took: "30m",
        prompt: { by: "ceo", at: "10:40", text: "HB-11: run a small paid test of the best hooks from HB-9. Pick the three you trust most." },
        answer: "Picked hooks **2, 5 and 11**: they scored highest with readers and each makes a different promise (speed, memory, calm).",
      },
    ],
  },
  {
    id: "t-hb14",
    ticketId: "HB-14",
    agentId: "scout",
    title: "Find 20 journaling creators",
    status: "stuck",
    cameBackAt: BACK(45),
    startedAt: "10:52",
    minutes: 72,
    step: 44,
    context: 67,
    model: "Sonnet 5 · Medium",
    folder: "~/Research/heardback",
    now: { kind: "web", text: "Same web search 6 times", elapsed: "45m" },
    stuck: { what: "Same web search 6 times", detail: ["“journaling creators 5k–50k”", "0 new results since 11:20"] },
    plan: [
      { text: "List search terms", state: "done" },
      { text: "Collect 20 creators", state: "current" },
      { text: "Vet and fill the sheet", state: "todo" },
    ],
    turns: [
      {
        n: 4,
        from: "11:20",
        took: "45m so far",
        steps: [
          { kind: "web", target: "search: journaling creators 5k–50k", meta: "0 new" },
          { kind: "web", target: "search: journaling creators 5k–50k", meta: "0 new" },
          { kind: "think", target: "Maybe the index updated. Try again." },
          { kind: "web", target: "search: journaling creators 5k–50k", meta: "0 new", failed: true },
          { kind: "web", target: "search: journaling creators 5k–50k", meta: "0 new", failed: true },
          { kind: "web", target: "search: journaling creators 5k–50k", meta: "running", running: true },
        ],
      },
      { n: 3, from: "11:05", took: "15m", prompt: { by: "ceo", at: "11:05", text: "Start with the terms most likely to find mid-size creators." }, answer: "Found **7** creators so far (in the sheet). Results are starting to repeat.", attachments: [{ kind: "sheet", name: "creators.csv", rows: 7 }] },
      { n: 2, from: "10:56", took: "9m", answer: "Listed 12 search terms, from “journaling creator” to “bullet journal ASMR”." },
      { n: 1, from: "asked by CEO at 10:52", took: "4m", prompt: { by: "ceo", at: "10:52", text: "HB-14: find 20 journaling creators with 5k–50k followers. Cite every one." }, answer: "Read the brief and HB-9's hooks. Starting with search terms." },
    ],
  },
  {
    id: "t-hb12-rev",
    ticketId: "HB-12",
    agentId: "reviewer",
    title: "Check on device",
    status: "done",
    unseen: true,
    cameBackAt: BACK(27),
    startedAt: "11:20",
    minutes: 18,
    context: 22,
    model: "Sonnet 5 · Medium",
    folder: "~/Code/heardback",
    branch: "paywall-copy-ab",
    quote: "Copy B reads better and both variants work on device. Ready for sign-off.",
    summary: "Ran both variants in the simulator, took 2 screenshots",
    turns: [
      {
        n: 2,
        from: "11:30",
        took: "8m",
        prompt: { by: "ceo", at: "11:30", text: "Run both variants on an iPhone SE and a 15 Pro. Screenshot each paywall." },
        answer: "Copy B reads better and both variants work on device. Ready for sign-off.\n\nOne note: on the **SE**, variant A's headline wraps to three lines and pushes the price below the fold. B fits on two.",
        attachments: [
          { kind: "image", label: "Variant A · iPhone SE" },
          { kind: "image", label: "Variant B · iPhone SE" },
        ],
        steps: [
          { kind: "run", target: "xcrun simctl launch booted app.heardback", meta: "exit 0" },
          { kind: "web", target: "screenshot · Variant A", meta: "saved" },
          { kind: "web", target: "screenshot · Variant B", meta: "saved" },
          { kind: "think", target: "Both render; B's headline wraps cleanly on the SE screen, A's does not." },
        ],
      },
      { n: 1, from: "asked by CEO at 11:20", took: "10m", prompt: { by: "ceo", at: "11:20", text: "HB-12: check PR #66 on a real device before I sign off." }, answer: "Built `paywall-copy-ab` for the simulator; booting both devices." },
    ],
  },
  {
    id: "t-hb12-build",
    ticketId: "HB-12",
    agentId: "builder",
    title: "Build two variants",
    status: "done",
    cameBackAt: BACK(65),
    // The wire flag `autoSettle` is off on this one (#862): it never parks
    // itself while the test runs.
    autoSettleOff: true,
    startedAt: "09:20",
    minutes: 110,
    context: 58,
    model: "Opus 5.5 · High",
    folder: "~/Code/heardback",
    branch: "paywall-copy-ab",
    summary: "Edited 7 files, ran 19 commands · 1 failed run",
    turns: [
      {
        n: 6,
        from: "11:02",
        took: "12m",
        prompt: { by: "ceo", at: "11:02", text: "Tests first, then open the PR." },
        steps: [
          { kind: "run", target: "bun test src/paywall", meta: "1 failed · 22s", failed: true },
          { kind: "edit", target: "src/paywall/variants.test.ts", add: 4, del: 2 },
          { kind: "run", target: "bun test src/paywall", meta: "14 passed · 20s" },
          { kind: "run", target: "gh pr create --fill", meta: "#66" },
        ],
        answer: "Tests are green after one retry: a snapshot still had the old headline. PR **#66** is open with both variants behind the `paywall_copy` flag.",
        attachments: [{ kind: "pr", num: 66, title: "Paywall copy A/B test", branch: "paywall-copy-ab", add: 214, del: 38 }],
      },
      { n: 5, from: "10:40", took: "22m", prompt: { by: "ceo", at: "10:40", text: "Put the two headlines behind a flag, 50/50." }, answer: "Wired the variant flag to the paywall; assignment is sticky per user." },
    ],
  },
  {
    id: "t-hb12-plan",
    ticketId: "HB-12",
    agentId: "ceo",
    title: "Plan the test",
    status: "done",
    cameBackAt: BACK(171),
    startedAt: "09:14",
    minutes: 5,
    context: 9,
    model: "Opus 5.5 · High",
    folder: "~/Code/heardback",
    summary: "Created 4 tickets",
    turns: [{ n: 1, from: "goal Grow HeardBack conversion", took: "5m", summary: "Split the goal into HB-11 … HB-14." }],
  },
  {
    id: "t-hb9",
    ticketId: "HB-9",
    agentId: "scout",
    title: "Collect 50 hooks from X",
    status: "done",
    // The second pin — pinned before the relay chat, so it sits under it
    // (#862: newest pin first).
    pinnedAt: BACK(40),
    cameBackAt: BACK(235),
    startedAt: "08:10",
    minutes: 38,
    context: 40,
    model: "Sonnet 5 · Medium",
    folder: "~/Research/heardback",
    summary: "Read 40 pages, ran 6 commands",
    turns: [{ n: 1, from: "asked by CEO at 08:10", took: "38m", summary: "Collected and scored 50 hooks." }],
  },
  {
    id: "t-lil77",
    ticketId: "LIL-77",
    agentId: "builder",
    title: "Fold the docs into one page",
    status: "done",
    // Asleep on the Snoozed shelf until tomorrow morning (#862).
    snoozedUntil: TOMORROW_9,
    cameBackAt: BACK(121),
    startedAt: "09:15",
    minutes: 47,
    context: 51,
    model: "Opus 5.5 · High",
    folder: "~/Code/LilOS",
    branch: "docs/one-page",
    summary: "Edited 12 files, ran 8 commands",
    turns: [{ n: 1, from: "asked by CEO at 09:15", took: "47m", summary: "PR #64 merged." }],
  },
  {
    id: "t-chat-relay",
    projectId: "lilos",
    agentId: "builder",
    title: "How does the relay store messages?",
    status: "done",
    // The newest pin — first row under Pinned (#862).
    pinnedAt: BACK(25),
    cameBackAt: BACK(25),
    startedAt: "10:20",
    minutes: 6,
    context: 14,
    model: "Opus 5.5 · High",
    folder: "~/Code/LilOS",
    summary: "Answered from schema.ts and the decisions page",
    turns: [
      {
        n: 1,
        from: "you at 10:20",
        took: "2m",
        prompt: { by: "you", at: "10:20", text: "How does the relay store messages? Does it keep the agent's tool calls too?" },
        steps: [
          { kind: "search", target: "messages", meta: "14 matches" },
          { kind: "read", target: "apps/relay/src/db/schema.ts", meta: "286 lines" },
          { kind: "read", target: "docs/index.html#d-25", meta: "decision D-#25" },
        ],
        answer:
          "Only what you see. The relay keeps **visible messages** and LilOS's own records (company, projects, tickets) in SQLite:\n\n```ts\nexport const messages = sqliteTable(\"messages\", {\n  id: text(\"id\").primaryKey(),\n  channelId: text(\"channel_id\").notNull(),\n  author: text(\"author\").notNull(),\n  body: text(\"body\").notNull(),\n  createdAt: integer(\"created_at\").notNull(),\n})\n```\n\nTool calls, reasoning and the full transcript stay in the **engine** (Hermes). That is decision D-#25: one copy of the transcript, so the two can't drift, and no reasoning sits at rest in LilOS.",
      },
      {
        n: 2,
        from: "you at 10:24",
        took: "1m",
        prompt: { by: "you", at: "10:24", text: "So if I delete a thread, the engine still has the transcript?" },
        steps: [{ kind: "read", target: "apps/relay/src/session/directory.ts", meta: "118 lines" }],
        answer:
          "Yes. Removing a thread or an agent drops only the LilOS record. The engine profile and its sessions stay (D-#29), so nothing an agent learned is lost by accident.\n\nWant me to make this a ticket to add a real *Delete transcript* button?",
      },
    ],
  },
  /* #854 demo data: a chat in a folder no project covers (Add as project
     from its chip) and a chat running in a LilOS worktree (files under the
     LilOS project by containment). */
  {
    id: "t-chat-journal",
    agentId: "builder",
    title: "Sketch a journal entry screen",
    status: "done",
    cameBackAt: BACK(190),
    startedAt: "07:40",
    minutes: 12,
    context: 9,
    model: "Opus 5.5 · High",
    folder: "~/Code/journal-app",
    summary: "Drafted the layout, no files saved",
    turns: [
      {
        n: 1,
        from: "you at 07:40",
        took: "3m",
        prompt: { by: "you", at: "07:40", text: "Sketch a minimal journal entry screen for this app." },
        answer:
          "A single card: the date up top, one growing text area, a mood row under it. Save on blur. Want me to scaffold it?",
      },
    ],
  },
  {
    id: "t-chat-wt",
    agentId: "builder",
    title: "Fix the sidebar footer in the worktree",
    status: "done",
    cameBackAt: BACK(300),
    startedAt: "06:55",
    minutes: 18,
    context: 22,
    model: "Opus 5.5 · High",
    folder: "~/Code/LilOS/.lilos/wt/ac-544",
    summary: "Aligned the footer with the row padding",
    turns: [
      {
        n: 1,
        from: "you at 06:55",
        took: "4m",
        prompt: { by: "you", at: "06:55", text: "The sidebar footer sits 2px low in this worktree." },
        answer: "Matched the row padding — the footer now sits on the same baseline.",
      },
    ],
  },
]

/* The Done shelf (#862): the three ways a thread lands there — you marked
   it done yourself (no reason named), the idle sweep parked it after three
   quiet days, or its PR merged. The wire calls the shelf `archivedThreads`;
   Not done brings a row back on top of Active. */
const SETTLED: V3Data["threads"] = [
  {
    id: "t-settle-theme",
    projectId: "qrit",
    agentId: "designer",
    title: "Pick the onboarding theme",
    status: "done",
    startedAt: "Thu 16:40",
    minutes: 22,
    context: 18,
    model: "Sonnet 5 · Medium",
    folder: "~/Code/qrit",
    summary: "Three theme boards with swatches and type",
    settledAt: BACK(2 * 24 * 60),
    turns: [],
  },
  {
    id: "t-settle-search",
    projectId: "heardback",
    agentId: "scout",
    title: "Shortlist journaling blogs",
    status: "done",
    startedAt: "Wed 14:05",
    minutes: 31,
    context: 24,
    model: "Sonnet 5 · Medium",
    folder: "~/Research/heardback",
    summary: "12 blogs with contact emails",
    settledAt: BACK(4 * 24 * 60),
    settledWhy: { kind: "idle" },
    turns: [],
  },
  {
    id: "t-settle-hermes",
    projectId: "lilos",
    agentId: "builder",
    title: "Bump Hermes to 0.14.2",
    status: "done",
    startedAt: "Sun 11:20",
    minutes: 15,
    context: 30,
    model: "Opus 5.5 · High",
    folder: "~/Code/LilOS",
    summary: "Version bump, changelog read, tests green",
    settledAt: BACK(26 * 60),
    settledWhy: { kind: "pr", num: 61, state: "merged" },
    turns: [],
  },
]

const ASKS: V3Data["asks"] = [
  {
    id: "a-1",
    ticketId: "HB-11",
    from: "marketer",
    kind: "approval",
    title: "Approve $40 for the Meta Ads test",
    waiting: 41,
    ask: "Spend $40 on a 3-day Meta Ads test of the 3 best hooks from HB-9.",
    why: "The hooks scored best with 50 readers. Paid traffic is the fastest way to see which one converts.",
    ifYes: "The ads start in 10 minutes. Marketer reports results on Thursday.",
    ifNo: "HB-11 closes. The CEO tries the hooks on TikTok for free instead, about 5 days slower.",
    spend: { amount: 40, used: 112, cap: 300 },
    allowRule: "Let Marketer spend up to $50 without asking",
    fallback: { at: "15:00", does: "denies it" },
  },
  {
    id: "a-2",
    ticketId: "QR-3",
    from: "ceo",
    kind: "question",
    title: "Rename the app to “QRit Pro”?",
    waiting: 12,
    ask: "The Pro tier ships Wednesday. Should the app’s name change with it?",
    why: "“QRit Pro” is free in the App Store. One name is simpler to market; a new name signals the upgrade.",
    ifYes: "Listing, icon label and launch copy say “QRit Pro”. Designer redoes 5 screenshots (about 1h).",
    ifNo: "Pro stays a tier inside QRit. Nothing else changes.",
    options: ["Keep “QRit”", "Rename to “QRit Pro”"],
    fallback: { at: "17:00", does: "keeps “QRit”" },
  },
]

const UPDATES: V3Data["updates"] = [
  {
    id: "u-brief",
    by: "ceo",
    at: "12:04",
    kind: "note",
    text: "The paywall test passed review and I’m reading the PR now; it should ship today. Scout has made no progress on the creator search for 45 minutes, so I’ll hand it to Marketer at 12:30 unless you say otherwise.",
  },
  { id: "u-stuck", by: "ceo", at: "11:50", ticketId: "HB-14", kind: "stuck", text: "Scout has run the same search six times. I’ll hand HB-14 to Marketer at 12:30 unless you stop me." },
  { id: "u-lil81", by: "ceo", at: "11:52", ticketId: "LIL-81", kind: "handed", text: "Asked Builder to patch the scroll restore and prove it with 15 green runs." },
  { id: "u-rev", by: "reviewer", at: "11:38", ticketId: "HB-12", kind: "finished", text: "Copy B reads better and both variants work on device. Ready for sign-off." },
  { id: "u-lil77", by: "builder", at: "10:04", ticketId: "LIL-77", kind: "finished", text: "PR #64 merged: the docs are one page now." },
  { id: "u-plan", by: "ceo", at: "09:14", ticketId: "HB-12", kind: "plan", text: "Split “Grow HeardBack conversion” into four tickets: hooks, ads, paywall test, creators." },
  { id: "u-9am", by: "ceo", at: "09:00", kind: "note", text: "Morning. Six agents, five open tickets, nothing blocked. Today: the paywall test, the flaky e2e test, and QRit’s name." },
]

export const V3_DATA: V3Data = {
  company: "Oscar Co",
  me: "Oscar",
  today: "Monday, 19 October",
  ceoId: "ceo",
  // The picker starts on each agent's own model (outside workers have none).
  agents: [...AGENTS, ...CODING_AGENTS, ...OUTSIDE_WORKERS].map((a) => ({
    ...a,
    modelId: modelIdOf(MODEL_OPTIONS, a.model),
    ...(AGENT_NOTES[a.id] ? { notes: AGENT_NOTES[a.id] } : {}),
  })),
  skills: SKILLS,
  connectors: CONNECTORS,
  projects: PROJECTS,
  goals: GOALS,
  tickets: [...TICKETS, ...OUTSIDE_TICKETS],
  threads: [...THREADS, ...CODING_THREADS, ...ATTENTION_THREADS, ...OUTSIDE_THREADS].map((t) =>
    WORKBENCHES[t.id] ? { ...t, workbench: WORKBENCHES[t.id] } : t,
  ),
  archivedThreads: SETTLED,
  asks: [...ASKS, ...ATTENTION_ASKS, ...CODING_ASKS],
  updates: UPDATES,
  schedules: SCHEDULES,
  browser: BROWSER,
  devices: DEVICES,
  modelChoices: ["Opus 5.5 · High", "Sonnet 5 · Medium", "Haiku 5 · Fast"],
  hireTemplates: HIRE_TEMPLATES,
  /* The runtime roster `system.status.runtimes` would report (D-#761): the
     default engine first, then the coding runtimes — two installed, two
     greyed with the probe's reason, so the add-agent dialog shows a Who?
     like the real app's (#870). */
  runtimes: [
    /* #872 — `updatable`/`models`/`tone` are what the agent page reads per
       runtime: each coding runtime lists its own picker's labels and the
       fields its engine takes (ACP declares all four), and `tone` is its
       agents' avatar colour. An unavailable row has never been described —
       its agents' fields stay read-only, schedules grey with the reason. */
    {
      id: "hermes",
      label: "Hermes",
      available: true,
      isDefault: true,
      updatable: ["name", "description", "soul", "model"],
      models: ["Opus 5.5 · High", "Sonnet 5 · Medium", "Haiku 5 · Fast"],
    },
    {
      id: "acp:devin",
      label: "Devin",
      available: true,
      tone: "b",
      updatable: ["name", "description", "soul", "model"],
      models: ["SWE-2 · High", "SWE-2 · Medium", "SWE-2 · Low"],
    },
    {
      id: "acp:claude",
      label: "Claude Code",
      available: true,
      tone: "m",
      updatable: ["name", "description", "soul", "model"],
      models: [
        "Opus 5.5 · High",
        "Opus 5.5 · Medium",
        "Sonnet 5 · Medium",
        "Haiku 5 · Fast",
      ],
    },
    {
      id: "acp:cursor",
      label: "Cursor",
      available: false,
      tone: "r",
      detail: "cursor-agent is not on PATH",
    },
    {
      id: "acp:antigravity",
      label: "Antigravity",
      available: false,
      tone: "s",
      detail: "antigravity is not installed — install it and restart LilOS",
    },
  ],
  // The new-chat box shows the engine's full picker (effort, Fast, Edit models).
  modelCatalog: {
    options: MODEL_OPTIONS,
    defaultModel: "sonnet",
    defaultProvider: "anthropic",
    providers: MODEL_PROVIDERS,
    visibility: MODEL_VISIBILITY,
    refreshable: true,
  },
  // A chat opens on the access you pick (Ask / Full access).
  chatAccess: true,
  // The wire's caps (10 MB a file, 10 a message), so the prototype refuses what the app would.
  attachLimits: { maxFileBytes: 10 * 1024 * 1024, maxFiles: 10 },
  // The mock engine accepts every profile field.
  agentFields: ["description", "model", "instructions"],
  starters: ["Why is ac-544 flaky?", "Summarise yesterday's PRs", "Draft release notes for 0.9"],
  settings: SETTINGS,
  // ?v3&page=welcome shows first run; the rest of the company is ready.
  setUp: true,
  /* The prototype is LilOS the daily app (D-#836): the company layer is
     paused in the UI, never deleted — every ticket, goal, the CEO and the
     roster stay in this data and every action still works. `?company=1`
     shows the layer again, the same records it always had. */
  features: {
    tickets: true,
    company:
      typeof location !== "undefined" &&
      new URLSearchParams(location.search).get("company") === "1",
  },
}

/* The fake CEO behind ⌘K. A question gets a reply built from the live data;
   anything else becomes a draft plan under the project the line names. */
export function v3Draft(text: string, d: V3Data): V3Draft {
  const t = text.trim()
  const lower = t.toLowerCase()
  if (t.endsWith("?") || /^(how|what|why|who|when|where|is|are|did|does|can)\b/.test(lower)) {
    const working = d.threads.filter((x) => x.status === "working").length
    const stuck = d.tickets.filter((x) => x.status === "stuck")
    return {
      kind: "answer",
      text: `${working} agents are working right now and ${d.asks.length} ${d.asks.length === 1 ? "thing waits" : "things wait"} on you.${
        stuck.length ? ` ${stuck.map((x) => `${x.id} is stuck (${x.stuckWhy})`).join("; ")}; I’m handling it at 12:30.` : ""
      } Everything else is on schedule.`,
    }
  }
  const project = d.projects.find((p) => lower.includes(p.name.toLowerCase())) ?? d.projects.find((p) => p.id === "qrit")!
  let n = Math.max(0, ...d.tickets.filter((x) => x.projectId === project.id).map((x) => Number(x.id.split("-")[1])))
  const id = () => `${project.key}-${++n}`
  const goal = d.goals.find((g) => g.projectId === project.id)
  if (/launch|product hunt|post|announce/.test(lower)) {
    const [a, b, c, e] = [id(), id(), id(), id()]
    return {
      kind: "plan",
      goalId: goal?.id,
      lead: `I’ll split this into four tickets under ${goal?.title ?? project.name}. Everything is ready the evening before; the post goes live at 00:01 PT.`,
      hours: 7,
      cost: 6,
      tickets: [
        { id: a, title: "Launch copy and first comment", owner: "marketer", est: "1h" },
        { id: b, title: "Five gallery images, 1270×760", owner: "designer", after: a, est: "2h" },
        { id: c, title: "A 40-second demo video", owner: "builder", est: "2h" },
        { id: e, title: "Schedule the post", owner: "marketer", after: "all three", est: "20m", asksYou: true },
      ],
    }
  }
  const [a, b, c] = [id(), id(), id()]
  return {
    kind: "plan",
    goalId: goal?.id,
    lead: `I’ll research it first, build the smallest version that answers it, and have Reviewer check it before it reaches you.`,
    hours: 4,
    cost: 3,
    tickets: [
      { id: a, title: `Research: ${t}`, owner: "scout", est: "45m" },
      { id: b, title: `Build: ${t}`, owner: "builder", after: a, est: "2h" },
      { id: c, title: "Check it on a real device", owner: "reviewer", after: b, est: "30m" },
    ],
  }
}

/* Every profile the mock engine has: what "Or bring in an existing profile" on
   Hire lists. The page leaves out the ones an agent already runs on, so only
   Ops and the Librarian show until someone is removed (removing an agent
   never deletes its profile, D-#29). */
export const ENGINE_PROFILES: V3Profile[] = [
  { id: "ceo", name: "Chief", model: "Opus 5.5 · High", skills: 3 },
  { id: "builder", name: "Builder", model: "Opus 5.5 · High", skills: 3 },
  { id: "reviewer", name: "Reviewer", model: "Sonnet 5 · Medium", skills: 2 },
  { id: "marketer", name: "Marketer", model: "Sonnet 5 · Medium", skills: 3 },
  { id: "scout", name: "Scout", model: "Sonnet 5 · Medium", skills: 3 },
  { id: "designer", name: "Designer", model: "Sonnet 5 · Medium", skills: 2 },
  {
    id: "ops",
    name: "Ops",
    description: "Runs the dev server and the nightly chores.",
    model: "Haiku 5 · Fast",
    skills: 14,
    soul: "You keep the dev server and the nightly jobs healthy. Restart what is stuck, report what you could not fix.",
  },
  {
    id: "librarian",
    name: "Librarian",
    description: "Keeps the notes and the research sheets tidy.",
    model: "Sonnet 5 · Medium",
    skills: 6,
    soul: "You file every sheet and note where the team will look for it, and say where you put it.",
  },
  /* The coding runtimes' roster seeds (D-#761): `agents.list` merges them in
     before the runtime has ever started, stamped with the runtime they
     belong to — the add-agent dialog folds each into its runtime's row. */
  {
    id: "devin",
    name: "Devin",
    description: "Coding agent by Cognition.",
    skills: 0,
    runtime: "acp:devin",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Coding agent by Anthropic.",
    skills: 0,
    runtime: "acp:claude",
  },
]
