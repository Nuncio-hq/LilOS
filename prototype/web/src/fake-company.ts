import type {
  Bot,
  BotAsk,
  CeoInfo,
  CeoTurn,
  CompanyGoal,
  CompanyProject,
  CompanyTicket,
} from "@lilos/ui"

/* Mock AI company (#746): Oscar → CEO → always-on bots from two providers.
   Not a contract — the bot contract lands with its own slice. */

export const CEO: CeoInfo = {
  name: "CEO",
  runtime: "Hermes",
  model: "Claude Opus 5.5",
  state: "working",
  now: "checking HB-12",
}

export const COMPANY_PROJECTS: CompanyProject[] = [
  { id: "heardback", name: "HeardBack" },
  { id: "lilos", name: "LilOS" },
]

export const BOTS: Bot[] = [
  { id: "hb-lead", name: "HB Team Lead", role: "Team lead", provider: "grokbot", projectId: "heardback", state: "working", now: "Splitting the paywall test into steps", strength: "X research, cloud desktop, coding agents" },
  { id: "hb-marketing", name: "HB Marketing", role: "Marketing lead", provider: "grokbot", projectId: "heardback", state: "working", now: "Drafting hook #11 of 15", strength: "Live X trends, copy" },
  { id: "hb-meta-ads", name: "Meta Ads", role: "Paid social", provider: "muse", projectId: "heardback", state: "waiting", now: "Waiting for your OK on a $40 test budget", strength: "Meta Ads, Instagram, Facebook" },
  { id: "hb-dev", name: "HB Dev", role: "Engineer", provider: "grokbot", projectId: "heardback", state: "idle", now: "PR opened, waiting for the CEO's check", strength: "Cloud coding agents, GitHub PRs" },
  { id: "lil-scout", name: "Scout", role: "Research", provider: "grokbot", projectId: "lilos", state: "working", now: "Comparing Paperclip and Muse task models", strength: "Web + X research" },
  { id: "inbox", name: "Inbox", role: "Email & calendar", provider: "muse", state: "idle", now: "Watching founder@ for replies", strength: "Email, calendar, WhatsApp" },
]

export const GOALS: CompanyGoal[] = [
  { id: "g-hb-conv", title: "Grow HeardBack conversion", projectId: "heardback", progress: { done: 2, total: 6 } },
  { id: "g-lil-ceo", title: "LilOS: CEO runs the bots", projectId: "lilos", progress: { done: 0, total: 2 } },
]

export const COMPANY_TICKETS: CompanyTicket[] = [
  { id: "HB-9", title: "Scrape the top 50 competitor hooks on X", goal: "Grow HeardBack conversion", projectId: "heardback", assignee: "hb-marketing", state: "done", update: "50 hooks in /workspace/shared/hooks.csv", updatedAgo: "2h ago" },
  { id: "HB-10", title: "Draft 15 ad hooks from the scrape", goal: "Grow HeardBack conversion", projectId: "heardback", assignee: "hb-marketing", state: "working", update: "10 of 15 drafted", updatedAgo: "4m ago" },
  { id: "HB-11", title: "Run a $40 Meta Ads test on the best 3 hooks", goal: "Grow HeardBack conversion", projectId: "heardback", assignee: "hb-meta-ads", state: "needs-you", update: "Campaign drafted, needs budget approval", updatedAgo: "6m ago" },
  { id: "HB-12", title: "Paywall copy A/B test (PR)", goal: "Grow HeardBack conversion", projectId: "heardback", assignee: "hb-dev", state: "review", update: "PR #66 opened, checks green", updatedAgo: "12m ago" },
  { id: "HB-8", title: "Audit the onboarding funnel", goal: "Grow HeardBack conversion", projectId: "heardback", assignee: "hb-lead", state: "done", update: "Drop-off is at the paywall (61%)", updatedAgo: "yesterday" },
  { id: "HB-13", title: "Reply to App Store reviews from this week", goal: "Grow HeardBack conversion", projectId: "heardback", assignee: "hb-lead", state: "needs-ceo", update: "Asked which tone to use", updatedAgo: "1m ago" },
  { id: "LIL-80", title: "Compare Paperclip and Muse task models", goal: "LilOS: CEO runs the bots", projectId: "lilos", assignee: "lil-scout", state: "working", update: "Paperclip done; reading Muse goals.*", updatedAgo: "9m ago" },
  { id: "LIL-81", title: "Draft the bot contract from what Scout finds", goal: "LilOS: CEO runs the bots", projectId: "lilos", assignee: "lil-scout", state: "todo", update: "Starts after LIL-80", updatedAgo: "—" },
]

export const ASKS: BotAsk[] = [
  { id: "ask-1", ticketId: "HB-11", bot: "hb-meta-ads", text: "Launch a 3-day Meta Ads test with a $40 budget on the 3 best hooks?", risk: "spends-money" },
  { id: "ask-2", ticketId: "HB-13", bot: "hb-lead", text: "Which tone for review replies: playful or plain?", ceoAnswer: "Plain and warm, like the app's onboarding copy. Sign as Oscar." },
  { id: "ask-3", ticketId: "HB-10", bot: "hb-marketing", text: "Can hooks mention competitors by name?", ceoAnswer: "No. Describe the problem, never the competitor." },
]

export const CEO_TURNS: CeoTurn[] = [
  { id: "t1", from: "oscar", time: "09:12", text: "Grow HeardBack's conversion this week. Paywall first. Handing it off to you." },
  { id: "t2", from: "ceo", time: "09:14", text: "On it. HB Team Lead found the drop-off: 61% leave at the paywall. Plan:\n1. Scrape competitor hooks on X and draft 15 ad hooks (HB Marketing).\n2. Test the best 3 on Meta Ads with a small budget (Meta Ads, a Muse bot).\n3. Ship a paywall copy A/B test (HB Dev).\nI'll check each result before it counts as done.", tickets: ["HB-9", "HB-10", "HB-11", "HB-12"] },
  { id: "t3", from: "ceo", time: "11:40", text: "HB-9 is done: 50 hooks saved. HB Dev opened PR #66 for the paywall test; I'm checking the diff now. One thing needs you: Meta Ads wants a $40 test budget.", tickets: ["HB-12", "HB-11"] },
]
