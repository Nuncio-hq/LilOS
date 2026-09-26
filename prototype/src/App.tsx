import { useEffect, useMemo, useRef, useState } from "react"
import { Conversation, ConversationContent, ConversationScrollButton } from "@lilos/ui/components/ai-elements/conversation"
import {
  AddFolderDialog,
  ChannelHeader,
  Composer,
  EditEmployeeDialog,
  EmployeeCard,
  EmployeeHome,
  ENGINE_STEER,
  FeedList,
  FirstRun,
  FocusView,
  HireDialog,
  type PreviewScenario,
  PrototypePreviewMenu,
  StatusBanner,
  StatusDialog,
  type Folder,
  type AttachedFile,
  type Channel,
  type EmpBadge,
  type Employee,
  type EmpFn,
  type FsDir,
  type HireDraft,
  type HermesProfile,
  type Human,
  type HumanFn,
  type Msg,
  type Project,
  type Reply,
  type RespondTo,
  type Step,
  type GitCommit,
  type CheckRun,
  type PullRequest,
  type Thread,
  type TicketRow,
  type Work,
  type SessionAlert,
  type StatusComponent,
  type WsPick,
  type Workspace,
  NO_WS,
  RightPanel,
  Sidebar,
  StartWorkDialog,
  ThreadView,
  baseName,
  folderLabel,
  plain,
  slugOf,
  useTheme,
} from "@lilos/ui"
import { cn } from "@lilos/ui/lib/utils"
import { hostAccessors, hostDir, hostDiscover, hostPick } from "./host"

/* Model: Company → Projects → Channels.
   Channel = shared timeline. A top-level message can open a THREAD.
   Thread = one Hermes session (focused work with an employee).
   DM with an employee = private place for 1:1 threads.

   All presentational components live in @lilos/ui (issue #12). This file is: mock data + the fake engine
   + app state + wiring. Nothing here renders markup beyond the shell grid, the feed conversation scroller
   and the toast. */

const FOLDERS: Folder[] = [
  { id: "lilos", project: "LilOS", path: "~/Desktop/Oscar/LilOS", repo: "Nuncio-hq/LilOS", branches: ["main", "release/0.1"],
    workstreams: [{ branch: "lil-3-monorepo", path: ".lilos/wt/lil-3", from: "main" }] },
  { id: "qrit", project: "QRit", path: "~/Desktop/Oscar/SamProjects/QRit", repo: "oscarlehuu/qrit", branches: ["main", "develop"],
    workstreams: [{ branch: "qr-7-paywall", path: ".lilos/wt/qr-7", from: "develop" }] },
]
/* The machine's folders as the gateway sees them. Real app: complete.path { word } for listing/autocomplete,
   projects.for_cwd { cwd } for "is it a repo + which branch", projects.discover_repos for the "Found on this Mac" row. */
const FS: Record<string, FsDir> = {
  "~": { children: ["Desktop", "Developer", "Documents"] },
  "~/Desktop": { children: ["Oscar"] },
  "~/Desktop/Oscar": { children: ["LilOS", "crew", "ProviderAuthForHarness", "SamProjects"] },
  "~/Desktop/Oscar/LilOS": { git: { branches: ["main", "release/0.1"], remote: "Nuncio-hq/LilOS" }, children: ["apps", "docs", "packages"] },
  "~/Desktop/Oscar/crew": { git: { branches: ["main", "next"], remote: "Nuncio-hq/crew" }, children: ["src", "docs"] },
  "~/Desktop/Oscar/ProviderAuthForHarness": { children: ["Devin"] },
  "~/Desktop/Oscar/ProviderAuthForHarness/Devin": { children: ["Hermes"] },
  "~/Desktop/Oscar/ProviderAuthForHarness/Devin/Hermes": { children: ["agentauth"] },
  "~/Desktop/Oscar/ProviderAuthForHarness/Devin/Hermes/agentauth": { git: { branches: ["main"] }, children: ["src"] },
  "~/Desktop/Oscar/SamProjects": { children: ["QRit", "qrit-landing"] },
  "~/Desktop/Oscar/SamProjects/QRit": { git: { branches: ["main", "develop"], remote: "oscarlehuu/qrit" }, children: ["ios", "web"] },
  "~/Desktop/Oscar/SamProjects/qrit-landing": { git: { branches: ["develop", "main"], remote: "oscarlehuu/qrit-landing" }, children: ["src"] },
  "~/Developer": { children: ["hermes-agent", "scratch"] },
  "~/Developer/hermes-agent": { git: { branches: ["main"], remote: "NousResearch/hermes-agent" }, children: ["tui_gateway", "hermes_cli"] },
  "~/Developer/scratch": { children: [] },
  "~/Documents": { children: ["Notes", "Invoices"] },
  "~/Documents/Notes": { children: [] },
  "~/Documents/Invoices": { children: [] },
}
const DISCOVERED = ["~/Desktop/Oscar/crew", "~/Desktop/Oscar/SamProjects/qrit-landing", "~/Developer/hermes-agent"]

const HUMANS: Record<string, Human> = {
  oscar: { name: "Oscar", color: "bg-blue-600" },
  minh: { name: "Minh", color: "bg-cyan-600", guest: true },
}

const MODELS = ["qwen3.8-flash-next (HPC · free)", "claude-opus-5.5 (subscription)", "gpt-5.5 (subscription)", "devin (AgentAuth)"]

const SEED_EMPLOYEES: Employee[] = [
  { id: "builder", name: "Builder", role: "Engineer", status: "busy", profile: "builder", model: MODELS[0], now: "LIL-3 · write_file README.md", instructions: "You are Builder, a full-stack engineer. Execute assigned tickets on a branch, run checks, report back with evidence.", respondTo: "me" },
  { id: "reviewer", name: "Reviewer", role: "QA", status: "online", profile: "reviewer", model: MODELS[1], now: "waiting on your approval", instructions: "You review diffs for correctness and boundaries. Never push; request changes with file:line.", respondTo: "me" },
  { id: "marketer", name: "Marketer", role: "Growth", status: "online", profile: "marketer", model: MODELS[0], now: "LIL-6 · drafting launch post", instructions: "You write launch copy in Oscar's voice: plain, concrete, no hype.", respondTo: "selected" },
]

const TEMPLATES: HireDraft[] = [
  { name: "Engineer", role: "Engineer", model: MODELS[0], instructions: "You are a full-stack engineer. Work only on assigned tickets, on a branch. Run checks before reporting. Report scope creep instead of expanding." },
  { name: "Reviewer", role: "QA", model: MODELS[1], instructions: "You review changes for correctness, tests and boundaries. Comment with file:line. Never push to main." },
  { name: "Marketer", role: "Growth", model: MODELS[0], instructions: "You write marketing copy and plans in the founder's voice: plain, specific, no hype." },
  { name: "Researcher", role: "Research", model: MODELS[0], instructions: "You research questions with cited sources and a one-paragraph answer first." },
]

// Mock of `hermes profile list` on the harness machine. Real list comes from the harness later.
const HERMES_PROFILES: HermesProfile[] = [
  { id: "default", model: MODELS[1], soul: "General assistant. Oscar's main Hermes.", skills: 42 },
  { id: "builder", model: MODELS[0], soul: "You are Builder, a full-stack engineer…", skills: 18 },
  { id: "reviewer", model: MODELS[1], soul: "You review diffs for correctness and boundaries…", skills: 9 },
  { id: "marketer", model: MODELS[0], soul: "You write launch copy in Oscar's voice…", skills: 6 },
  { id: "research", model: MODELS[0], soul: "Deep research with cited sources.", skills: 11 },
  { id: "ops", model: MODELS[3], soul: "Runs dev_server and HPC chores.", skills: 14 },
]

const COMPANY_CHANNELS: Channel[] = [{ id: "announcements", name: "announcements", employees: [] }]
const PROJECTS: Project[] = [
  {
    id: "lilos", name: "LilOS", key: "LIL",
    channels: [
      { id: "engineering", name: "engineering", repo: "Nuncio-hq/LilOS", employees: ["builder", "reviewer"] },
      { id: "marketing", name: "marketing", unread: 3, employees: ["marketer"] },
      { id: "general", name: "general", employees: ["builder", "reviewer", "marketer"] },
    ],
  },
  { id: "qrit", name: "QRit", key: "QR", channels: [{ id: "qrit-eng", name: "engineering", repo: "oscarlehuu/qrit", unread: 2, employees: ["builder"] }] },
]

