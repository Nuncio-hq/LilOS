import type { V2Connector, V2Goal, V2Ticket, V2Thread } from "@lilos/ui"

/* Mock data for the AI company inside v2 (#746): goals, tickets with one
   assignee, connectors, and the CEO's thread. The outside workers are named
   only here, in mock data and in the connector list, never in packages/ui.
   The grokbot trails follow a real test run on the test bot (2026-10-15):
   it started a cloud coding agent on Linux and ran read-only commands on the
   owner's Mac. Not a contract. */

export const V2_CONNECTORS: V2Connector[] = [
  {
    id: "grokbot",
    name: "grokbot",
    kind: "mcp",
    command: "npx -y grokbot-mcp",
    about: "Always-on bots with a cloud computer; can start cloud coding agents and work on your Mac",
    state: "ready",
    agentIds: ["ceo"],
    workers: ["HB Team Lead", "HB Marketing", "HB Dev"],
  },
  {
    id: "muse",
    name: "muse",
    kind: "cli",
    command: "muse",
    about: "Personal agent with Meta apps: Meta Ads, Instagram, WhatsApp",
    state: "signed-out",
    agentIds: ["ceo"],
    workers: ["Meta Ads"],
  },
  {
    id: "posthog",
    name: "posthog",
    kind: "mcp",
    command: "https://mcp.posthog.com/mcp",
    about: "Product analytics: funnels, trends, session replays",
    state: "ready",
    agentIds: ["research", "ceo"],
  },
]

export const V2_GOALS: V2Goal[] = [
  { id: "g-conv", title: "Grow HeardBack's paywall conversion", projectId: "heardback" },
  { id: "g-health", title: "Keep grokbot-cli healthy", projectId: "lilos" },
]

const out = (name: string, connectorId: string) => ({ kind: "outside" as const, name, connectorId })

