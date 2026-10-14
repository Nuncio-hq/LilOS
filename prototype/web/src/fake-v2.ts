import type { V2Agent, V2Project, V2Thread } from "@lilos/ui"

/* Mock data for the UX v2 prototype (?v2): threads by project, the agent
   is a per-thread pick. Not a contract. */

export const V2_PROJECTS: V2Project[] = [
  { id: "lilos", name: "LilOS", path: "~/Desktop/Oscar/LilOS" },
  { id: "heardback", name: "HeardBack", path: "~/Desktop/Oscar/heardback" },
  { id: "qrit", name: "QRit", path: "~/Desktop/Oscar/QRit" },
  { id: "none", name: "No project" },
]

export const V2_AGENTS: V2Agent[] = [
  { id: "builder", name: "Builder", role: "Full-stack engineer", engine: "Hermes" },
  { id: "reviewer", name: "Reviewer", role: "Reviews diffs and tests", engine: "Hermes" },
  { id: "marketer", name: "Marketer", role: "Copy and launch plans", engine: "Hermes" },
  { id: "research", name: "Research", role: "Deep research with sources", engine: "Hermes" },
  { id: "default", name: "Default", role: "Your main Hermes profile", engine: "Hermes" },
  { id: "claude-code", name: "Claude Code", role: "", engine: "Claude Code", soon: true },
  { id: "codex", name: "Codex", role: "", engine: "Codex", soon: true },
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
      { from: "agent", time: "11:47", steps: "Read 12 files", text: "The screen matches the three criteria. Two small issues: the ticket board columns were 116px wide on a 1600px window (already fixed in the branch), and Approve doesn't move focus back to the board. Before I sign off I'd like to run the e2e suite once." },
    ],
  },
  {
    id: "t-747", title: "Fold the docs into one HTML page", projectId: "lilos", agentId: "builder", model: OPUS, state: "unseen", ago: 22,
    line: "PR #747 is up. 90 decisions kept",
    messages: [
      { from: "you", time: "10:30", text: "Move every doc into docs/index.html. Keep AGENTS.md short. Don't lose a single decision." },
      { from: "agent", time: "11:21", steps: "Ran 41 tools · 21 files changed", text: "PR #747 is up. docs/index.html now holds the vision, the architecture, all 90 decisions (each with its own link) and the runbooks. AGENTS.md is a short rule list. I checked the decisions word for word against the old file, and verify:fast passes." },
    ],
  },
  {
    id: "t-544", title: "Fix the flaky ac-544 e2e test", projectId: "lilos", agentId: "builder", model: OPUS, state: "working", ago: 3,
    line: "Running the spec 15 times",
    messages: [
      { from: "you", time: "11:52", text: "ac-544 AC-6 keeps failing in CI. Find the cause, no timeout bumps." },
      { from: "agent", time: "11:55", steps: "Read the harness log", text: "The slowstart turn is held while the Files pick lands, then the first live row re-arms follow. I've anchored the spec on the turn-end signal and I'm running it 15 times to prove it." },
    ],
  },
  {
    id: "t-wal", title: "Move the relay database to WAL", projectId: "lilos", agentId: "builder", model: OPUS, state: "failed", ago: 35,
    line: "Migration test failed on 1 row",
    messages: [
      { from: "you", time: "11:05", text: "Switch the relay SQLite to WAL mode and migrate existing data." },
      { from: "agent", time: "11:23", steps: "Ran 9 tools", text: "The migration failed on one message row with an empty channel id (left over from #403). I stopped before touching your real database. Want me to drop that row or repair it?" },
    ],
  },
  {
    id: "t-contract", title: "Draft the bot contract", projectId: "lilos", agentId: "default", model: OPUS, state: "working", ago: 9,
    line: "Writing job.events",
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
      { from: "agent", time: "11:44", steps: "Ran 26 tools · 7 files changed", text: "PR #66 adds the flag and both variants, with tracking on the paywall view and purchase. Checks are green." },
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
    messages: [{ from: "you", time: "11:58", text: "Reply to this week's reviews. Sign as Oscar." }],
  },
  {
    id: "t-creators", title: "Find 20 journaling creators", projectId: "heardback", agentId: "research", model: ASTRA, state: "working", ago: 16,
    line: "Checked 46 accounts",
    messages: [{ from: "you", time: "11:44", text: "Find 20 micro-influencers in journaling, 5k to 50k followers." }],
  },
  {
    id: "t-funnel", title: "Onboarding funnel audit", projectId: "heardback", agentId: "research", model: OPUS, state: "idle", ago: 300,
    line: "61% leave at the paywall",
    messages: [
      { from: "you", time: "07:10", text: "Where do people drop off in onboarding?" },
      { from: "agent", time: "07:31", steps: "Queried PostHog", text: "61% of new users leave at the paywall. Everything before it loses under 8% per screen." },
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
