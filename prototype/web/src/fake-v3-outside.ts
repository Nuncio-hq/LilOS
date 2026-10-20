import type { V3Data } from "@lilos/ui"

/* ?v3 mock: the company's connectors and the outside workers reached through
   them. Provider names, marks and colours live only here (mock data), never in
   packages/ui: the UI reads them from the connector record, the way the real
   app will read an MCP server's serverInfo (#746, #763). */

export const CONNECTORS: V3Data["connectors"] = [
  {
    id: "grokbot",
    label: "Grok Bot",
    kind: "mcp",
    command: "grokbot mcp --stdio",
    about: "Always-on bot: X search, scraping, a cloud browser and cloud coding agents.",
    state: "ready",
    look: { mark: "G", color: "#111111" },
    agents: ["ceo", "marketer", "scout"],
  },
  {
    id: "muse",
    label: "Muse",
    kind: "mcp",
    command: "muse-mcp --stdio",
    about: "Design bot: ad images, store art and short videos.",
    state: "ready",
    look: { mark: "M", color: "#6d4aff" },
    agents: ["designer", "marketer"],
  },
  {
    id: "gh",
    label: "GitHub CLI",
    kind: "cli",
    command: "gh",
    about: "Pull requests, issues and checks, signed in as the company account.",
    state: "ready",
    look: { mark: "gh", color: "#24292f" },
    agents: ["ceo", "builder", "reviewer"],
  },
  {
    id: "posthog",
    label: "PostHog",
    kind: "mcp",
    command: "https://mcp.posthog.com/sse",
    about: "Product analytics: funnels, events and experiments.",
    state: "signed-out",
    look: { mark: "P", color: "#f54e00" },
    agents: ["marketer"],
  },
  {
    id: "sheets",
    label: "Sheets",
    kind: "mcp",
    command: "sheets-mcp --stdio",
    about: "Read and write spreadsheets.",
    state: "missing",
    look: { mark: "S", color: "#188038" },
    agents: [],
  },
]

const outside = (
  id: string,
  name: string,
  role: string,
  via: string,
  week: V3Data["agents"][number]["week"],
): V3Data["agents"][number] => ({
  id,
  name,
  tone: "n",
  role,
  kind: "outside",
  via,
  reportsTo: "ceo",
  hired: "8 Oct",
  runtime: "",
  model: "",
  schedule: "Always on",
  skills: [],
  spend: { used: 0, cap: 0, period: "week" },
  instructions: [],
  memory: [],
  week,
})

export const OUTSIDE_WORKERS: V3Data["agents"] = [
  outside("hb-marketing", "HB Marketing", "Growth bot", "grokbot", { done: 6, typical: "25m", stuck: 0, handed: 0 }),
  outside("ad-studio", "Ad Studio", "Design bot", "muse", { done: 3, typical: "40m", stuck: 0, handed: 0 }),
]

export const OUTSIDE_TICKETS: V3Data["tickets"] = [
  {
    id: "HB-15",
    title: "Scrape competitor hooks on X",
    projectId: "heardback",
    goalId: "g-hb",
    owner: "hb-marketing",
    status: "working",
    since: 18,
    started: "Today 11:46",
    progress: [
      { text: "Find 10 competing journal apps on X", by: "hb-marketing", took: "6m", state: "done" },
      { text: "Read the top 40 posts of each", by: "hb-marketing", took: "12m so far", state: "current" },
      { text: "Score the hooks and send the sheet", by: "hb-marketing", took: "", state: "todo" },
    ],
    updates: [
      { by: "ceo", ago: 18, text: "Handed to HB Marketing: it can read X at volume without our rate limit." },
    ],
  },
  {
    id: "HB-16",
    title: "Three ad images for the Meta test",
    projectId: "heardback",
    goalId: "g-hb",
    owner: "ad-studio",
    status: "waiting",
    waitingOn: { kind: "ticket", ticketId: "HB-11" },
    since: 41,
    progress: [],
    updates: [{ by: "ceo", ago: 41, text: "Starts once you approve the Meta Ads spend on HB-11." }],
  },
]

export const OUTSIDE_THREADS: V3Data["threads"] = [
  {
    id: "t-hb15",
    ticketId: "HB-15",
    agentId: "hb-marketing",
    title: "Scrape competitor hooks on X",
    status: "working",
    startedAt: "11:46",
    minutes: 18,
    step: 9,
    context: 0,
    model: "",
    folder: "Cloud · Linux",
    now: { kind: "web", text: "Reading posts in a cloud browser", elapsed: "3m 10s" },
    live: {
      cmd: "cloud browser · x.com/search?q=journal app",
      lines: [
        "Daylio · 40 posts read · 6 hooks",
        "Reflectly · 40 posts read · 4 hooks",
        "Day One · 40 posts read · 7 hooks",
        "Stoic · 22 posts read…",
      ],
    },
    tail: ["Day One · 40 posts read · 7 hooks", "Stoic · 22 posts read…"],
    plan: [
      { text: "Find 10 competing apps", state: "done" },
      { text: "Read their top posts", state: "current" },
      { text: "Score the hooks", state: "todo" },
    ],
    changes: [],
    turns: [
      {
        n: 1,
        from: "asked by CEO at 11:46",
        took: "18m so far",
        prompt: {
          by: "ceo",
          at: "11:46",
          text: "HB-15: find 10 journal apps that advertise on X, read their 40 best posts each, and send me the hooks that get the most replies.",
        },
        steps: [
          { kind: "web", target: "search X: journal app", meta: "10 apps", where: "Cloud · Linux" },
          {
            kind: "delegate",
            target: "Started a cloud browser session",
            meta: "running",
            where: "Cloud · Linux",
            helper: { label: "Watch the session", url: "https://example.com/cloud-browser/bc-7f3a" },
          },
          { kind: "web", target: "x.com/daylio · top 40 posts", meta: "6 hooks", where: "Cloud · Linux" },
          { kind: "web", target: "x.com/reflectly · top 40 posts", meta: "4 hooks", where: "Cloud · Linux" },
          { kind: "web", target: "x.com/dayoneapp · top 40 posts", meta: "7 hooks", where: "Cloud · Linux" },
          { kind: "web", target: "x.com/getstoic · top 40 posts", meta: "3m 10s", where: "Cloud · Linux", running: true },
        ],
      },
    ],
  },
]