export const V2_TICKETS: V2Ticket[] = [
  {
    id: "HB-9", title: "Scrape competitor hooks on X", goalId: "g-conv", projectId: "heardback",
    assignee: out("HB Marketing", "grokbot"), state: "working", ago: 1, threadId: "t-ceo",
    line: "Reading the top 40 posts on its cloud browser",
    trail: [
      { kind: "handoff", who: "CEO", text: "Find the 20 best-performing journaling app hooks on X this month.", time: "09:15" },
      { kind: "note", who: "HB Marketing", text: "On it. Searching X for journaling apps with 5k+ likes.", time: "09:16" },
      { kind: "command", who: "HB Marketing", where: "Cloud · Linux", text: "x search 'journaling app' min_faves:5000 since:2026-09-15", meta: "212 posts", time: "09:18" },
      { kind: "output", who: "HB Marketing", text: "shared/hooks/x-scrape.csv", meta: "212 rows", time: "09:24" },
      { kind: "note", who: "HB Marketing", where: "Cloud · Linux", text: "Reading the top 40 posts on its cloud browser", time: "09:31", live: true },
    ],
  },
  {
    id: "HB-10", title: "Draft 15 ad hooks from the scrape", goalId: "g-conv", projectId: "heardback",
    assignee: { kind: "agent", agentId: "marketer" }, state: "todo", ago: 30, threadId: "t-ceo",
    line: "Waits for HB-9",
    trail: [{ kind: "handoff", who: "CEO", text: "Once HB-9 lands: 15 hooks, plain and warm, no competitor names.", time: "09:15" }],
  },
  {
    id: "HB-11", title: "Test the best 3 hooks on Meta Ads", goalId: "g-conv", projectId: "heardback",
    assignee: out("Meta Ads", "muse"), state: "needs", ago: 6, threadId: "t-ceo",
    line: "Asks to spend $40",
    ask: { text: "Run a $40, 3-day test of 3 hooks on Meta Ads?", risk: "spends-money" },
    trail: [
      { kind: "handoff", who: "CEO", text: "Set up a small A/B test for the 3 best hooks. Ask before spending.", time: "09:15" },
      { kind: "command", who: "Meta Ads", where: "Meta Ads Manager", text: "Draft campaign · 3 ad sets · AU, 25-40", meta: "draft", time: "09:40" },
      { kind: "ask", who: "Meta Ads", text: "Run a $40, 3-day test of 3 hooks on Meta Ads?", time: "09:42" },
      { kind: "note", who: "CEO", text: "Spending money: sent to Oscar.", time: "09:42" },
    ],
  },
  {
    id: "HB-12", title: "Ship a paywall copy A/B test", goalId: "g-conv", projectId: "heardback",
    assignee: out("HB Dev", "grokbot"), state: "checking", ago: 4, threadId: "t-ceo",
    line: "CEO is reading PR #66",
    trail: [
      { kind: "handoff", who: "CEO", text: "Ship a paywall copy A/B test behind a flag, two variants.", time: "09:15" },
      { kind: "helper", who: "HB Dev", where: "Cloud · Linux", text: "Started a cloud coding agent on oscarlehuu/heardback", meta: "bc-7f3a…", link: "https://cursor.com/agents", time: "09:17" },
      { kind: "command", who: "Cloud agent", where: "Cloud · Linux", text: "bun test", meta: "62 passed", time: "09:52" },
      { kind: "output", who: "Cloud agent", text: "Opened PR #66: paywall copy A/B test", meta: "PR #66", time: "09:58" },
      { kind: "note", who: "HB Dev", text: "PR #66 is ready, checks green.", time: "09:59" },
      { kind: "check", who: "CEO", text: "Reading the diff and the flag wiring", time: "10:03", live: true },
    ],
  },
  {
    id: "LIL-1", title: "Count the .ts files in grokbot-cli", goalId: "g-health", projectId: "lilos",
    assignee: out("Primary Test", "grokbot"), state: "done", ago: 40,
    line: "192 files · matches the checkout",
    trail: [
      { kind: "handoff", who: "CEO", text: "Read-only: start one cloud agent on Nuncio-hq/grokbot-cli and count .ts files under packages/.", time: "23:24" },
      { kind: "note", who: "Primary Test", text: "Starting the cloud agent now.", time: "23:24" },
      { kind: "helper", who: "Primary Test", where: "Cloud · Linux", text: "Started a cloud coding agent on Nuncio-hq/grokbot-cli", meta: "bc-13e92a78…", link: "https://cursor.com/agents", time: "23:24" },
      { kind: "command", who: "Cloud agent", where: "Cloud · Linux", text: "uname -a; cat /etc/os-release | head -3; node --version", meta: "Ubuntu 24.04 · Node 22", time: "23:25" },
      { kind: "output", who: "Cloud agent", text: "192 .ts files under packages/, no changes made", time: "23:25" },
      { kind: "check", who: "CEO", text: "Matches the local checkout (192).", time: "23:25" },
    ],
  },
  {
    id: "LIL-2", title: "Check the Mac's macOS version", goalId: "g-health", projectId: "lilos",
    assignee: out("Primary Test", "grokbot"), state: "done", ago: 38,
    line: "macOS 26.5.2 · arm64",
    trail: [
      { kind: "handoff", who: "CEO", text: "Read-only: run sw_vers and uname on Oscar's Mac.", time: "23:26" },
      { kind: "note", who: "Primary Test", text: "Running it on your Mac now.", time: "23:26" },
      { kind: "command", who: "Primary Test", where: "Your Mac", text: "sw_vers -productVersion; uname -m", meta: "exit 0", time: "23:26" },
      { kind: "output", who: "Primary Test", text: "26.5.2 · arm64", time: "23:26" },
      { kind: "check", who: "CEO", text: "Matches the machine.", time: "23:27" },
    ],
  },
]

/* The CEO's own thread: Oscar hands off a goal, the CEO answers with its
   plan and the tickets it opened. */
export const V2_CEO_THREAD: V2Thread = {
  id: "t-ceo", title: "Grow HeardBack's paywall conversion", projectId: "heardback", agentId: "ceo",
  model: "Claude Opus 5.5", state: "working", ago: 1,
  line: "Following 4 tickets",
  messages: [
    { from: "you", time: "09:12", text: "Grow conversion for HeardBack. Start with the paywall." },
    {
      from: "agent", time: "09:15",
      work: [
        { kind: "web", target: "PostHog · onboarding funnel, last 30 days" },
        { kind: "task", target: "ticket_create HB-9 → HB Marketing (grokbot)" },
        { kind: "task", target: "ticket_create HB-10 → Marketer" },
        { kind: "task", target: "ticket_create HB-11 → Meta Ads (muse)" },
        { kind: "task", target: "ticket_create HB-12 → HB Dev (grokbot)" },
      ],
      text: "61% leave at the paywall. Plan: scrape hooks on X (HB-9), draft 15 hooks (HB-10), test the best 3 on Meta Ads (HB-11, will ask you before spending), and ship a paywall copy A/B test (HB-12). I'll check each result before it counts as done.",
    },
  ],
}