const FEEDS: Record<string, Msg[]> = {
  engineering: [
    {
      kind: "msg", id: "m1", from: "oscar", time: "10:02",
      text: "Scaffold the monorepo: `contracts`, `client-runtime`, `apps/web`, `apps/relay`. **@Builder** take it, **@Reviewer** check the layout.",
      thread: {
        session: "ses_8f2c", ticket: "LIL-3", branch: "lil-3-monorepo", model: MODELS[0],
        usage: { input: 71200, output: 6100, reasoning: 2400, cache: 52000 },
        todos: [
          { content: "Create branch + pnpm workspace", status: "completed" },
          { content: "Scaffold contracts, client-runtime, web, relay", status: "completed" },
          { content: "Strict TS + no DOM in client-runtime", status: "completed" },
          { content: "README: workspace layout", status: "completed" },
          { content: "Open PR for Reviewer", status: "pending" },
        ],
        replies: [
          {
            from: "builder", time: "10:04", thought: 4, dur: 48,
            reasoning: "Ticket LIL-3 on its own worktree, so I can edit. Four packages; `client-runtime` must never import the DOM, so enforce it in tsconfig instead of hoping.",
            text: "On it. Scaffolded on `lil-3-monorepo`: pnpm workspaces, strict TS, no DOM imports in `client-runtime`. **@Reviewer** please check the package boundaries.",
            steps: [
              { tool: "terminal", input: { command: "git switch -c lil-3-monorepo" }, output: "Switched to a new branch 'lil-3-monorepo'" },
              { tool: "write_file", input: { path: "pnpm-workspace.yaml" }, output: "3 lines", diff: { path: "pnpm-workspace.yaml", status: "added", add: 3, del: 0, patch: "@@ -0,0 +1,3 @@\n+packages:\n+  - apps/*\n+  - packages/*" } },
              { tool: "patch", input: { path: "packages/client-runtime/tsconfig.json" }, output: "lib: ES2022 only", diff: { path: "packages/client-runtime/tsconfig.json", status: "modified", add: 3, del: 1, patch: "@@ -1,6 +1,8 @@\n {\n   \"extends\": \"../../tsconfig.base.json\",\n   \"compilerOptions\": {\n-    \"lib\": [\"ES2022\", \"DOM\"]\n+    \"lib\": [\"ES2022\"],\n+    \"types\": [],\n+    \"noEmit\": true\n   }\n }" } },
              { tool: "write_file", input: { path: "packages/contracts/src/envelope.ts" }, output: "58 lines", diff: { path: "packages/contracts/src/envelope.ts", status: "added", add: 12, del: 0, patch: "@@ -0,0 +1,12 @@\n+import { z } from \"zod\"\n+\n+export const Envelope = z.object({\n+  seq: z.number().int().nonnegative(),\n+  kind: z.string(),\n+  body: z.unknown(),\n+  at: z.string().datetime(),\n+})\n+\n+export type Envelope = z.infer<typeof Envelope>\n+\n+export const isAfter = (a: Envelope, seq: number) => a.seq > seq" } },
              {
                tool: "terminal", input: { command: "pnpm -r test" }, output: "\u001b[32m✓\u001b[0m contracts (4)\n\u001b[32m✓\u001b[0m client-runtime (3)\n\u001b[33m↓\u001b[0m relay (1 skipped)\n\nTests  7 passed | 1 skipped (8)\nTime   1.42s",
              },
              {
                tool: "terminal", input: { command: "git commit -am \"LIL-3: scaffold pnpm monorepo\"" }, output: "[lil-3-monorepo 3fa91c2] LIL-3: scaffold pnpm monorepo\n 3 files changed, 18 insertions(+), 1 deletion(-)",
                commit: { hash: "3fa91c2", message: "LIL-3: scaffold pnpm monorepo", files: [{ path: "pnpm-workspace.yaml", status: "added", add: 3, del: 0 }, { path: "packages/client-runtime/tsconfig.json", status: "modified", add: 3, del: 1 }, { path: "packages/contracts/src/envelope.ts", status: "added", add: 12, del: 0 }] },
              },
            ],
          },
          { from: "reviewer", time: "10:06", text: "Layout is fine. One ask before I run checks:", approval: { id: "a1", command: "pnpm install && pnpm -r typecheck", note: "Network access · writes node_modules" } },
          { from: "oscar", time: "10:08", text: "Also add a README section for the layout." },
          { from: "builder", time: "10:31", thought: 2, dur: 21, reasoning: "Same session, same worktree. Add a Workspace layout section; keep it to the four packages.", text: "README has a **Workspace layout** section now. Tests still green.", steps: [{ tool: "read_file", input: { path: "README.md" }, output: "42 lines" }, { tool: "patch", input: { path: "README.md" }, output: "+6 lines", diff: { path: "README.md", status: "modified", add: 6, del: 0, patch: "@@ -38,4 +38,10 @@\n ## Develop\n \n pnpm install && pnpm dev\n+\n+## Workspace layout\n+\n+- `packages/contracts` wire types (zod), no runtime deps\n+- `packages/client-runtime` state + reducer, no DOM\n+- `apps/web`, `apps/relay`" } }] },
        ],
      },
    },
    { kind: "event", id: "e1", ticket: "LIL-3", text: "Scaffold monorepo · claimed by Builder" },
    {
      kind: "msg", id: "m2", from: "oscar", time: "11:05",
      text: "**@Builder** how should the harness reconnect after the Mac sleeps? Don't build yet, just think.",
      thread: {
        session: "ses_b71d",
        replies: [
          {
            from: "builder", time: "11:07", text: "Read the contracts on `main`. Events already carry `seq`, so on reconnect the harness sends `afterSequence = last seq`, the relay replays the gap, then `synchronized`. No new endpoint.",
            steps: [
              { tool: "read_file", input: { path: "packages/contracts/src/envelope.ts" }, output: "seq: number · 58 lines" },
              { tool: "search_files", input: { pattern: "afterSequence", path: "." }, output: "0 matches" },
            ],
          },
          { from: "oscar", time: "11:10", text: "Agree. Add backoff, cap at 30s." },
          { from: "builder", time: "11:11", text: "Got it. Next step changes code in `apps/harness`, so it needs its own ticket and branch.", startProposal: { title: "Harness reconnect with afterSequence replay" } },
        ],
      },
    },
  ],
  marketing: [
    {
      kind: "msg", id: "k1", from: "oscar", time: "09:40", text: "**@Marketer** draft a launch post for LilOS. Audience: indie founders running AI agents. Under 200 words.",
      thread: {
        session: "ses_31aa", ticket: "LIL-6",
        replies: [
          { from: "marketer", time: "09:52", text: "Draft v1 on **LIL-6**. Two angles:\n\n1. *Your company in one chat*\n2. *Employees, not bots*\n\nI'd lead with the second.", steps: [{ tool: "web_search", input: { query: "AI employees launch post" }, output: "5 results" }, { tool: "write_file", input: { path: "drafts/launch-v1.md" }, output: "187 words" }] },
        ],
      },
    },
  ],
  general: [
    { kind: "msg", id: "g1", from: "oscar", time: "Yesterday", text: "#engineering for code, #marketing for launch. Tickets are shared across the project." },
    {
      kind: "msg", id: "g2", from: "builder", time: "11:20", text: "Tests are the bottleneck on LIL-3. I drafted a new employee for it. Needs your OK.",
      hire: { name: "Tester", role: "QA automation", model: MODELS[0], instructions: "You own flaky and missing tests. Reproduce, fix or quarantine with a ticket. Never change product code." },
    },
  ],
}

const TICKETS: TicketRow[] = [
  { id: "LIL-3", title: "Scaffold monorepo", status: "In progress", who: "builder", ch: "engineering", branch: "lil-3-monorepo" },
  { id: "LIL-6", title: "Launch post draft", status: "In progress", who: "marketer", ch: "marketing" },
  { id: "LIL-2", title: "Relay event log schema", status: "Review", who: "reviewer", ch: "engineering", branch: "lil-2-event-log" },
]

/* DM = private 1:1 with an employee. Every top-level message starts a NEW Hermes session;
   the employee answers in that message's thread, and every follow-up in the thread goes to the same session. */
