import type { V2Connector, V2Goal, V2Mark, V2Ticket, V2Thread } from "@lilos/ui"

/* Mock data for the AI company inside v2 (#746): goals, tickets with one
   assignee, connectors, and the CEO's thread. The outside workers are named
   only here, in mock data and in the connector list, never in packages/ui.
   The grokbot trails follow a real test run on the test bot (2026-10-15):
   it started a cloud coding agent on Linux and ran read-only commands on the
   owner's Mac. Not a contract. */

/* Each connector brings its own look: an MCP server publishes it in
   serverInfo (title + icons), a CLI gets it when Oscar adds it. These marks
   are that data (from models.dev); LilOS UI code never names a provider.
   Brand marks are their owners' trademarks. */
const GROK_MARK: V2Mark = {
  viewBox: "0 0 40 40",
  d: "M12.4579 15.6036L26.1529 35H20.0656L6.37059 15.6036H12.4579ZM12.4524 26.3764L15.4974 30.6909L12.4551 35H6.36377L12.4524 26.3764ZM33.6365 7.15727V35H28.647V14.2236L33.6365 7.15727ZM33.6365 5L20.0656 24.2205L17.0206 19.9073L27.5451 5H33.6365Z",
}
const META_MARK: V2Mark = {
  viewBox: "0 0 40 40",
  d: "M27.1942 9.03509C24.4881 9.03509 22.3726 11.0731 20.4574 13.6623C17.8258 10.3114 15.6255 9.03509 12.9925 9.03509C7.62404 9.03509 3.51001 16.0234 3.51001 23.4181C3.51001 28.0453 5.74831 30.9649 9.49831 30.9649C12.1971 30.9649 14.1387 29.693 17.5904 23.6594C17.5904 23.6594 19.029 21.1199 20.0173 19.3699C20.3643 19.9293 20.7298 20.5327 21.1138 21.1798L22.7322 23.902C25.8843 29.1769 27.6416 30.9649 30.8229 30.9649C34.4778 30.9649 36.51 28.0058 36.51 23.2822C36.51 15.538 32.3039 9.03509 27.1942 9.03509ZM14.9574 22.0263C12.1606 26.4123 11.1928 27.3962 9.63574 27.3962C8.03194 27.3962 7.07872 25.9883 7.07872 23.4781C7.07872 18.1096 9.75562 12.6199 12.9471 12.6199C14.6752 12.6199 16.1197 13.617 18.3316 16.7836C16.2308 20.0058 14.9574 22.0263 14.9574 22.0263ZM25.5202 21.4751L23.5831 18.2456C23.0969 17.4514 22.5938 16.6676 22.0743 15.8947C23.8185 13.2032 25.2556 11.8611 26.9676 11.8611C30.5202 11.8611 33.3638 17.095 33.3638 23.5219C33.3638 25.9722 32.5612 27.3947 30.8989 27.3947C29.3053 27.3947 28.5451 26.3421 25.5188 21.4737",
}

export const V2_CONNECTORS: V2Connector[] = [
  {
    id: "grokbot",
    name: "grokbot",
    label: "Grok Bot",
    mark: GROK_MARK,
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
    label: "Muse",
    mark: META_MARK,
    color: "#0866FF",
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
    label: "PostHog",
    color: "#F54E00",
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
    ask: { text: "Only English posts, or other languages too?", ceoAnswer: "English only for now." },
    trail: [
      { kind: "handoff", who: "CEO", text: "Find the 20 best-performing journaling app hooks on X this month.", time: "09:15" },
      { kind: "note", who: "HB Marketing", text: "On it. Searching X for journaling apps with 5k+ likes.", time: "09:16" },
      { kind: "command", who: "HB Marketing", where: "Cloud · Linux", text: "x search 'journaling app' min_faves:5000 since:2026-09-15", meta: "212 posts", time: "09:18" },
      { kind: "output", who: "HB Marketing", text: "shared/hooks/x-scrape.csv", meta: "212 rows", time: "09:24" },
      { kind: "ask", who: "HB Marketing", text: "Only English posts, or other languages too?", time: "09:26" },
      { kind: "note", who: "CEO", text: "Answered: English only for now.", time: "09:26" },
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
    assignee: out("Primary Test", "grokbot"), state: "done", ago: 40, threadId: "t-ceo-health",
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
    assignee: out("Primary Test", "grokbot"), state: "done", ago: 38, threadId: "t-ceo-health",
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
  ticketIds: ["HB-9", "HB-10", "HB-11", "HB-12"],
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

/* An older CEO session, so the dock's session picker has something to pick. */
export const V2_CEO_THREAD_OLD: V2Thread = {
  id: "t-ceo-health", title: "Keep grokbot-cli healthy", projectId: "lilos", agentId: "ceo",
  ticketIds: ["LIL-1", "LIL-2", "HB-9"],
  model: "Claude Opus 5.5", state: "unseen", ago: 38,
  line: "2 tickets done, both checked",
  messages: [
    { from: "you", time: "23:22", text: "Check grokbot-cli is healthy. Read-only, test bot only." },
    {
      from: "agent", time: "23:27",
      work: [
        { kind: "task", target: "ticket_create LIL-1 → Primary Test (grokbot)" },
        { kind: "task", target: "ticket_create LIL-2 → Primary Test (grokbot)" },
      ],
      text: "Both done. LIL-1: a cloud agent on Linux counted 192 .ts files, which matches the checkout. LIL-2: your Mac runs macOS 26.5.2 on arm64. Nothing was changed.",
    },
    { from: "you", time: "23:31", ticketId: "HB-9", text: "Is the X scrape bot running on the same cloud computer as the test bot?" },
    { from: "agent", time: "23:32", text: "Yes. HB-9's bot and the test bot share one Grok Bot cloud computer, each with its own desktop and folder." },
  ],
}
