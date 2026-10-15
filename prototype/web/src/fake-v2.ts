import type { V2Activity, V2Agent, V2Project, V2Step, V2Thread } from "@lilos/ui"

/* Mock data for the UX v2 prototype (?v2): threads by project, the agent
   is a per-thread pick. Not a contract. */

export const V2_PROJECTS: V2Project[] = [
  { id: "lilos", name: "LilOS", path: "~/Desktop/Oscar/LilOS" },
  { id: "heardback", name: "HeardBack", path: "~/Desktop/Oscar/heardback" },
  { id: "qrit", name: "QRit", path: "~/Desktop/Oscar/QRit" },
  { id: "none", name: "No project" },
]

export const V2_AGENTS: V2Agent[] = [
  { id: "builder", name: "Builder", role: "Full-stack engineer", runtime: "hermes", model: "Claude Opus 5.5", skills: 18 },
  { id: "reviewer", name: "Reviewer", role: "Reviews diffs and tests", runtime: "hermes", model: "Claude Sonnet 5", skills: 9 },
  { id: "marketer", name: "Marketer", role: "Copy and launch plans", runtime: "hermes", model: "GPT-6 Astra", skills: 6 },
  { id: "research", name: "Research", role: "Deep research with sources", runtime: "hermes", model: "GPT-6 Astra", skills: 11 },
  { id: "default", name: "Default", role: "Your main Hermes profile", runtime: "hermes", model: "Claude Opus 5.5", skills: 42 },
  { id: "claude-code", name: "Claude Code", role: "", runtime: "claude-code", soon: true },
  { id: "codex", name: "Codex", role: "", runtime: "codex", soon: true },
  { id: "grok-bot", name: "Grok Bot", role: "", runtime: "grok-bot", soon: true },
  { id: "muse", name: "Muse", role: "", runtime: "muse", soon: true },
]

const DOCS_WORK: V2Step[] = [
  { kind: "read", target: "docs/DECISIONS.md" },
  { kind: "read", target: "docs/ARCHITECTURE.md" },
  { kind: "read", target: "AGENTS.md" },
  { kind: "search", target: "DECISIONS.md", meta: "18 matches" },
  { kind: "edit", target: "docs/index.html", add: 512, del: 0 },
  { kind: "edit", target: "AGENTS.md", add: 38, del: 156 },
  { kind: "bash", target: "python3 convert_decisions.py docs/DECISIONS.md", meta: "90 entries" },
  { kind: "edit", target: "packages/contracts/test/repo-hygiene.test.ts", add: 2, del: 2 },
  { kind: "bash", target: "bun run verify:fast", meta: "exit 0" },
]
const REVIEW_WORK: V2Step[] = [
  { kind: "bash", target: "gh pr diff 748", meta: "12 files" },
  { kind: "read", target: "packages/ui/src/company/company-view.tsx" },
  { kind: "read", target: "packages/ui/src/company/ticket-board.tsx" },
  { kind: "read", target: "prototype/web/src/fake-company.ts" },
  { kind: "bash", target: "bunx tsc -b packages/ui prototype/web", meta: "exit 0" },
]
const FLAKY_WORK: V2Step[] = [
  { kind: "read", target: "e2e/ac-544-workbench-reopen.spec.ts" },
  { kind: "search", target: "slowstart:", meta: "4 matches" },
  { kind: "read", target: "test-results/ac-544-AC-6/trace.zip" },
  { kind: "edit", target: "e2e/ac-544-workbench-reopen.spec.ts", add: 9, del: 3 },
]
const WAL_WORK: V2Step[] = [
  { kind: "read", target: "apps/relay/src/db.ts" },
  { kind: "edit", target: "apps/relay/src/migrations/v14-wal.ts", add: 41, del: 0 },
  { kind: "bash", target: "cp ~/.lilos/relay.db /tmp/relay-copy.db" },
  { kind: "bash", target: "bun apps/relay/scripts/migrate.ts /tmp/relay-copy.db", meta: "exit 1", failed: true },
]
const PAYWALL_WORK: V2Step[] = [
  { kind: "read", target: "src/paywall/PaywallScreen.tsx" },
  { kind: "read", target: "src/flags.ts" },
  { kind: "edit", target: "src/paywall/PaywallScreen.tsx", add: 48, del: 12 },
  { kind: "edit", target: "src/flags.ts", add: 6, del: 0 },
  { kind: "edit", target: "src/analytics/events.ts", add: 9, del: 1 },
  { kind: "bash", target: "bun test", meta: "62 passed" },
  { kind: "bash", target: "gh pr create --draft", meta: "PR #66" },
]

