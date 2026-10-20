import type { FileMention, SlashItem, V3Data } from "@lilos/ui"

/* ?v3 mock: what a new chat's `@` and `/` read. A small file list per project
   folder (folders end with "/", like the Workbench's) and the engine's
   commands. Same company as fake-v3.ts, so a path named here is one a
   thread's Workbench lists too. */

const LILOS = [
  "apps/",
  "apps/web/",
  "apps/web/src/",
  "apps/web/src/v3/",
  "apps/web/src/v3/actions.ts",
  "apps/web/src/v3/data.ts",
  "apps/relay/",
  "apps/relay/src/",
  "apps/relay/src/db/schema.ts",
  "e2e/",
  "e2e/ac-544-workbench-reopen.spec.ts",
  "packages/",
  "packages/ui/",
  "packages/ui/src/",
  "packages/ui/src/lib/wb-probe-cache.ts",
  "packages/ui/src/workbench/",
  "packages/ui/src/workbench/workbench.tsx",
  "docs/",
  "docs/index.html",
  "package.json",
  "README.md",
]

const HEARDBACK = [
  "src/",
  "src/paywall/",
  "src/paywall/Paywall.tsx",
  "src/paywall/variants.ts",
  "src/paywall/copy.ts",
  "src/journal/",
  "src/journal/Entry.tsx",
  "ios/",
  "app.json",
  "package.json",
  "README.md",
]

const QRIT = [
  "ios/",
  "ios/QRit/",
  "ios/QRit/Generator.swift",
  "ios/QRit/Paywall.swift",
  "web/",
  "web/index.html",
  "web/src/",
  "web/src/landing.tsx",
  "README.md",
]

const RESEARCH = ["hooks/", "hooks/scored.csv", "creators.csv", "notes.md"]

const FILES: Record<string, string[]> = {
  "~/Code/LilOS": LILOS,
  "~/Code/heardback": HEARDBACK,
  "~/Code/heardback-growth": HEARDBACK,
  "~/Code/qrit": QRIT,
  "~/Research/heardback": RESEARCH,
}

/** Files and folders of `folder` matching what follows an `@`: names that
    start with the query first, then paths that merely contain it. */
export function fakeFiles(folder: string, query: string): FileMention[] {
  const q = query.trim().toLowerCase()
  const all = FILES[folder] ?? []
  const starts = all.filter((p) => (p.replace(/\/$/, "").split("/").pop() ?? p).toLowerCase().startsWith(q))
  const rest = all.filter((p) => !starts.includes(p) && p.toLowerCase().includes(q))
  return [...starts, ...rest].slice(0, 8).map((p) => ({
    path: p.replace(/\/$/, ""),
    kind: p.endsWith("/") ? ("dir" as const) : ("file" as const),
  }))
}

/* What every engine session answers to; `/model` is the one the box itself
   claims (it opens the model picker). */
const COMMANDS: SlashItem[] = [
  { name: "help", description: "List the engine's commands", kind: "command" },
  { name: "model", description: "Pick the model for this chat", kind: "command" },
  { name: "compact", description: "Compact the session's context", kind: "command" },
  { name: "usage", description: "Show token usage for the session", kind: "command" },
  { name: "review", description: "Review the current diff", kind: "skill", argsHint: "[scope]" },
  { name: "brainstorm", description: "Expand an idea into a plan", kind: "skill" },
]

/** The commands and skills matching what follows a leading `/`, for this
    agent: its own skills come with the engine's commands. */
export function fakeCommands(d: V3Data, agentId: string, query: string): SlashItem[] {
  const q = query.trim().toLowerCase()
  const own = (d.agents.find((a) => a.id === agentId)?.skills ?? []).map(
    (name): SlashItem => ({ name, description: "A skill this agent has learned", kind: "skill" }),
  )
  return [...COMMANDS, ...own].filter((c) => c.name.toLowerCase().includes(q))
}