const DM_FEEDS: Record<string, Msg[]> = {
  "dm-builder": [
    {
      kind: "msg", id: "d1", from: "oscar", time: "Yesterday", text: "What's left before the relay can accept its first harness connection?",
      thread: {
        session: "ses_4a19", usage: { input: 38400, output: 2900, reasoning: 1100, cache: 24000 },
        replies: [
          {
            from: "builder", time: "Yesterday", thought: 6,
            reasoning: "Oscar asks for the gap list, not a build plan. No ticket, so read `main` only. Check the relay package and the contracts, list only what blocks one harness from connecting.",
            steps: [
              { tool: "search_files", input: { pattern: "WebSocketServer", path: "apps/relay" }, output: "0 matches" },
              { tool: "read_file", input: { path: "packages/contracts/src/envelope.ts" }, output: "58 lines · seq, kind, body" },
            ],
            text: "Three things block it:\n\n1. **Relay has no socket yet.** `apps/relay` is an empty package.\n2. **No auth handshake.** The envelope has `seq` but no member token.\n3. **No harness package.** Nothing dials out yet.\n\n(1) and (2) are one ticket. (3) is its own.",
          },
          { from: "oscar", time: "Yesterday", text: "Which one first?" },
          { from: "builder", time: "Yesterday", thought: 2, reasoning: "Order by dependency: the harness needs something to dial.", text: "Relay socket + token check first. The harness has nothing to dial without it, and it is the smaller change (about 150 lines)." },
        ],
      },
    },
    {
      kind: "msg", id: "d2", from: "oscar", time: "Yesterday", text: "Summarise what changed on `main` since Monday.",
      thread: {
        session: "ses_c03e", usage: { input: 12100, output: 640, reasoning: 210, cache: 9000 },
        replies: [
          {
            from: "builder", time: "Yesterday", thought: 3, reasoning: "git log since Monday, group commits by package.",
            steps: [{ tool: "terminal", input: { command: "git log --since=monday --oneline main" }, output: "7 commits" }],
            text: "7 commits since Monday:\n\n- **contracts**: envelope gets `seq` (2)\n- **web**: Slack frame + thread panel (4)\n- **docs**: brainstorm reset (1)\n\nNothing touched `apps/relay`.",
          },
        ],
      },
    },
  ],
  "dm-reviewer": [
    {
      kind: "msg", id: "v1", from: "oscar", time: "08:05", text: "What do you check first on a PR from Builder?",
      thread: {
        session: "ses_77e2", usage: { input: 6400, output: 380, reasoning: 90, cache: 4100 },
        replies: [{ from: "reviewer", time: "08:06", thought: 1, reasoning: "Answer from my SOUL.md checklist.", text: "Package boundaries first (`client-runtime` must stay DOM-free), then tests for the changed paths, then the diff itself. I never push; I comment with file:line." }],
      },
    },
  ],
}


/* First run: the relay handshake creates one employee from the machine's default Hermes profile —
   `default` is already there before Oscar types anything. */
const DEFAULT_EMP: Employee = { id: "default", name: "Default", role: "Assistant", status: "online", profile: "default", model: MODELS[1], now: "idle", instructions: "General assistant created from this Mac's default Hermes profile.", respondTo: "me" }

/* System status per preview scenario. Each component has a state + one-line reason;
   the dialog's "Copy diagnostics" ships the same lines as plain text. */
const STATUS: Record<PreviewScenario, StatusComponent[]> = {
  normal: [
    { id: "relay", label: "Relay", state: "ok", reason: "Connected · local relay on this Mac" },
    { id: "harness", label: "Harness", state: "ok", reason: "Running · 3 sessions" },
    { id: "engine", label: "Engine", state: "ok", reason: "Hermes 0.9 · ready" },
    { id: "model", label: "Model", state: "ok", reason: `${MODELS[1].split(" (")[0]} · responding` },
  ],
  "first-run": [
    { id: "relay", label: "Relay", state: "ok", reason: "Connected · local relay on this Mac" },
    { id: "harness", label: "Harness", state: "ok", reason: "Running · 1 session" },
    { id: "engine", label: "Engine", state: "ok", reason: "Hermes 0.9 · ready" },
    { id: "model", label: "Model", state: "ok", reason: `${MODELS[1].split(" (")[0]} · responding` },
  ],
  loading: [],
  reconnecting: [
    { id: "relay", label: "Relay", state: "connecting", reason: "Connection lost — retrying every 2s · last seen 14s ago" },
    { id: "harness", label: "Harness", state: "ok", reason: "Running · 3 sessions" },
    { id: "engine", label: "Engine", state: "ok", reason: "Hermes 0.9 · ready" },
    { id: "model", label: "Model", state: "ok", reason: `${MODELS[1].split(" (")[0]} · responding` },
  ],
  "harness-down": [
    { id: "relay", label: "Relay", state: "ok", reason: "Connected · local relay on this Mac" },
    { id: "harness", label: "Harness", state: "down", reason: "Process exited · last heartbeat 2m ago" },
    { id: "engine", label: "Engine", state: "degraded", reason: "Hermes reachable, no harness to run it" },
    { id: "model", label: "Model", state: "ok", reason: `${MODELS[1].split(" (")[0]} · responding` },
  ],
  "engine-down": [
    { id: "relay", label: "Relay", state: "ok", reason: "Connected · local relay on this Mac" },
    { id: "harness", label: "Harness", state: "ok", reason: "Running · 3 sessions" },
    { id: "engine", label: "Engine", state: "down", reason: "Hermes not responding · IPC timeout after 5s" },
    { id: "model", label: "Model", state: "degraded", reason: "Last turn unanswered · engine unreachable" },
  ],
  "model-error": [
    { id: "relay", label: "Relay", state: "ok", reason: "Connected · local relay on this Mac" },
    { id: "harness", label: "Harness", state: "ok", reason: "Running · 3 sessions" },
    { id: "engine", label: "Engine", state: "ok", reason: "Hermes 0.9 · ready" },
    { id: "model", label: "Model", state: "degraded", reason: `${MODELS[0].split(" ")[0]}: HPC not responding` },
  ],
  sleep: [
    { id: "relay", label: "Relay", state: "ok", reason: "Connected · local relay on this Mac" },
    { id: "harness", label: "Harness", state: "ok", reason: "Running · 3 sessions" },
    { id: "engine", label: "Engine", state: "ok", reason: "Hermes 0.9 · ready" },
    { id: "model", label: "Model", state: "ok", reason: `${MODELS[1].split(" (")[0]} · responding` },
  ],
  "version-mismatch": [
    { id: "relay", label: "Relay", state: "down", reason: "Protocol v2 required — this app speaks v1" },
    { id: "harness", label: "Harness", state: "degraded", reason: "Unreachable until the relay reconnects" },
    { id: "engine", label: "Engine", state: "degraded", reason: "Last known: Hermes 0.9 · ready" },
    { id: "model", label: "Model", state: "degraded", reason: "Last known: responding" },
  ],
  "profile-missing": [
    { id: "relay", label: "Relay", state: "ok", reason: "Connected · local relay on this Mac" },
    { id: "harness", label: "Harness", state: "ok", reason: "Running · 3 sessions" },
    { id: "engine", label: "Engine", state: "ok", reason: "Hermes 0.9 · ready" },
    { id: "model", label: "Model", state: "ok", reason: `${MODELS[1].split(" (")[0]} · responding` },
  ],
}

/* Session-level failure states (on the DM session row, with Retry where a retry makes sense). */
const SESSION_ALERTS: Partial<Record<PreviewScenario, SessionAlert>> = {
  "model-error": { kind: "model", text: `Model error · ${MODELS[0].split(" ")[0]}: provider returned 429 (rate limited)`, retry: true },
  sleep: { kind: "sleep", text: "Interrupted — the Mac slept mid-turn. The reply may be incomplete.", retry: true },
}