export const V2_ACTIVITY: V2Activity[] = [
  { id: "a1", agentId: "marketer", verb: "started", object: "Reply to this week's App Store reviews", threadId: "t-reviews", projectId: "heardback", ago: 2 },
  { id: "a2", agentId: "builder", verb: "is running", object: "the ac-544 spec 15 times", threadId: "t-544", projectId: "lilos", ago: 3 },
  { id: "a3", agentId: "reviewer", verb: "asked to run", object: "the full e2e suite", threadId: "t-748", projectId: "lilos", ago: 6 },
  { id: "a4", agentId: "marketer", verb: "asked", object: "if hooks may name competitors", threadId: "t-hooks", projectId: "heardback", ago: 7 },
  { id: "a5", agentId: "builder", verb: "finished", object: "Paywall copy A/B test (PR #66)", threadId: "t-paywall", projectId: "heardback", ago: 18 },
  { id: "a6", agentId: "builder", verb: "finished", object: "Fold the docs into one HTML page (PR #747)", threadId: "t-747", projectId: "lilos", ago: 22 },
  { id: "a7", agentId: "default", verb: "finished", object: "What's on my calendar today?", threadId: "t-cal", projectId: "none", ago: 30 },
  { id: "a8", agentId: "builder", verb: "failed on", object: "Move the relay database to WAL", threadId: "t-wal", projectId: "lilos", ago: 35 },
  { id: "a9", agentId: "marketer", verb: "finished", object: "Onboarding copy pass", threadId: "t-onboard", projectId: "qrit", ago: 95 },
  { id: "a10", agentId: "research", verb: "finished", object: "Onboarding funnel audit", threadId: "t-funnel", projectId: "heardback", ago: 300 },
]

export const V2_MODELS = ["Claude Opus 5.5", "Claude Sonnet 5", "GPT-6 Astra", "Qwen 3.8 Flash-Next", "Grok 4.6"]

const OPUS = V2_MODELS[0]
const SONNET = V2_MODELS[1]
const ASTRA = V2_MODELS[2]