// Canned turn used by the prototype's fake engine. Real app: Hermes events over /api/ws.
type Script = { reasoning: string; steps: Step[]; text: string; todo?: string; pr?: PullRequest }
const hex = () => Math.random().toString(16).slice(2, 9)
const CHECKS = ["CI Policy", "Typecheck", "Unit tests", "Lint", "Relay e2e"]
const EDIT_ASK = /\b(add|fix|change|update|write|implement|refactor|bump|remove|rename|create|make|edit|move|delete|scaffold)\b/i
function scriptFor(empId: string, prompt: string, followUp = false, branch?: string, repo = "Nuncio-hq/LilOS", cwd?: string): Script {
  const q = prompt.replace(/\*\*/g, "").replace(/@\w+\s*/g, "").trim().replace(/[?.!]+$/, "")
  const tail = cwd && branch ? `I'm in \`${cwd}\` on ⎇ \`${branch}\`. Tell me what to change and I'll edit there.` : "Still read-only on `main`; nothing edited yet."
  if (branch && /\b(open|create|raise)\b.*\b(pr|pull request)\b/i.test(q)) {
    const n = 12
    const title = "LIL-3: scaffold pnpm monorepo"
    return {
      todo: "Open PR for Reviewer",
      reasoning: `Branch ${branch} is committed and green. Push it, open the PR against main with a summary + how I verified, request Reviewer.`,
      steps: [
        { tool: "terminal", input: { command: `git push -u origin ${branch}` }, output: `To github.com:${repo}.git\n * [new branch]      ${branch} -> ${branch}` },
        { tool: "terminal", input: { command: `gh pr create --base main --head ${branch} --title "${title}" --reviewer reviewer` }, output: `https://github.com/${repo}/pull/${n}` },
      ],
      text: `Opened **PR #${n}** against \`main\` and requested **@Reviewer**.\n\nI'm watching CI and review comments from this session; status is live on the card below.`,
      pr: {
        number: n, repo, title, status: "open", author: empId, base: "main", head: branch, opened: "just now",
        body: `## Summary\n\nScaffolds the monorepo from LIL-3: \`contracts\`, \`client-runtime\`, \`apps/web\`, \`apps/relay\` on pnpm workspaces with strict TS.\n\n- \`client-runtime\` compiles with \`lib: ["ES2022"]\` only, so a DOM import fails the build\n- \`contracts\` owns the event \`Envelope\` (\`seq\`, \`kind\`, \`body\`, \`at\`)\n- README documents the workspace layout\n\n## Verification\n\n- \`pnpm -r test\`: 7 passed, 1 skipped (relay has no harness yet)\n- \`pnpm -r typecheck\`: clean\n\nSession \`ses_8f2c\` · requested by @oscar in #engineering`,
        checks: CHECKS.map((name) => ({ name, status: "pending" as const })),
        comments: [{ from: empId, time: nowTime(), monitor: true, text: "I'll fix CI failures and address review comments from people with write access in this session. Comments containing \"(aside)\" are skipped." }],
      },
    }
  }
  if (branch && EDIT_ASK.test(q)) {
    // Session sits in a worktree → it may edit. Hermes emits inline_diff on tool.complete for edits.
    const h = hex()
    return {
      todo: q[0].toUpperCase() + q.slice(1),
      reasoning: `On ⎇ ${branch}, so I can edit. Smallest change for "${q}", then re-run the tests and commit on the branch.`,
      steps: [
        { tool: "search_files", input: { pattern: "## Notes", path: "README.md" }, output: "0 matches" },
        { tool: "patch", input: { path: "README.md" }, output: "+3 lines", diff: { path: "README.md", status: "modified", add: 3, del: 0, patch: `@@ -46,3 +46,6 @@\n - \`packages/client-runtime\` state + reducer, no DOM\n - \`apps/web\`, \`apps/relay\`\n+\n+## Notes\n+- ${q}` } },
        { tool: "write_file", input: { path: "docs/decisions/0002-notes.md" }, output: "9 lines", diff: { path: "docs/decisions/0002-notes.md", status: "added", add: 5, del: 0, patch: `@@ -0,0 +1,5 @@\n+# 0002 ${q}\n+\n+Status: proposed\n+\n+Why: asked by Oscar in session.` } },
        {
          tool: "terminal", input: { command: "pnpm -r test" }, output: "\u001b[32m✓\u001b[0m contracts (4)\n\u001b[32m✓\u001b[0m client-runtime (3)\n\u001b[33m↓\u001b[0m relay (1 skipped)\n\nTests  7 passed | 1 skipped (8)\nTime   1.38s",
        },
        { tool: "terminal", input: { command: `git commit -am "${q}"` }, output: `[${branch} ${h}] ${q}\n 2 files changed, 8 insertions(+)`, commit: { hash: h, message: q, files: [{ path: "README.md", status: "modified", add: 3, del: 0 }, { path: "docs/decisions/0002-notes.md", status: "added", add: 5, del: 0 }] } },
      ],
      text: `Done on \`${branch}\`:\n\n- \`README.md\` +3, new \`docs/decisions/0002-notes.md\`\n- Tests: 7 passed, 1 skipped\n- Commit \`${h}\`\n\nReview it in **Changes**.`,
    }
  }
  if (followUp) return {
    reasoning: `Follow-up in the same session. Earlier turns are already in context, so no re-reading. Fold "${q}" into the plan.`,
    steps: [{ tool: "read_file", input: { path: "packages/contracts/src/envelope.ts" }, output: "cached · 58 lines" }],
    text: `Noted. Plan for this session now:\n\n1. On reconnect, send \`afterSequence\` = last \`seq\`\n2. ${q[0].toUpperCase() + q.slice(1)}\n\n${tail}`,
  }
  if (empId === "marketer") return {
    reasoning: `Oscar asks: "${q}". Audience is indie founders running AI agents. Check what is already out there, then write in his voice: plain, concrete, no hype.`,
    steps: [
      { tool: "web_search", input: { query: "AI employees for solo founders" }, output: "5 results" },
      { tool: "write_file", input: { path: "drafts/notes.md" }, output: "212 words" },
    ],
    text: `First pass:\n\n1. *Your company, in one chat.*\n2. *Hire agents like people. Fire them like software.*\n3. *Employees that show their work.*\n\nI would lead with 3. It says what is different without a claim we can't back. Notes saved to \`drafts/notes.md\`.`,
  }
  if (empId === "reviewer") return {
    reasoning: `Question: "${q}". Read-only on main. Look at recent diffs and the package graph before answering.`,
    steps: [
      { tool: "terminal", input: { command: "git log -5 --stat main" }, output: "5 commits · 23 files" },
      { tool: "search_files", input: { pattern: "from \"react\"", path: "packages/client-runtime" }, output: "0 matches" },
    ],
    text: `No boundary leaks. \`client-runtime\` has zero DOM or React imports. Two gaps:\n\n- \`apps/relay\` has no tests at all\n- the envelope \`seq\` is never asserted to be monotonic\n\nI can write both up as review comments.`,
  }
  return {
    reasoning: cwd ? `Oscar asks: "${q}". Session cwd is ${cwd}. Read first, then answer short with file references.` : `Oscar asks: "${q}". No ticket yet, so this session reads \`main\` and does not edit. Find the relevant code, then answer short with file references.`,
    steps: [
      { tool: "search_files", input: { pattern: q.split(" ").slice(0, 2).join(" ") || "relay", path: "." }, output: "4 matches" },
      { tool: "read_file", input: { path: "packages/contracts/src/envelope.ts" }, output: "58 lines" },
      { tool: "terminal", input: { command: "pnpm -r typecheck" }, output: "4 projects · 0 errors" },
    ],
    text: `Short answer:\n\n- The contracts already carry \`seq\`, so replay needs no new endpoint. See \`envelope.ts:12\`.\n- Typecheck is clean across 4 packages.\n\n${cwd ? tail : "If you want me to change code, pick a folder when you open the session, or press **Start work** on a channel thread."}`,
  }
}
const nowTime = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
const newSession = () => `ses_${Math.random().toString(16).slice(2, 6)}`

// Mock repo listing shown in the workbench Files tab (app data; Workbench takes it as repoFiles).
const REPO_FILES = [
  "README.md", "package.json", "pnpm-workspace.yaml", "tsconfig.base.json",
  "apps/relay/package.json", "apps/relay/src/index.ts", "apps/web/package.json", "apps/web/src/main.tsx",
  "docs/decisions/0001-monorepo.md",
  "packages/client-runtime/package.json", "packages/client-runtime/src/reducer.ts", "packages/client-runtime/tsconfig.json",
  "packages/contracts/package.json", "packages/contracts/src/envelope.ts",
]

type View = { kind: "channel"; id: string } | { kind: "dm"; id: string }

export default function App() {
  const [employees, setEmployees] = useState<Employee[]>(SEED_EMPLOYEES)
  const [view, setView] = useState<View>({ kind: "channel", id: "engineering" })
  const [threadId, setThreadId] = useState<string | null>("m2")
  const [focus, setFocus] = useState(false)
  const [panelTab, setPanelTab] = useState<"thread" | "employee" | "tickets">("thread")
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth >= 1280)
  const [navOpen, setNavOpen] = useState(false)
  const [selectedEmp, setSelectedEmp] = useState("builder")
  const [resolved, setResolved] = useState<Record<string, string>>({})
  const [hireOpen, setHireOpen] = useState<HireDraft | null>(null)
  const [theme, setTheme] = useTheme()
  const [toast, setToast] = useState<string | null>(null)
  const [started, setStarted] = useState<Record<string, Work>>({})
  const startedRef = useRef(started)
  startedRef.current = started
  const [tickets, setTickets] = useState<TicketRow[]>(TICKETS)
  const [startFor, setStartFor] = useState<string | null>(null)
  const [selfStart, setSelfStart] = useState<Record<string, boolean>>({})
  const [feeds, setFeeds] = useState<Record<string, Msg[]>>(() => ({ ...FEEDS, ...DM_FEEDS }))
  const stops = useRef<Record<string, boolean>>({})
  // Session.steer (ENGINE_STEER in @lilos/ui, read in one place): a message sent mid-turn is delivered
  // into the running turn at the next tool boundary. This is the default and only behavior — no toggle UI.
  const steerBuf = useRef<Record<string, string[]>>({})
  // Mirror of steerBuf in React state so a pending steer renders immediately inside the running turn
  // (as a "Steer pending" chip where the "Oscar steered" row will appear). steerBuf stays the async
  // source of truth for the turn loop; every mutation goes through setSteerBuf to keep the two in sync.
  const [pendingSteers, setPendingSteers] = useState<Record<string, string[]>>({})
  const setSteerBuf = (rootId: string, list: string[]) => {
    steerBuf.current[rootId] = list
    setPendingSteers((p) => ({ ...p, [rootId]: list }))
  }

  /* Prototype preview states: which scenario the Preview menu puts the app into, whether the
     realApp toggle hides demo-only chrome, and the surfaces driven by a scenario. */
  const [scenario, setScenario] = useState<PreviewScenario>("normal")
  const [realApp, setRealApp] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  const [firstDone, setFirstDone] = useState(false)
  const [editEmp, setEditEmp] = useState<string | null>(null)
  // Employees removed from the company stay in `removed` so their past messages keep a name/avatar.
  const [removed, setRemoved] = useState<Record<string, Employee>>({})
  // Retry on a session alert dismisses it for this scenario visit.
  const [alertOff, setAlertOff] = useState(0)
  const pickScenario = (id: PreviewScenario) => {
    setAlertOff(0)
    if (id === "first-run") setFirstDone(false)
    if (id === "profile-missing")
      setEmployees((es) => es.map((e) => (e.id === "marketer" ? { ...e, profile: "ghost" } : e)))
    else
      setEmployees((es) => es.map((e) => (e.profile === "ghost" ? { ...e, profile: "marketer" } : e)))
    setScenario(id)
  }

  const emp: EmpFn = (id) => employees.find((e) => e.id === id) ?? removed[id] ?? (id === "default" ? DEFAULT_EMP : undefined)
  const human: HumanFn = (id) => HUMANS[id]
  const say = (t: string) => { setToast(t); setTimeout(() => setToast(null), 2200) }

  // Per-employee sidebar badges: a blue count for live turns, amber for turns waiting on approval.
  const badges = useMemo(() => {
    const b: Record<string, EmpBadge> = {}
    for (const msgs of Object.values(feeds))
      for (const m of msgs)
        if (m.kind === "msg" && m.thread)
          for (const r of m.thread.replies) {
            const e = employees.find((x) => x.id === r.from)
            if (!e) continue
            const cur = b[e.id] ?? {}
            if (r.live) cur.running = (cur.running ?? 0) + 1
            if (r.approval && !resolved[r.approval.id]) cur.approvals = (cur.approvals ?? 0) + 1
            b[e.id] = cur
          }
    return b
  }, [feeds, employees, resolved])


  const channel: Channel =
    view.kind === "dm"
      ? { id: `dm-${view.id}`, name: emp(view.id)?.name ?? "", employees: [view.id], dm: true }
      : [...PROJECTS.flatMap((p) => p.channels), ...COMPANY_CHANNELS].find((c) => c.id === view.id)!
  const project = PROJECTS.find((p) => p.channels.some((c) => c.id === channel.id))
  const feedKey = channel.id
  const feed: Msg[] = feeds[feedKey] ?? []
  const openThread = feed.find((m): m is Extract<Msg, { kind: "msg" }> => m.kind === "msg" && m.id === threadId && !!m.thread)

  // Scenario alert: stamped on the last session row of the open DM (the session-level failure states).
  const shownFeed = useMemo(() => {
    const al = SESSION_ALERTS[scenario]
    if (!al || alertOff || view.kind !== "dm") return feed
    const last = [...feed].reverse().find((m) => m.kind === "msg" && m.thread)
    if (!last) return feed
    return feed.map((m) => (m === last && m.kind === "msg" && m.thread ? { ...m, thread: { ...m.thread, alert: al } } : m))
  }, [feed, scenario, alertOff, view.kind])

  // The banner for the current scenario — a bar above the conversation (null = no banner).
  const banner = useMemo<React.ReactNode>(() => {
    switch (scenario) {
      case "reconnecting":
        return <StatusBanner tone="amber">Lost the connection to the local relay — reconnecting every 2s. Messages queue until it's back.</StatusBanner>
      case "harness-down":
        return <StatusBanner tone="red">Harness down — employees can't run tools or touch files until it restarts.</StatusBanner>
      case "engine-down":
        return <StatusBanner tone="red">Engine down — Hermes isn't responding. Turns pause; your drafts are safe.</StatusBanner>
      case "version-mismatch":
        return <StatusBanner tone="red" action={{ label: "Copy update command", onClick: () => { void navigator.clipboard.writeText("brew upgrade lilos"); say("Copied: brew upgrade lilos") } }}>Protocol v2 required — this app speaks v1. Update LilOS to reconnect to the local relay.</StatusBanner>
      default:
        return null
    }
  }, [scenario])

  const goChannel = (id: string) => { setView({ kind: "channel", id }); setThreadId(null); setFocus(false); setNavOpen(false) }
  const goDM = (id: string) => {
    const last = [...(feeds[`dm-${id}`] ?? [])].reverse().find((m) => m.kind === "msg" && m.thread)
    setView({ kind: "dm", id }); setThreadId(last?.id ?? null); setPanelTab("thread"); setPanelOpen(window.innerWidth >= 1280); setFocus(false); setNavOpen(false)
  }
  const showThread = (id: string) => { setThreadId(id); setPanelTab("thread"); setPanelOpen(true) }

  /* ---- Fake engine. Each step maps to a real Hermes event so the UI contract is honest:
     session.create (first message) → prompt.submit → message.start → reasoning.delta* → tool.start/complete*
     → message.delta* → message.complete {usage}. Follow-ups in the thread = prompt.submit on the SAME session. */
  const mapRoot = (key: string, rootId: string, fn: (t: Thread) => Thread) =>
    setFeeds((fs) => ({ ...fs, [key]: (fs[key] ?? []).map((m) => (m.kind === "msg" && m.id === rootId && m.thread ? { ...m, thread: fn(m.thread) } : m)) }))
  const mapReply = (key: string, rootId: string, rid: string, fn: (r: Reply) => Reply) =>
    mapRoot(key, rootId, (t) => ({ ...t, replies: t.replies.map((r) => (r.id === rid ? fn(r) : r)) }))

  const feedsRef = useRef(feeds)
  feedsRef.current = feeds
  const branchOf = (key: string, rootId: string) => {
    const m = (feedsRef.current[key] ?? []).find((x) => x.kind === "msg" && x.id === rootId)
    return startedRef.current[rootId]?.branch ?? (m?.kind === "msg" ? m.thread?.branch ?? m.thread?.ws?.branch : undefined)
  }

  // wsNew: the workspace of a session created in this same tick (feedsRef has not caught up yet).
  const runTurn = async (key: string, rootId: string, empId: string, prompt: string, wsNew?: Workspace) => {
    const rid = `r-${Date.now()}`
    const followUp = !!(feedsRef.current[key] ?? []).find((m) => m.kind === "msg" && m.id === rootId && m.thread?.replies.some((r) => r.from === empId))
    const root0 = (feedsRef.current[key] ?? []).find((m) => m.kind === "msg" && m.id === rootId)
    const ws = wsNew ?? (root0?.kind === "msg" ? root0.thread?.ws : undefined)
    const repo = ws ? ws.repo : [...PROJECTS.flatMap((p) => p.channels)].find((c) => c.id === key)?.repo
    const s = scriptFor(empId, prompt, followUp, ws?.branch ?? branchOf(key, rootId), repo, ws?.cwd)
    // New workstream: the engine creates the worktree before session.create { cwd }, shown as the first step of turn 1.
    if (ws?.mode === "new" && ws.worktree && !followUp)
      s.steps = [{ tool: "terminal", input: { command: `git worktree add ${ws.worktree} -b ${ws.branch} ${ws.base}` }, output: `Preparing worktree (new branch '${ws.branch}')\nHEAD is now at ${hex()} (${ws.base})` }, ...s.steps]
    // session.create { cwd }: the first thing the session does is land in its folder — pwd proves it.
    if (ws?.cwd && !followUp) s.steps = [{ tool: "terminal", input: { command: "pwd" }, output: ws.cwd }, ...s.steps]
    stops.current[rootId] = false
    setSteerBuf(rootId, steerBuf.current[rootId] ?? [])
    const started0 = Date.now()
    mapRoot(key, rootId, (t) => ({
      ...t,
      replies: [...t.replies, { id: rid, from: empId, time: nowTime(), text: "", steps: [], live: true, phase: "submitted" }],
      // todo.updated: the employee adds its own item and marks it in_progress
      todos: s.todo ? [...(t.todos ?? []).filter((x) => x.content !== s.todo), { content: s.todo, status: "in_progress" }] : t.todos,
    }))
    const tick = async (ms: number) => { await new Promise((r) => setTimeout(r, ms)); if (stops.current[rootId]) throw new Error("stop") }
    const set = (fn: (r: Reply) => Reply) => mapReply(key, rootId, rid, fn)
    const words = (t: string) => t.split(/(?<=\s)/)
    // session.steer: messages Oscar sent mid-turn land at the next tool boundary, shown as "Oscar steered"
    // rows inside this turn and folded into the final reply.
    const applied: string[] = []
    const applySteers = () => {
      const q = steerBuf.current[rootId] ?? []
      if (!q.length) return
      setSteerBuf(rootId, [])
      applied.push(...q)
      set((r) => ({ ...r, steers: [...(r.steers ?? []), ...q.map(plain)] }))
    }
    try {
      await tick(700)
      set((r) => ({ ...r, phase: "thinking", reasoning: "" }))
      const t0 = Date.now()
      for (const w of words(s.reasoning)) { await tick(45); set((r) => ({ ...r, reasoning: (r.reasoning ?? "") + w })) }
      set((r) => ({ ...r, phase: "tools", thought: Math.max(1, Math.round((Date.now() - t0) / 1000)) }))
      for (const st of s.steps) {
        applySteers() // boundary: the next tool call is about to start
        set((r) => ({ ...r, steps: [...(r.steps ?? []), { ...st, output: "", running: true, diff: undefined, commit: undefined }] }))
        await tick(650)
        set((r) => ({ ...r, steps: (r.steps ?? []).map((x, i, a) => (i === a.length - 1 ? { ...st } : x)) }))
      }
      applySteers() // last boundary: nothing more lands between tools, so apply before message.delta
      if (applied.length) s.text += `\n\nFolded in your steer: *“${plain(applied.join(" "))}”.`
      set((r) => ({ ...r, phase: "typing" }))
      for (const w of words(s.text)) { await tick(28); set((r) => ({ ...r, text: r.text + w })) }
      set((r) => ({ ...r, phase: "done", live: false, dur: Math.round((Date.now() - started0) / 1000) }))
      mapRoot(key, rootId, (t) => {
        const u = t.usage ?? { input: 0, output: 0, reasoning: 0, cache: 0 }
        return {
          ...t,
          todos: s.todo ? (t.todos ?? []).map((x) => (x.content === s.todo ? { ...x, status: "completed" } : x)) : t.todos,
          usage: { input: u.input + 9000 + prompt.length * 4, output: u.output + s.text.length / 4, reasoning: u.reasoning + s.reasoning.length / 4, cache: u.cache + 6000 },
          pr: s.pr ?? t.pr,
        }
      })
      if (s.pr) {
        // CI reports back one check at a time (engine polls `gh pr checks`).
        const outcome: CheckRun["status"][] = ["passed", "passed", "passed", "passed", "skipped"]
        s.pr.checks.forEach((_, i) => setTimeout(() => mapRoot(key, rootId, (t) => t.pr ? { ...t, pr: { ...t.pr, checks: t.pr.checks.map((c, j) => (j === i ? { ...c, status: outcome[i] } : c)) } } : t), 1200 + i * 900))
      }
    } catch {
      set((r) => ({ ...r, phase: "stopped", live: false, steps: (r.steps ?? []).map((x) => ({ ...x, running: false })) }))
      mapRoot(key, rootId, (t) => ({ ...t, todos: s.todo ? (t.todos ?? []).map((x) => (x.content === s.todo ? { ...x, status: "cancelled" } : x)) : t.todos }))
    }
    // session.interrupt (■): undelivered steers must not silently land in a LATER turn —
    // hand them to the visible not-sent tray (@lilos/ui NotSentTray): Send runs it now, remove discards it.
    // thread.queue holds ONLY these post-stop items; nothing auto-runs after a stop.
    if (stops.current[rootId]) {
      const pend = steerBuf.current[rootId] ?? []
      if (pend.length) {
        setSteerBuf(rootId, [])
        mapRoot(key, rootId, (t) => ({ ...t, queue: [...(t.queue ?? []), ...pend] }))
      }
    }
    // A steer that never hit a tool boundary becomes the next prompt (never lost). The thread queue is
    // only ever post-stop not-sent items, which Oscar sends by hand — so only the steer buffer auto-runs.
    const steered = (steerBuf.current[rootId] ?? [])[0]
    if (steered && !stops.current[rootId]) {
      setSteerBuf(rootId, (steerBuf.current[rootId] ?? []).slice(1))
      mapRoot(key, rootId, (t) => ({ ...t, replies: [...t.replies, { id: `o-${Date.now()}`, from: "oscar", time: nowTime(), text: steered }] }))
      await new Promise((r) => setTimeout(r, 50))
      return runTurn(key, rootId, empId, steered)
    }
  }
  const stopTurn = (rootId: string) => { stops.current[rootId] = true }
  // Re-sticking the conversation when a pending steer chip or the not-sent tray appears is handled
  // inside @lilos/ui (ConversationKeepBottom, in ThreadView/FocusView) via use-stick-to-bottom's own
  // scrollToBottom — the old interval pin here is gone (issue #15).
  const threadRunning = (m?: Extract<Msg, { kind: "msg" }>) => !!m?.thread?.replies.some((r) => r.live)

  const mentionIn = (text: string) => employees.find((e) => channel.employees.includes(e.id) && new RegExp(`@${e.name}\\b`, "i").test(text))
  const bold = (text: string) => employees.reduce((t, e) => t.replace(new RegExp(`(?<!\\*)@${e.name}\\b`, "gi"), `**@${e.name}**`), text)

  // Top-level message. DM: always opens a new session. Channel: only when it @mentions an employee.
  const [folders, setFolders] = useState<Folder[]>(FOLDERS)
  // Last folder/branch pick per employee DM, so it survives navigating away (like an IDE's open project).
  const [wsPicks, setWsPicks] = useState<Record<string, WsPick>>({})
  const [newProjects, setNewProjects] = useState<Project[]>([])
  const [addFolderOpen, setAddFolderOpen] = useState(false)
  // Folder listing served by the host dev middleware (/api/host → packages/host): mock FS seeds
  // the known Oscar dirs, real listings merge in as the picker asks for them.
  const [fsMap, setFsMap] = useState<Record<string, FsDir>>(FS)
  const [discovered, setDiscovered] = useState<string[]>(DISCOVERED)
  // git.discoverRepos over scan roots (?roots=/tmp overrides for e2e); real hits replace the mock row.
  useEffect(() => {
    const roots = new URLSearchParams(location.search).get("roots")?.split(",") ?? ["~/Desktop", "~/Developer", "~/Documents", "~/repos"]
    hostDiscover(roots).then((d) => {
      if (d.list.length) { setDiscovered(d.list); setFsMap((m) => ({ ...m, ...d.stubs })) }
    }).catch(() => {})
  }, [])
  // Asked once per dir — a failed fetch drops out of the set so a later
  // navigation retries (mock seeds stay when the host is down).
  const requestedDirs = useRef(new Set<string>())
  const needDir = (p: string) => {
    if (requestedDirs.current.has(p)) return
    requestedDirs.current.add(p)
    void hostDir(p).then((m) => {
      if (m) setFsMap((f) => ({ ...f, ...m }))
      else requestedDirs.current.delete(p)
    })
  }
  // projects.add_folder { id, path } (existing project) or projects.create { name, folders: [path] } (new one).
  const addFolder = async (path: string, project: { existing?: string; name: string }) => {
    const d = await hostPick(path).catch(() => null) ?? fsMap[path]
    const id = `f-${slugOf(project.name)}-${baseName(path).toLowerCase()}`.replace(/[^a-z0-9-]/g, "")
    const f: Folder = { id, project: project.name, path, repo: d?.git?.remote, branches: d?.git?.branches ?? [], workstreams: [] }
    if (d) setFsMap((m) => ({ ...m, [path]: { ...m[path], ...d } }))
    setFolders((fs) => [...fs, f])
    if (!project.existing) setNewProjects((ps) => [...ps, { id: slugOf(project.name) || id, name: project.name, key: project.name.slice(0, 3).toUpperCase(), channels: [] }])
    if (view.kind === "dm") setWsPicks((w) => ({ ...w, [view.id]: { folder: id, base: f.branches[0] ?? "", mode: f.branches.length ? "new" : "direct" } }))
    setAddFolderOpen(false)
    say(project.existing ? `projects.add_folder → ${project.name}: ${path}` : `projects.create "${project.name}" with ${path}`)
  }
  // Composer pick → the session's cwd. Real app: (git worktree add) then session.create { cwd }.
  const resolveWs = (pick: WsPick | undefined, text: string): Workspace | undefined => {
    const f0 = folders.find((x) => x.id === pick?.folder)
    if (!pick || !f0) return undefined
    const f = { ...f0, project: folderLabel(f0, folders) }
    if (pick.mode === "existing") {
      const w = f.workstreams.find((x) => x.branch === pick.existing) ?? f.workstreams[0]
      return { folder: f.id, project: f.project, repo: f.repo, mode: "existing", base: w.from, branch: w.branch, cwd: `${f.path}/${w.path}` }
    }
    if (pick.mode === "direct" || !f.branches.length) return { folder: f.id, project: f.project, repo: f.repo, mode: "direct", base: pick.base, branch: pick.base || "no git", cwd: f.path }
    const slug = slugOf(plain(text)) || "session"
    let branch = `ws/${slug}`
    for (let i = 2; f.workstreams.some((w) => w.branch === branch); i++) branch = `ws/${slug}-${i}`
    const worktree = `.lilos/wt/${branch.slice(3)}`
    setFolders((fs) => fs.map((x) => (x.id === f0.id ? { ...x, workstreams: [...x.workstreams, { branch, path: worktree, from: pick.base }] } : x)))
    return { folder: f.id, project: f.project, repo: f.repo, mode: "new", base: pick.base, branch, cwd: `${f.path}/${worktree}`, worktree }
  }
  const sendTop = (text: string, pick?: WsPick, files?: AttachedFile[]) => {
    const target = view.kind === "dm" ? view.id : mentionIn(text)?.id
    const id = `s-${Date.now()}`
    const ws = target ? resolveWs(pick, text) : undefined
    const msg: Msg = { kind: "msg", id, from: "oscar", time: nowTime(), text: bold(text), attachments: files?.length ? files : undefined, ...(target ? { thread: { session: newSession(), replies: [], model: emp(target)?.model, ws } } : {}) }
    setFeeds((fs) => ({ ...fs, [feedKey]: [...(fs[feedKey] ?? []), msg] }))
    if (target) { showThread(id); runTurn(feedKey, id, target, text, ws) }
  }
  // Reply inside a thread = same Hermes session. While a turn runs, Enter ALWAYS steers (session.steer):
  // the message lands in the running turn at the next tool boundary. ENGINE_STEER=false (an engine without
  // session.steer, future) is the only way a mid-turn send takes the queue path; there is no toggle UI.
  const sendInThread = (root: Extract<Msg, { kind: "msg" }>, text: string, files?: AttachedFile[]) => {
    const at = files?.length ? ` ${files.map((f) => `📎 ${f.name}`).join(" ")}` : ""
    if (threadRunning(root)) {
      if (ENGINE_STEER) setSteerBuf(root.id, [...(steerBuf.current[root.id] ?? []), bold(text) + at])
      else mapRoot(feedKey, root.id, (t) => ({ ...t, queue: [...(t.queue ?? []), bold(text) + at] }))
      return
    }
    mapRoot(feedKey, root.id, (t) => ({ ...t, replies: [...t.replies, { id: `o-${Date.now()}`, from: "oscar", time: nowTime(), text: bold(text), attachments: files?.length ? files : undefined }] }))
    const lead = view.kind === "dm" ? view.id : mentionIn(text)?.id ?? root.thread?.replies.find((r) => emp(r.from))?.from ?? mentionIn(root.text)?.id
    if (lead) runTurn(feedKey, root.id, lead, text)
  }
  const unqueue = (root: Extract<Msg, { kind: "msg" }>, i: number) =>
    mapRoot(feedKey, root.id, (t) => ({ ...t, queue: (t.queue ?? []).filter((_, j) => j !== i) }))
  // The not-sent tray's "Send": a message that didn't land before ■ runs NOW as a new prompt in the same
  // thread/session (prompt.submit), not at some later turn boundary. Nothing auto-sends on its own.
  const sendQueuedNow = (root: Extract<Msg, { kind: "msg" }>, i: number) => {
    const item = root.thread?.queue?.[i]
    if (!item || threadRunning(root)) return
    unqueue(root, i)
    sendInThread(root, item)
  }
  // session.undo: drop the last exchange; real Hermes also rewinds files via rollback.restore to the turn checkpoint
  const rewind = (root: Extract<Msg, { kind: "msg" }>, replyIndex: number) => {
    mapRoot(feedKey, root.id, (t) => ({ ...t, replies: t.replies.slice(0, replyIndex) }))
    say(`Rewound session ${root.thread?.session} · rollback.restore to checkpoint`)
  }
  const setModel = (root: Extract<Msg, { kind: "msg" }>, model: string) => {
    mapRoot(feedKey, root.id, (t) => ({ ...t, model }))
    say(`Next turn uses ${model.split(" ")[0]}`)
  }
  // PR actions from the PR tab. Real app: engine runs `gh pr comment|merge` with the human's GitHub grant.
  const prComment = (root: Extract<Msg, { kind: "msg" }>, text: string) =>
    mapRoot(feedKey, root.id, (t) => (t.pr ? { ...t, pr: { ...t.pr, comments: [...t.pr.comments, { from: "oscar", time: nowTime(), text }] } } : t))
  const prMerge = (root: Extract<Msg, { kind: "msg" }>) => {
    mapRoot(feedKey, root.id, (t) => (t.pr ? { ...t, pr: { ...t.pr, status: "merged", merged: { by: "Oscar", at: nowTime(), sha: hex() } }, todos: t.todos?.map((x) => (x.content === "Open PR for Reviewer" ? { ...x, status: "completed" } : x)) } : t))
    say(`Merged #${root.thread?.pr?.number} into ${root.thread?.pr?.base} · gh pr merge --squash`)
  }
  const retry = (root: Extract<Msg, { kind: "msg" }>, empId: string) => {
    const lastAsk = [...(root.thread?.replies ?? [])].reverse().find((r) => !emp(r.from))?.text ?? root.text
    runTurn(feedKey, root.id, empId, lastAsk)
  }
  const showEmp = (id: string) => { setSelectedEmp(id); setPanelTab("employee"); setPanelOpen(true); setFocus(false) }

  const hire = (d: HireDraft, respondTo: RespondTo, chs: string[]) => {
    const id = d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    setEmployees((es) => [...es, { id, name: d.name, role: d.role, status: "online", profile: id, model: d.model, now: "just hired · idle", instructions: d.instructions, respondTo }])
    chs.forEach((c) => { const ch = PROJECTS.flatMap((p) => p.channels).find((x) => x.id === c); if (ch && !ch.employees.includes(id)) ch.employees.push(id) })
    setHireOpen(null)
    if (view.kind === "channel" && view.id === "general") setResolved((r) => ({ ...r, g2: `Hired ${d.name}` }))
    say(`Hired ${d.name}: hermes profile create ${id}`)
    showEmp(id)
  }

  const saveEmployee = (id: string, name: string, role: string) => {
    setEmployees((es) => es.map((e) => (e.id === id ? { ...e, name, role } : e)))
    setEditEmp(null)
    say(`Saved ${name}`)
  }
  // Remove from company: the employee leaves sidebar/channels/DMs, but the Hermes profile (and its
  // sessions, memory, skills) stays on the harness — the dialog copy says so before confirming.
  const removeEmployee = (id: string) => {
    const e = emp(id)
    if (!e) return
    setEmployees((es) => es.filter((x) => x.id !== id))
    setRemoved((r) => ({ ...r, [id]: e }))
    for (const p of PROJECTS) for (const c of p.channels) c.employees = c.employees.filter((x) => x !== id)
    COMPANY_CHANNELS.forEach((c) => { c.employees = c.employees.filter((x) => x !== id) })
    setEditEmp(null)
    if (selectedEmp === id) setPanelTab("thread")
    if (view.kind === "dm" && view.id === id) goChannel("general")
    say(`Removed ${e.name} · profile \`${e.profile}\` kept`)
  }
  const switchProfile = (id: string, profileId: string) => {
    setEmployees((es) => es.map((e) => (e.id === id ? { ...e, profile: profileId } : e)))
    say(`${emp(id)?.name ?? id} now uses profile \`${profileId}\``)
  }

  const workOf = (m: Extract<Msg, { kind: "msg" }>): Work | null =>
    started[m.id] ?? (m.thread?.ticket ? { ticket: m.thread.ticket, branch: m.thread.branch, title: "" }
      : m.thread?.ws ? { ticket: "", branch: m.thread.ws.branch, title: "", path: m.thread.ws.cwd } : null)
  const nextTicket = `${project?.key ?? "LIL"}-${Math.max(0, ...tickets.map((t) => Number(t.id.split("-")[1]))) + 1}`
  const startRoot = feed.find((m): m is Extract<Msg, { kind: "msg" }> => m.kind === "msg" && m.id === startFor)

  const startWork = (rootId: string, w: Work, lead: string, grant: boolean) => {
    setStarted((s) => ({ ...s, [rootId]: w }))
    setTickets((ts) => [{ id: w.ticket, title: w.title, status: "In progress", who: lead, ch: channel.id, branch: w.branch }, ...ts])
    setFeeds((fs) => ({ ...fs, [feedKey]: [...(fs[feedKey] ?? []), { kind: "event", id: `ev-${w.ticket}`, ticket: w.ticket, text: `${w.title} · started from a thread${w.branch ? ` · ⎇ ${w.branch}` : ""}` }] }))
    if (grant) setSelfStart((g) => ({ ...g, [channel.id]: true }))
    setStartFor(null)
    say(w.branch ? `${w.ticket} started · worktree ${w.branch}` : `${w.ticket} created`)
  }

  const threadPanel = openThread?.thread ? (
    <ThreadView
      root={openThread} thread={openThread.thread} channel={channel}
      emp={emp} human={human} resolved={resolved} setResolved={setResolved}
      onFocus={() => setFocus(!focus)}
      work={workOf(openThread)} repo={channel.repo} onStart={() => setStartFor(openThread.id)}
      running={threadRunning(openThread)} onSend={(t, files) => sendInThread(openThread, t, files)} onStop={() => stopTurn(openThread.id)}
      onRetry={(e) => retry(openThread, e)} onUnqueue={(i) => unqueue(openThread, i)} onSendQueued={(i) => sendQueuedNow(openThread, i)}
      pending={pendingSteers[openThread.id] ?? []} accept="image/*"
    />
  ) : null

  return (
    <div className={cn("grid h-dvh grid-cols-1 overflow-hidden bg-background text-sm", !(focus && openThread?.thread) && "lg:grid-cols-[264px_minmax(0,1fr)]")}>
      {navOpen && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setNavOpen(false)} />}
      {navOpen && focus && <div className="fixed inset-0 z-30 hidden bg-black/30 lg:block" onClick={() => setNavOpen(false)} />}
      <Sidebar
        navOpen={navOpen}
        hiddenWhenClosed={focus && !!openThread?.thread}
        companyChannels={COMPANY_CHANNELS}
        projects={[...PROJECTS, ...newProjects]}
        folders={folders}
        employees={scenario === "first-run" ? [DEFAULT_EMP] : employees}
        view={view}
        theme={theme}
        badges={badges}
        status={STATUS[scenario]}
        onOpenStatus={() => setStatusOpen(true)}
        realApp={realApp || scenario === "first-run"}
        preview={<PrototypePreviewMenu scenario={scenario} realApp={realApp} onScenario={pickScenario} onRealApp={setRealApp} />}
        isProjectDefaultOpen={(p) => p.id === "lilos" || newProjects.includes(p)}
        onSetTheme={setTheme}
        onCloseNav={() => setNavOpen(false)}
        onGoChannel={goChannel}
        onGoDM={goDM}
        onOpenTickets={() => { setFocus(false); setPanelTab("tickets"); setPanelOpen(true) }}
        onAddFolder={() => setAddFolderOpen(true)}
        onHire={() => setHireOpen(TEMPLATES[0])}
      />

      {focus && openThread?.thread ? (
        <FocusView
          root={openThread} thread={openThread.thread} channel={channel} project={project} emp={emp} human={human}
          lead={emp(view.kind === "dm" ? view.id : openThread.thread.replies.find((r) => emp(r.from))?.from ?? mentionIn(openThread.text)?.id ?? "")}
          resolved={resolved} setResolved={setResolved} work={workOf(openThread)}
          onBack={() => setFocus(false)} onNav={() => setNavOpen(true)} onStart={() => setStartFor(openThread.id)}
          running={threadRunning(openThread)} onSend={(t, files) => sendInThread(openThread, t, files)} onStop={() => stopTurn(openThread.id)}
          onRetry={(e) => retry(openThread, e)} onUnqueue={(i) => unqueue(openThread, i)} onSendQueued={(i) => sendQueuedNow(openThread, i)}
          onRewind={(i) => rewind(openThread, i)} onModel={(m) => setModel(openThread, m)} say={say}
          models={MODELS} repoFiles={REPO_FILES} host={hostAccessors}
          onPrComment={(t) => prComment(openThread, t)} onPrMerge={() => prMerge(openThread)}
          pending={pendingSteers[openThread.id] ?? []} accept="image/*"
        />
      ) : (
        <div className={cn("grid min-h-0 min-w-0 grid-cols-1", panelOpen && "xl:grid-cols-[minmax(0,1fr)_420px]")}>
          {banner && <div className="col-span-full">{banner}</div>}
          {channel.dm && emp(view.id) ? (
            <EmployeeHome
              e={emp(view.id)!} feed={shownFeed} threadId={threadId} emp={emp} human={human}
              onNav={() => setNavOpen(true)} onProfile={() => showEmp(view.id)} onOpen={showThread}
              onSend={sendTop} panelOpen={panelOpen} onPanel={() => setPanelOpen(true)} folders={folders}
              pick={wsPicks[view.id] ?? NO_WS} setPick={(p) => setWsPicks((w) => ({ ...w, [view.id]: p }))} onAddFolder={() => setAddFolderOpen(true)}
              loading={scenario === "loading"}
              onRename={(id, title) => mapRoot(feedKey, id, (t) => ({ ...t, title }))}
              onArchive={(id, archived) => mapRoot(feedKey, id, (t) => ({ ...t, archived }))}
              onRetrySession={(m) => { setAlertOff((n) => n + 1); retry(m, view.id); say(`Retrying session ${m.thread?.session}`) }}
              accept="image/*"
            />
          ) : (
          <main className="flex min-h-0 min-w-0 flex-col">
            <ChannelHeader
              channel={channel} projectName={project?.name} employees={employees}
              onNav={() => setNavOpen(true)} onOpenTickets={() => { setPanelTab("tickets"); setPanelOpen(true) }}
              panelOpen={panelOpen} onOpenPanel={() => setPanelOpen(true)} onShowEmp={showEmp}
            />

            <Conversation className="min-h-0">
              <ConversationContent className="min-h-full justify-end gap-0 p-0 py-3">
                <FeedList
                  feed={feed} emp={emp} human={human} threadId={threadId} resolved={resolved}
                  emptyText={`No messages in #${channel.name} yet.`} workOf={workOf}
                  onOpenThread={showThread}
                  onReviewHire={(draft) => setHireOpen(draft)}
                  onRejectHire={(id) => setResolved({ ...resolved, [id]: "Hire declined" })}
                  onSay={say}
                />
              </ConversationContent>
              <ConversationScrollButton />
            </Conversation>

            <Composer placeholder={`Message #${channel.name}. @ an employee to start a thread`} employees={employees.filter((e) => channel.employees.includes(e.id))} hint="An @mention opens a thread = one Hermes session" onSend={(t, files) => sendTop(t, undefined, files)} accept="image/*" />
          </main>
          )}

          {panelOpen && (
            <RightPanel
              tab={panelTab} onTab={setPanelTab} onClose={() => setPanelOpen(false)}
              threadPanel={threadPanel}
              employeeCard={emp(selectedEmp) ? <EmployeeCard e={emp(selectedEmp)!} profiles={HERMES_PROFILES} onDM={() => goDM(selectedEmp)} onEdit={() => setEditEmp(selectedEmp)} onSwitchProfile={(p) => switchProfile(selectedEmp, p)} /> : null}
              tickets={tickets} emp={emp} dm={!!channel.dm}
            />
          )}
        </div>
      )}

      {startRoot?.thread && (
        <StartWorkDialog
          root={startRoot} thread={startRoot.thread} channel={channel} ticket={nextTicket} emp={emp} granted={!!selfStart[channel.id]}
          onClose={() => setStartFor(null)}
          onStart={(w, lead, grant) => startWork(startRoot.id, w, lead, grant)}
        />
      )}
      {addFolderOpen && (
        <AddFolderDialog
          folders={folders} projects={[...PROJECTS, ...newProjects].map((p) => p.name)}
          defaultProject={view.kind === "channel" ? project?.name : undefined}
          fs={fsMap} discovered={discovered} onNeedDir={needDir}
          onClose={() => setAddFolderOpen(false)} onAdd={addFolder}
        />
      )}
      {hireOpen && (
        <HireDialog
          initial={hireOpen} templates={TEMPLATES} profiles={HERMES_PROFILES} models={MODELS}
          allChannels={PROJECTS.flatMap((p) => p.channels.map((c) => ({ id: c.id, label: `${p.name} / #${c.name}` })))}
          onClose={() => setHireOpen(null)} onHire={hire} usedProfiles={employees.map((e) => e.profile)}
        />
      )}
      {statusOpen && (
        <StatusDialog
          components={STATUS[scenario]}
          diagnostics={STATUS[scenario].map((c) => `${c.id}: ${c.state} — ${c.reason}`).join("\n")}
          onClose={() => setStatusOpen(false)}
          onCopied={() => say("Diagnostics copied")}
        />
      )}
      {scenario === "first-run" && !firstDone && (
        <FirstRun
          employee={DEFAULT_EMP}
          onOpenDM={() => { setFirstDone(true); goDM("default") }}
          onSkip={() => setFirstDone(true)}
        />
      )}
      {editEmp && emp(editEmp) && (
        <EditEmployeeDialog
          e={emp(editEmp)!}
          onClose={() => setEditEmp(null)}
          onSave={(name, role) => saveEmployee(editEmp, name, role)}
          onRemove={() => removeEmployee(editEmp)}
        />
      )}
      {toast && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-foreground px-4 py-2 text-background text-sm shadow-lg">{toast}</div>}
    </div>
  )
}