const HAND: V2Thread[] = [
  {
    id: "t-748", title: "Review the Company screen PR", projectId: "lilos", agentId: "reviewer", model: SONNET, state: "needs", ago: 6,
    line: "Run the full e2e suite?",
    ask: { kind: "approval", text: "Run the full e2e suite on this branch?", detail: "bun run test:e2e  (about 6 minutes)" },
    messages: [
      { from: "you", time: "11:40", text: "Review #748 against its acceptance criteria. Product behaviour first, then code." },
      { from: "agent", time: "11:47", work: REVIEW_WORK, text: "The screen matches the three criteria. Two small issues: the ticket board columns were 116px wide on a 1600px window (already fixed in the branch), and Approve doesn't move focus back to the board. Before I sign off I'd like to run the e2e suite once." },
    ],
  },
  {
    id: "t-747", title: "Fold the docs into one HTML page", projectId: "lilos", agentId: "builder", model: OPUS, state: "unseen", ago: 22,
    line: "PR #747 is up. 90 decisions kept",
    messages: [
      { from: "you", time: "10:30", text: "Move every doc into docs/index.html. Keep AGENTS.md short. Don't lose a single decision." },
      { from: "agent", time: "11:21", work: DOCS_WORK, changes: [
          { path: "docs/index.html", add: 512, del: 0 },
          { path: "AGENTS.md", add: 38, del: 156 },
          { path: "docs/DECISIONS.md", add: 0, del: 571 },
          { path: "packages/contracts/test/repo-hygiene.test.ts", add: 2, del: 2 },
        ], preview: { path: "AGENTS.md", lines: [
          { kind: "del", text: "## Repo map" },
          { kind: "del", text: "| Path | What |" },
          { kind: "add", text: "**Read `docs/index.html` first.** It is the one document:" },
          { kind: "add", text: "what LilOS is, the repo map, every decision in force." },
          { kind: "ctx", text: "" },
          { kind: "ctx", text: "## Hard rules" },
        ] }, text: "PR #747 is up. docs/index.html now holds the vision, the architecture, all 90 decisions (each with its own link) and the runbooks. AGENTS.md is a short rule list. I checked the decisions word for word against the old file, and verify:fast passes." },
    ],
  },
  {
    id: "t-544", title: "Fix the flaky ac-544 e2e test", projectId: "lilos", agentId: "builder", model: OPUS, state: "working", ago: 3,
    line: "Running the spec 15 times",
    live: { step: { kind: "bash", target: "bunx playwright test e2e/ac-544-workbench-reopen.spec.ts -g AC-6 --repeat-each=15" }, elapsed: "1m 42s", tail: [
      "  ✓  [chromium] › ac-544 › AC-6 pick-hold (8.1s)   run 9/15",
      "  ✓  [chromium] › ac-544 › AC-6 pick-hold (7.9s)   run 10/15",
      "  ✓  [chromium] › ac-544 › AC-6 pick-hold (8.4s)   run 11/15",
    ] },
    messages: [
      { from: "you", time: "11:52", text: "ac-544 AC-6 keeps failing in CI. Find the cause, no timeout bumps." },
      { from: "agent", time: "11:55", work: FLAKY_WORK, text: "The slowstart turn is held while the Files pick lands, then the first live row re-arms follow. I've anchored the spec on the turn-end signal and I'm running it 15 times to prove it." },
    ],
  },
  {
    id: "t-wal", title: "Move the relay database to WAL", projectId: "lilos", agentId: "builder", model: OPUS, state: "failed", ago: 35,
    line: "Migration test failed on 1 row",
    messages: [
      { from: "you", time: "11:05", text: "Switch the relay SQLite to WAL mode and migrate existing data." },
      { from: "agent", time: "11:23", work: WAL_WORK, text: "The migration failed on one message row with an empty channel id (left over from #403). I stopped before touching your real database. Want me to drop that row or repair it?" },
    ],
  },
  {
    id: "t-contract", title: "Draft the bot contract", projectId: "lilos", agentId: "default", model: OPUS, state: "working", ago: 9,
    line: "Writing job.events",
    live: { step: { kind: "edit", target: "packages/contracts/src/bots/jobs.ts", add: 64, del: 0 }, elapsed: "48s" },
    messages: [{ from: "you", time: "11:49", text: "Draft the bot contract for Grok Bot and Muse in packages/contracts." }],
  },
  {
    id: "t-ux", title: "Plan the UX v2 sidebar", projectId: "lilos", agentId: "default", model: OPUS, state: "idle", ago: 4, pinned: true,
    line: "Threads by project, agent as a picker",
    messages: [
      { from: "you", time: "12:01", text: "Too many threads. Give me something I can still scan with 300 of them." },
      { from: "agent", time: "12:04", text: "Threads stay the unit, grouped by project. Running ones fold into one line, old ones settle out of the list on their own, and anything that needs you floats to the top." },
    ],
  },
  {
    id: "t-paywall", title: "Paywall copy A/B test", projectId: "heardback", agentId: "builder", model: SONNET, state: "unseen", ago: 18,
    line: "PR #66 is ready, checks green",
    messages: [
      { from: "you", time: "10:12", text: "Ship a paywall copy A/B test behind a flag. Two variants." },
      { from: "agent", time: "11:44", work: PAYWALL_WORK, changes: [
          { path: "src/paywall/PaywallScreen.tsx", add: 48, del: 12 },
          { path: "src/flags.ts", add: 6, del: 0 },
          { path: "src/analytics/events.ts", add: 9, del: 1 },
        ], preview: { path: "src/paywall/PaywallScreen.tsx", lines: [
          { kind: "ctx", text: "export function PaywallScreen() {" },
          { kind: "del", text: '  const headline = "Unlock HeardBack Pro"' },
          { kind: "add", text: '  const variant = useFlag("paywall-copy")' },
          { kind: "add", text: '  const headline = variant === "b" ? "Hear yourself grow" : "Unlock HeardBack Pro"' },
        ] }, text: "PR #66 adds the flag and both variants, with tracking on the paywall view and purchase. Checks are green." },
    ],
  },
  {
    id: "t-hooks", title: "15 ad hooks from the X scrape", projectId: "heardback", agentId: "marketer", model: ASTRA, state: "needs", ago: 7,
    line: "May the hooks name competitors?",
    ask: { kind: "question", text: "May the hooks name competitors?", options: ["No, describe the problem", "Yes, by name"] },
    messages: [
      { from: "you", time: "11:20", text: "Write 15 ad hooks from yesterday's X scrape. Plain, warm, no hype." },
      { from: "agent", time: "11:55", text: "Ten are drafted. Three of the strongest compare HeardBack to a named competitor. Before I finish, one question." },
    ],
  },
  {
    id: "t-reviews", title: "Reply to this week's App Store reviews", projectId: "heardback", agentId: "marketer", model: ASTRA, state: "working", ago: 2,
    line: "Replying to review 4 of 11",
    live: { step: { kind: "web", target: "appstoreconnect.apple.com · Ratings and Reviews" }, elapsed: "3m 10s" },
    messages: [{ from: "you", time: "11:58", text: "Reply to this week's reviews. Sign as Oscar." }],
  },
  {
    id: "t-creators", title: "Find 20 journaling creators", projectId: "heardback", agentId: "research", model: ASTRA, state: "working", ago: 16,
    line: "Checked 46 accounts",
    live: { step: { kind: "search", target: "journaling creators 5k-50k followers site:instagram.com", meta: "46 checked" }, elapsed: "6m 02s" },
    messages: [{ from: "you", time: "11:44", text: "Find 20 micro-influencers in journaling, 5k to 50k followers." }],
  },
  {
    id: "t-funnel", title: "Onboarding funnel audit", projectId: "heardback", agentId: "research", model: OPUS, state: "idle", ago: 300,
    line: "61% leave at the paywall",
    messages: [
      { from: "you", time: "07:10", text: "Where do people drop off in onboarding?" },
      { from: "agent", time: "07:31", work: [{ kind: "web", target: "PostHog · onboarding funnel, last 30 days" }, { kind: "bash", target: "posthog query funnel --steps 6", meta: "exit 0" }], text: "61% of new users leave at the paywall. Everything before it loses under 8% per screen." },
    ],
  },
  {
    id: "t-rename", title: "Rename the app to QRit Pro", projectId: "qrit", agentId: "default", model: OPUS, state: "needs", ago: 41,
    line: "Keep the old bundle id?",
    ask: { kind: "question", text: "Keep the old bundle id so existing users get the update?", options: ["Keep it", "New bundle id"] },
    messages: [{ from: "you", time: "11:20", text: "Rename the app to QRit Pro everywhere." }, { from: "agent", time: "11:24", text: "The name appears in the App Store listing, Info.plist and the landing page. One question first." }],
  },
  {
    id: "t-onboard", title: "Onboarding copy pass", projectId: "qrit", agentId: "marketer", model: ASTRA, state: "idle", ago: 95,
    line: "Screens 1 to 5 rewritten",
    messages: [{ from: "you", time: "10:26", text: "Tighten the onboarding copy." }, { from: "agent", time: "10:49", text: "All five screens rewritten, each under 12 words." }],
  },
  {
    id: "t-apple", title: "Ask Apple about the review delay", projectId: "qrit", agentId: "default", model: SONNET, state: "snoozed", ago: 900, until: "Mon 9:00",
    messages: [{ from: "you", time: "Mon", text: "Ask Apple why review is taking so long." }, { from: "agent", time: "Mon", text: "Sent. They usually answer within two days." }],
  },
  {
    id: "t-cal", title: "What's on my calendar today?", projectId: "none", agentId: "default", model: SONNET, state: "unseen", ago: 30,
    line: "3 meetings, first at 10:30",
    messages: [{ from: "you", time: "09:00", text: "What's on my calendar today?" }, { from: "agent", time: "09:00", text: "Three meetings: design review at 10:30, Mira at 13:00, and the weekly at 16:00." }],
  },
]

const OLD = ["Fix a flaky test", "Bump a dependency", "Write release notes", "Answer a support email", "Draft a launch post", "Refactor the settings page", "Investigate a crash report", "Translate onboarding", "Review a dependency PR", "Research a competitor", "Clean up old logs", "Update the runbook", "Price test notes", "Tweak the app icon", "Plan next week"]

/* Deterministic history so the sidebar can be judged at real volume. */
export function v2Threads(total: number): V2Thread[] {
  let seed = 117
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const out = HAND.slice()
  for (let n = 1; out.length < total; n += 1) {
    const projectId = V2_PROJECTS[Math.floor(rand() * 3)].id
    out.push({
      id: `old-${n}`,
      title: OLD[Math.floor(rand() * OLD.length)],
      projectId,
      agentId: V2_AGENTS[Math.floor(rand() * 5)].id,
      model: V2_MODELS[Math.floor(rand() * V2_MODELS.length)],
      state: "settled",
      ago: 3 * 1440 + Math.floor(rand() * 60 * 1440),
      line: "Finished",
      messages: [{ from: "agent", time: "earlier", text: "Finished." }],
    })
  }
  return out
}
