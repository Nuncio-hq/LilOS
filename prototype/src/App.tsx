import { Fragment, useEffect, useRef, useState } from "react"
import type { ChatStatus, LanguageModelUsage } from "ai"
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  BellIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleMinusIcon,
  CircleXIcon,
  CopyIcon,
  CpuIcon,
  EyeIcon,
  FileCodeIcon,
  FileDiffIcon,
  FilePenIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  GitBranchPlusIcon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  GlobeIcon,
  HashIcon,
  InboxIcon,
  ListTodoIcon,
  LockIcon,
  Maximize2Icon,
  MenuIcon,
  MessageSquareIcon,
  MessageSquareTextIcon,
  Minimize2Icon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  PanelRightCloseIcon,
  PanelRightIcon,
  PencilLineIcon,
  PanelRightOpenIcon,
  PaperclipIcon,
  PlayIcon,
  PlusIcon,
  RefreshCcwIcon,
  SearchIcon,
  ShieldAlertIcon,
  SparklesIcon,
  SquareIcon,
  SquareTerminalIcon,
  TicketIcon,
  Trash2Icon,
  Undo2Icon,
  UserIcon,
  UserPlusIcon,
  XIcon,
} from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { CodeBlock } from "@/components/ai-elements/code-block"
import {
  Confirmation, ConfirmationAccepted, ConfirmationAction, ConfirmationActions,
  ConfirmationRejected, ConfirmationRequest, ConfirmationTitle,
} from "@/components/ai-elements/confirmation"
import {
  Context, ContextContent, ContextContentBody, ContextContentFooter, ContextContentHeader, ContextTrigger,
} from "@/components/ai-elements/context"
import {
  Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "@/components/ai-elements/message"
import {
  PromptInput, PromptInputBody, PromptInputButton, PromptInputFooter,
  PromptInputSubmit, PromptInputTextarea, PromptInputTools,
} from "@/components/ai-elements/prompt-input"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion"
import { Task, TaskContent, TaskTrigger } from "@/components/ai-elements/task"
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool"
import { CodeBlockActions, CodeBlockCopyButton, CodeBlockFilename, CodeBlockHeader, CodeBlockTitle } from "@/components/ai-elements/code-block"
import { Checkpoint, CheckpointIcon, CheckpointTrigger } from "@/components/ai-elements/checkpoint"
import {
  Commit, CommitActions, CommitContent, CommitCopyButton, CommitFile, CommitFileAdditions, CommitFileChanges,
  CommitFileDeletions, CommitFileIcon, CommitFileInfo, CommitFilePath, CommitFileStatus, CommitFiles, CommitHash,
  CommitHeader, CommitInfo, CommitMessage, CommitMetadata, CommitSeparator,
} from "@/components/ai-elements/commit"
import { FileTree, FileTreeFile, FileTreeFolder, FileTreeIcon, FileTreeName } from "@/components/ai-elements/file-tree"
import {
  ModelSelector, ModelSelectorContent, ModelSelectorEmpty, ModelSelectorGroup, ModelSelectorInput,
  ModelSelectorItem, ModelSelectorList, ModelSelectorLogo, ModelSelectorName, ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector"
import {
  Queue, QueueItem, QueueItemAction, QueueItemActions, QueueItemContent, QueueItemIndicator, QueueList,
  QueueSection, QueueSectionContent, QueueSectionLabel, QueueSectionTrigger,
} from "@/components/ai-elements/queue"
import { Terminal, TerminalActions, TerminalContent, TerminalCopyButton, TerminalHeader, TerminalStatus, TerminalTitle } from "@/components/ai-elements/terminal"
import { WebPreview, WebPreviewBody, WebPreviewNavigation, WebPreviewNavigationButton, WebPreviewUrl } from "@/components/ai-elements/web-preview"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/* Model: Company → Projects → Channels.
   Channel = shared timeline. A top-level message can open a THREAD.
   Thread = one Hermes session (focused work with an employee).
   DM with an employee = private place for 1:1 threads. */

type Status = "online" | "busy" | "offline"
type RespondTo = "me" | "selected" | "anyone"
type Employee = { id: string; name: string; role: string; status: Status; profile: string; model: string; now: string; instructions: string; respondTo: RespondTo }
type Channel = { id: string; name: string; repo?: string; unread?: number; employees: string[]; dm?: boolean }
type Project = { id: string; name: string; key: string; channels: Channel[] }
type Diff = { path: string; status: "added" | "modified" | "deleted"; add: number; del: number; patch: string }
type GitCommit = { hash: string; message: string; files: { path: string; status: Diff["status"]; add: number; del: number }[] }
/* A step = one Hermes tool call (tool.start → tool.complete). The workbench is derived only from steps:
   inline_diff → Changes, terminal output → Terminal, git commit → Commits. Test output lives in Terminal;
   pass/fail on a PR lives in PR → Checks (no structured Tests tab — no engine feeds it). */
type Step = { tool: string; input: Record<string, unknown>; output: string; running?: boolean; diff?: Diff; commit?: GitCommit }
/* Hermes todo tool (todo.updated) statuses */
type Todo = { content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }
/* phase mirrors the Hermes turn events: message.start → submitted, reasoning.delta → thinking,
   tool.start/complete → tools, message.delta → typing, message.complete → done, session.interrupt → stopped */
type Phase = "submitted" | "thinking" | "tools" | "typing" | "done" | "stopped"
type Reply = {
  from: string; time: string; text: string; steps?: Step[]; streaming?: string
  approval?: { id: string; command: string; note: string }; startProposal?: { title: string }
  reasoning?: string; thought?: number; phase?: Phase; live?: boolean; id?: string; steers?: string[]; dur?: number
}
type Usage = { input: number; output: number; reasoning: number; cache: number }
/* Level 0: no ticket/branch → employees read `main` only. Start work → ticket + worktree; the SAME Hermes session moves there. */
/* A pull request the employee opened from its worktree (terminal `gh pr create`). Not a Hermes contract:
   the engine reads it back from GitHub (gh pr view --json …) and pushes updates on the session. */
type CheckRun = { name: string; status: "pending" | "passed" | "failed" | "skipped" }
type PrComment = { from: string; time: string; text: string; monitor?: boolean }
type PullRequest = {
  number: number; repo: string; title: string; body: string; status: "open" | "merged"; merged?: { by: string; at: string; sha: string }
  author: string; base: string; head: string; opened: string
  checks: CheckRun[]; comments: PrComment[]
}
type Thread = { session: string; ticket?: string; branch?: string; replies: Reply[]; usage?: Usage; todos?: Todo[]; queue?: string[]; model?: string; pr?: PullRequest; ws?: Workspace }
type Work = { ticket: string; branch?: string; title: string; by?: string; path?: string }

/* Local folders a project owns (Hermes: projects.add_folder / projects.for_cwd). A session's cwd is either the folder
   itself or a worktree inside it: a "workstream" = one branch + one worktree, shared by the sessions working on it. */
type Workstream = { branch: string; path: string; from: string }
type Folder = { id: string; project: string; path: string; repo?: string; branches: string[]; workstreams: Workstream[] }  // branches [] = not a git repo
const FOLDERS: Folder[] = [
  { id: "lilos", project: "LilOS", path: "~/Desktop/Oscar/LilOS", repo: "Nuncio-hq/LilOS", branches: ["main", "release/0.1"],
    workstreams: [{ branch: "lil-3-monorepo", path: ".lilos/wt/lil-3", from: "main" }] },
  { id: "qrit", project: "QRit", path: "~/Desktop/Oscar/SamProjects/QRit", repo: "oscarlehuu/qrit", branches: ["main", "develop"],
    workstreams: [{ branch: "qr-7-paywall", path: ".lilos/wt/qr-7", from: "develop" }] },
]
/* The machine's folders as the gateway sees them. Real app: complete.path { word } for listing/autocomplete,
   projects.for_cwd { cwd } for "is it a repo + which branch", projects.discover_repos for the "Found on this Mac" row. */
type FsDir = { git?: { branches: string[]; remote?: string }; children?: string[] }
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
const baseName = (path: string) => path.split("/").pop() ?? path
// "LilOS" when the project has one folder (named like it), else "LilOS / Notes".
const folderLabel = (f: { project: string; path: string }, all: { project: string }[]) =>
  all.filter((x) => x.project === f.project).length > 1 || baseName(f.path).toLowerCase() !== f.project.toLowerCase() ? `${f.project} / ${baseName(f.path)}` : f.project
const parentOf = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "~"

/* Picked in the composer before the first message of a session.
   new = git worktree add -b <branch> <base> · existing = reuse a workstream's worktree · direct = edit the folder checkout on <base>. */
type WsMode = "new" | "existing" | "direct"
type WsPick = { folder: string | null; base: string; mode: WsMode; existing?: string }
type Workspace = { folder: string; project: string; label?: string; repo?: string; mode: WsMode; base: string; branch: string; cwd: string; worktree?: string }
const NO_WS: WsPick = { folder: null, base: "main", mode: "new" }
type TicketRow = { id: string; title: string; status: string; who: string; ch: string; branch?: string }
type HireDraft = { name: string; role: string; instructions: string; model: string }
type Msg =
  | { kind: "msg"; id: string; from: string; time: string; text: string; thread?: Thread; hire?: HireDraft }
  | { kind: "event"; id: string; text: string; ticket: string }

const HUMANS: Record<string, { name: string; color: string; guest?: boolean }> = {
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
type HermesProfile = { id: string; model: string; soul: string; skills: number }
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
const slugOf = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !["a", "an", "the", "with", "on", "for", "of", "to", "and"].includes(w)).slice(0, 2).join("-")

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

const SUGGESTIONS: Record<string, string[]> = {
  builder: ["What's blocking the relay?", "Explain packages/contracts", "Review my last commit"],
  reviewer: ["Check LIL-2 for boundary leaks", "What tests are missing?", "Review the relay schema"],
  marketer: ["Draft 3 taglines for LilOS", "Who are our first 10 users?", "Plan the launch week"],
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
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`
const nowTime = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
const newSession = () => `ses_${Math.random().toString(16).slice(2, 6)}`
const PHASE_LABEL: Record<Phase, string> = { submitted: "opening session", thinking: "thinking", tools: "working", typing: "replying", done: "done", stopped: "stopped" }

const STATUS_DOT: Record<Status, string> = { online: "bg-emerald-500", busy: "bg-amber-500 animate-pulse", offline: "bg-zinc-400" }
const RESPOND: Record<RespondTo, string> = { me: "Only me", selected: "Selected people", anyone: "Anyone in the channel" }

type EmpFn = (id: string) => Employee | undefined

function HermesAvatar({ status, className }: { status?: Status; className?: string }) {
  return (
    <span className={cn("relative inline-block size-9 shrink-0", className)}>
      <img src="/hermes.svg" alt="Hermes" className="size-full rounded-[28%] dark:invert dark:hue-rotate-180" />
      {status && <span className={cn("absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background", STATUS_DOT[status])} />}
    </span>
  )
}

function HumanAvatar({ id }: { id: string }) {
  const h = HUMANS[id]
  return (
    <Avatar className="size-9 rounded-lg">
      <AvatarFallback className={cn("rounded-lg font-semibold text-white", h.color)}>{h.name[0]}</AvatarFallback>
    </Avatar>
  )
}

type View = { kind: "channel"; id: string } | { kind: "dm"; id: string }

/* Theme: light / dark / follow the OS. Stored locally; .dark on <html> switches the shadcn tokens in index.css.
   An inline script in index.html applies it before first paint so there is no white flash. */
type Theme = "light" | "dark" | "system"
function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("lilos-theme") as Theme) ?? "system")
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const apply = () => document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && mq.matches))
    apply(); localStorage.setItem("lilos-theme", theme)
    mq.addEventListener("change", apply)
    return () => mq.removeEventListener("change", apply)
  }, [theme])
  return [theme, setTheme] as const
}
function ThemeToggle({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const opts: [Theme, string, typeof SunIcon][] = [["light", "Light", SunIcon], ["dark", "Dark", MoonIcon], ["system", "System (follow macOS)", MonitorIcon]]
  return (
    <div role="radiogroup" aria-label="Theme" className="ml-auto flex items-center gap-0.5 rounded-md bg-sidebar-accent p-0.5" data-theme-toggle>
      {opts.map(([t, label, I]) => (
        <button key={t} type="button" role="radio" aria-checked={theme === t} title={label} aria-label={label} onClick={() => setTheme(t)} data-theme-opt={t}
          className={cn("grid size-6 place-items-center rounded text-muted-foreground hover:text-foreground", theme === t && "bg-background text-foreground shadow-sm dark:bg-white/15")}>
          <I className="size-3.5" />
        </button>
      ))}
    </div>
  )
}

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
  // Engine capability (fake engine): session.steer. ON = a message sent mid-turn is delivered into the
  // running turn at the next tool boundary; OFF = it waits in the client-side queue (prompt.submit later).
  const [steerCap, setSteerCap] = useState(true)
  const steerBuf = useRef<Record<string, string[]>>({})
  // Mirror of steerBuf in React state so a pending steer renders immediately inside the running turn
  // (as a "Steer pending" chip where the "Oscar steered" row will appear). steerBuf stays the async
  // source of truth for the turn loop; every mutation goes through setSteerBuf to keep the two in sync.
  const [pendingSteers, setPendingSteers] = useState<Record<string, string[]>>({})
  const setSteerBuf = (rootId: string, list: string[]) => {
    steerBuf.current[rootId] = list
    setPendingSteers((p) => ({ ...p, [rootId]: list }))
  }

  const emp: EmpFn = (id) => employees.find((e) => e.id === id)
  const say = (t: string) => { setToast(t); setTimeout(() => setToast(null), 2200) }

  const channel: Channel =
    view.kind === "dm"
      ? { id: `dm-${view.id}`, name: emp(view.id)?.name ?? "", employees: [view.id], dm: true }
      : [...PROJECTS.flatMap((p) => p.channels), ...COMPANY_CHANNELS].find((c) => c.id === view.id)!
  const project = PROJECTS.find((p) => p.channels.some((c) => c.id === channel.id))
  const feedKey = channel.id
  const feed: Msg[] = feeds[feedKey] ?? []
  const openThread = feed.find((m): m is Extract<Msg, { kind: "msg" }> => m.kind === "msg" && m.id === threadId && !!m.thread)

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
      if (applied.length) s.text += `\n\nFolded in your steer: *“${plain(applied.join(" "))}”.*`
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
    // hand them to the visible, removable client-side queue (QueuedTray) where Oscar controls them.
    if (stops.current[rootId]) {
      const pend = steerBuf.current[rootId] ?? []
      if (pend.length) {
        setSteerBuf(rootId, [])
        mapRoot(key, rootId, (t) => ({ ...t, queue: [...(t.queue ?? []), ...pend] }))
      }
    }
    // Follow-ups run next, in order. A steer that never hit a tool boundary becomes the next prompt
    // (never lost); then the client-side queue (used when the engine has no session.steer).
    const m = (feedsRef.current[key] ?? []).find((x) => x.kind === "msg" && x.id === rootId)
    const steered = (steerBuf.current[rootId] ?? [])[0]
    const next = steered ?? (m?.kind === "msg" ? m.thread?.queue?.[0] : undefined)
    if (next && !stops.current[rootId]) {
      if (steered) setSteerBuf(rootId, (steerBuf.current[rootId] ?? []).slice(1))
      mapRoot(key, rootId, (t) => ({ ...t, queue: steered ? (t.queue ?? []) : (t.queue ?? []).slice(1), replies: [...t.replies, { id: `o-${Date.now()}`, from: "oscar", time: nowTime(), text: next }] }))
      await new Promise((r) => setTimeout(r, 50))
      return runTurn(key, rootId, empId, next)
    }
  }
  const stopTurn = (rootId: string) => { stops.current[rootId] = true }
  // A pending steer chip appears mid-turn with no following stream delta to trigger stick-to-bottom,
  // so pin the conversation to the bottom while a steer waits (the chip is the last row of the live turn).
  const hasPending = Object.values(pendingSteers).some((l) => l.length > 0)
  useEffect(() => {
    if (!hasPending) return
    const pin = () => document.querySelectorAll("[data-steerpending]").forEach((chip) => {
      for (let el = chip.parentElement as HTMLElement | null; el; el = el.parentElement)
        if (/auto|scroll/.test(getComputedStyle(el).overflowY)) { el.scrollTop = el.scrollHeight; break }
    })
    pin()
    const id = setInterval(pin, 60)
    return () => clearInterval(id)
  }, [pendingSteers, hasPending])
  const threadRunning = (m?: Extract<Msg, { kind: "msg" }>) => !!m?.thread?.replies.some((r) => r.live)

  const mentionIn = (text: string) => employees.find((e) => channel.employees.includes(e.id) && new RegExp(`@${e.name}\\b`, "i").test(text))
  const bold = (text: string) => employees.reduce((t, e) => t.replace(new RegExp(`(?<!\\*)@${e.name}\\b`, "gi"), `**@${e.name}**`), text)

  // Top-level message. DM: always opens a new session. Channel: only when it @mentions an employee.
  const [folders, setFolders] = useState<Folder[]>(FOLDERS)
  // Last folder/branch pick per employee DM, so it survives navigating away (like an IDE's open project).
  const [wsPicks, setWsPicks] = useState<Record<string, WsPick>>({})
  const [newProjects, setNewProjects] = useState<Project[]>([])
  const [addFolderOpen, setAddFolderOpen] = useState(false)
  // projects.add_folder { id, path } (existing project) or projects.create { name, folders: [path] } (new one).
  const addFolder = (path: string, project: { existing?: string; name: string }) => {
    const d = FS[path]
    const id = `f-${slugOf(project.name)}-${baseName(path).toLowerCase()}`.replace(/[^a-z0-9-]/g, "")
    const f: Folder = { id, project: project.name, path, repo: d?.git?.remote, branches: d?.git?.branches ?? [], workstreams: [] }
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
  const sendTop = (text: string, pick?: WsPick) => {
    const target = view.kind === "dm" ? view.id : mentionIn(text)?.id
    const id = `s-${Date.now()}`
    const ws = target ? resolveWs(pick, text) : undefined
    const msg: Msg = { kind: "msg", id, from: "oscar", time: nowTime(), text: bold(text), ...(target ? { thread: { session: newSession(), replies: [], model: emp(target)?.model, ws } } : {}) }
    setFeeds((fs) => ({ ...fs, [feedKey]: [...(fs[feedKey] ?? []), msg] }))
    if (target) { showThread(id); runTurn(feedKey, id, target, text, ws) }
  }
  // Reply inside a thread = same Hermes session. While a turn runs: if the engine supports steer
  // (session.steer, prototype toggle) the message is delivered into the running turn at the next tool
  // boundary; otherwise it queues client-side and is submitted (prompt.submit) when the turn ends.
  const sendInThread = (root: Extract<Msg, { kind: "msg" }>, text: string) => {
    if (threadRunning(root)) {
      if (steerCap) setSteerBuf(root.id, [...(steerBuf.current[root.id] ?? []), bold(text)])
      else mapRoot(feedKey, root.id, (t) => ({ ...t, queue: [...(t.queue ?? []), bold(text)] }))
      return
    }
    mapRoot(feedKey, root.id, (t) => ({ ...t, replies: [...t.replies, { id: `o-${Date.now()}`, from: "oscar", time: nowTime(), text: bold(text) }] }))
    const lead = view.kind === "dm" ? view.id : mentionIn(text)?.id ?? root.thread?.replies.find((r) => emp(r.from))?.from ?? mentionIn(root.text)?.id
    if (lead) runTurn(feedKey, root.id, lead, text)
  }
  const unqueue = (root: Extract<Msg, { kind: "msg" }>, i: number) =>
    mapRoot(feedKey, root.id, (t) => ({ ...t, queue: (t.queue ?? []).filter((_, j) => j !== i) }))
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
      root={openThread} thread={openThread.thread} channelName={channel.dm ? `DM · ${channel.name}` : `#${channel.name}`}
      emp={emp} resolved={resolved} setResolved={setResolved} focus={focus}
      onFocus={() => setFocus(!focus)}
      work={workOf(openThread)} repo={channel.repo} onStart={() => setStartFor(openThread.id)}
      running={threadRunning(openThread)} onSend={(t) => sendInThread(openThread, t)} onStop={() => stopTurn(openThread.id)}
      onRetry={(e) => retry(openThread, e)} onUnqueue={(i) => unqueue(openThread, i)}
      steerCap={steerCap} onSteerCap={setSteerCap} pending={pendingSteers[openThread.id] ?? []}
    />
  ) : null

  return (
    <div className={cn("grid h-dvh grid-cols-1 overflow-hidden bg-background text-sm", !(focus && openThread?.thread) && "lg:grid-cols-[264px_minmax(0,1fr)]")}>
      {navOpen && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setNavOpen(false)} />}
      {navOpen && focus && <div className="fixed inset-0 z-30 hidden bg-black/30 lg:block" onClick={() => setNavOpen(false)} />}
      <aside className={cn("min-h-0 flex-col border-r bg-sidebar text-sidebar-foreground", navOpen ? "fixed inset-y-0 left-0 z-40 flex w-[264px] shadow-2xl" : focus && openThread?.thread ? "hidden" : "hidden lg:flex")}>
        <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <div className="grid size-7 place-items-center rounded-md bg-foreground font-bold text-background text-xs">OC</div>
          <div className="font-semibold">Oscar Co</div>
          <Button variant="ghost" size="icon-sm" className="ml-auto"><BellIcon /></Button>
          <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setNavOpen(false)}><XIcon /></Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <nav className="space-y-0.5 p-2">
            <NavItem icon={<InboxIcon />} label="Inbox" />
            <NavItem icon={<ShieldAlertIcon />} label="Needs you" count={2} tone="amber" />
            <NavItem icon={<TicketIcon />} label="Tickets" onClick={() => { setFocus(false); setPanelTab("tickets"); setPanelOpen(true) }} />
          </nav>

          <Section title="Company" />
          <div className="px-2">{COMPANY_CHANNELS.map((c) => <ChannelItem key={c.id} c={c} active={view.kind === "channel" && c.id === view.id} onClick={() => goChannel(c.id)} />)}</div>

          <Section title="Projects" onAdd={() => setAddFolderOpen(true)} />
          <div className="space-y-1 px-2">
            {[...PROJECTS, ...newProjects].map((p) => (
              <Collapsible key={p.id} defaultOpen={p.id === "lilos" || newProjects.includes(p)}>
                <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 font-medium hover:bg-sidebar-accent">
                  <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
                  <FolderGit2Icon className="size-4 text-muted-foreground" />
                  {p.name}
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">{p.key}</span>
                </CollapsibleTrigger>
                <CollapsibleContent className="ml-4 border-l pl-2">
                  {folders.filter((f) => f.project === p.name).map((f) => (
                    <div key={f.id} className="flex items-center gap-1.5 px-2 py-1 text-muted-foreground text-xs" title={f.path} data-sidebar-folder>
                      <FolderIcon className="size-3.5 shrink-0" /><span className="truncate font-mono">{f.path.replace(/^~\/Desktop\/Oscar\//, "…/")}</span>
                    </div>
                  ))}
                  {p.channels.map((c) => <ChannelItem key={c.id} c={c} active={view.kind === "channel" && c.id === view.id} onClick={() => goChannel(c.id)} />)}
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>

          <Section title="Employees" onAdd={() => setHireOpen(TEMPLATES[0])} />
          <div className="px-2 pb-4">
            {employees.map((e) => (
              <button key={e.id} onClick={() => goDM(e.id)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent", view.kind === "dm" && view.id === e.id && "bg-sidebar-accent font-medium")}>
                <HermesAvatar status={e.status} className="size-5" />
                {e.name}
                <span className="ml-auto text-muted-foreground text-xs">{e.role}</span>
              </button>
            ))}
            <button onClick={() => setHireOpen(TEMPLATES[0])} className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
              <UserPlusIcon className="size-4" /> Hire employee
            </button>
          </div>
        </ScrollArea>
        <div className="flex shrink-0 items-center gap-2 border-t px-3 py-2.5">
          <Avatar className="size-6"><AvatarFallback className="bg-blue-600 text-[11px] text-white">O</AvatarFallback></Avatar>
          <span className="min-w-0 truncate font-medium text-sm">Oscar</span>
          <ThemeToggle theme={theme} setTheme={setTheme} />
        </div>
      </aside>

      {focus && openThread?.thread ? (
        <FocusView
          root={openThread} thread={openThread.thread} channel={channel} project={project} emp={emp}
          lead={emp(view.kind === "dm" ? view.id : openThread.thread.replies.find((r) => emp(r.from))?.from ?? mentionIn(openThread.text)?.id ?? "")}
          resolved={resolved} setResolved={setResolved} work={workOf(openThread)}
          onBack={() => setFocus(false)} onNav={() => setNavOpen(true)} onStart={() => setStartFor(openThread.id)}
          running={threadRunning(openThread)} onSend={(t) => sendInThread(openThread, t)} onStop={() => stopTurn(openThread.id)}
          onRetry={(e) => retry(openThread, e)} onUnqueue={(i) => unqueue(openThread, i)}
          onRewind={(i) => rewind(openThread, i)} onModel={(m) => setModel(openThread, m)} say={say}
          onPrComment={(t) => prComment(openThread, t)} onPrMerge={() => prMerge(openThread)}
          steerCap={steerCap} onSteerCap={setSteerCap} pending={pendingSteers[openThread.id] ?? []}
        />
      ) : (
        <div className={cn("grid min-h-0 min-w-0 grid-cols-1", panelOpen && "xl:grid-cols-[minmax(0,1fr)_420px]")}>
          {channel.dm && emp(view.id) ? (
            <EmployeeHome
              e={emp(view.id)!} feed={feed} threadId={threadId} emp={emp}
              onNav={() => setNavOpen(true)} onProfile={() => showEmp(view.id)} onOpen={showThread}
              onSend={sendTop} panelOpen={panelOpen} onPanel={() => setPanelOpen(true)} folders={folders} say={say}
              pick={wsPicks[view.id] ?? NO_WS} setPick={(p) => setWsPicks((w) => ({ ...w, [view.id]: p }))} onAddFolder={() => setAddFolderOpen(true)}
            />
          ) : (
          <main className="flex min-h-0 min-w-0 flex-col">
            <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:gap-3 sm:px-5">
              <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setNavOpen(true)}><MenuIcon /></Button>
              <div className="min-w-0">
                <div className="truncate text-muted-foreground text-xs">Oscar Co / {project?.name ?? "Company"}</div>
                <div className="flex items-center gap-1 font-semibold text-base"><HashIcon className="size-4 shrink-0" /><span className="truncate">{channel.name}</span></div>
              </div>
              {channel.repo ? <Badge variant="outline" className="hidden shrink-0 font-mono md:inline-flex">⎇ {channel.repo}</Badge> : <Badge variant="outline" className="hidden shrink-0 text-muted-foreground md:inline-flex">office work</Badge>}
              <div className="ml-auto flex shrink-0 gap-1">
                <Button variant="outline" size="sm" onClick={() => { setPanelTab("tickets"); setPanelOpen(true) }}><TicketIcon /><span className="hidden sm:inline">Tickets</span></Button>
                {!panelOpen && <Button variant="ghost" size="icon-sm" onClick={() => setPanelOpen(true)}><PanelRightIcon /></Button>}
              </div>
            </header>

            {channel.employees.length > 0 && (
              <div className="flex shrink-0 gap-2 overflow-x-auto border-b bg-muted/30 px-3 py-2 sm:px-5">
                {channel.employees.map((id) => {
                  const e = emp(id)
                  if (!e) return null
                  return (
                    <button key={id} onClick={() => showEmp(id)} className="flex shrink-0 items-center gap-2 rounded-full border bg-background py-1 pr-3 pl-1 text-xs hover:border-foreground/30">
                      <HermesAvatar status={e.status} className="size-6" />
                      <span className="font-medium">{e.name}</span>
                      <span className="hidden max-w-48 truncate text-muted-foreground sm:inline">{e.now}</span>
                    </button>
                  )
                })}
              </div>
            )}

            <Conversation className="min-h-0">
              <ConversationContent className="min-h-full justify-end gap-0 p-0 py-3">
                {feed.map((m) =>
                  m.kind === "event" ? (
                    <div key={m.id} className="grid grid-cols-[36px_minmax(0,1fr)] items-center gap-3 px-3 py-1.5 text-muted-foreground text-xs sm:px-5">
                      <TicketIcon className="size-3.5 justify-self-center" />
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="shrink-0 whitespace-nowrap rounded bg-muted px-1.5 font-mono text-foreground">{m.ticket}</span>
                        <span className="min-w-0">{m.text}</span>
                      </div>
                    </div>
                  ) : (
                    <Row key={m.id} from={m.from} emp={emp} active={m.id === threadId}>
                      <Who id={m.from} time={m.time} emp={emp} />
                      <Body text={m.text} />
                      {m.hire && <HireCard draft={m.hire} by={m.from} emp={emp} done={resolved[m.id]} onReview={() => setHireOpen(m.hire!)} onReject={() => setResolved({ ...resolved, [m.id]: "Hire declined" })} />}
                      {m.thread && <ThreadSummary thread={m.thread} work={workOf(m)} emp={emp} onOpen={() => showThread(m.id)} />}
                      {!m.thread && !m.hire && (
                        <button onClick={() => say("Reply in thread (prototype)")} className="mt-1 hidden items-center gap-1 text-muted-foreground text-xs hover:text-foreground group-hover:inline-flex">
                          <MessageSquareIcon className="size-3.5" />Reply in thread
                        </button>
                      )}
                    </Row>
                  ),
                )}
                {feed.length === 0 && <p className="px-5 py-10 text-center text-muted-foreground">No messages in #{channel.name} yet.</p>}
              </ConversationContent>
              <ConversationScrollButton />
            </Conversation>

            <Composer placeholder={`Message #${channel.name}. @ an employee to start a thread`} employees={employees.filter((e) => channel.employees.includes(e.id))} hint="An @mention opens a thread = one Hermes session" onSend={sendTop} />
          </main>
          )}

          {panelOpen && (
            <aside className="flex min-h-0 flex-col border-l bg-background max-xl:fixed max-xl:inset-y-0 max-xl:right-0 max-xl:z-30 max-xl:w-[min(420px,100vw)] max-xl:shadow-2xl">
              <Tabs value={panelTab} onValueChange={(v) => setPanelTab(v as typeof panelTab)} className="flex min-h-0 flex-1 flex-col gap-0">
                <div className="flex h-14 shrink-0 items-center border-b px-3">
                  <TabsList>
                    <TabsTrigger value="thread">Thread</TabsTrigger>
                    <TabsTrigger value="employee">Employee</TabsTrigger>
                    <TabsTrigger value="tickets">Tickets</TabsTrigger>
                  </TabsList>
                  <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => setPanelOpen(false)}><XIcon /></Button>
                </div>
                <TabsContent value="thread" className="flex min-h-0 flex-1 flex-col">
                  {threadPanel ?? <p className="p-6 text-center text-muted-foreground">{channel.dm ? <>Pick a session on the left,<br />or send a message to start one.</> : <>Open a thread from the channel.<br />Every @mention of an employee starts one.</>}</p>}
                </TabsContent>
                <TabsContent value="employee" className="min-h-0 flex-1">
                  <ScrollArea className="h-full">{emp(selectedEmp) && <EmployeeCard e={emp(selectedEmp)!} onDM={() => goDM(selectedEmp)} />}</ScrollArea>
                </TabsContent>
                <TabsContent value="tickets" className="min-h-0 flex-1">
                  <ScrollArea className="h-full">
                    <div className="space-y-2 p-3">
                      <p className="text-muted-foreground text-xs">Tickets belong to the project. Each links to the thread where the work happened.</p>
                      {tickets.map((t) => (
                        <div key={t.id} className="rounded-lg border bg-background p-2.5">
                          <div className="flex items-center gap-2"><span className="shrink-0 whitespace-nowrap font-mono text-muted-foreground text-xs">{t.id}</span><span className="min-w-0 truncate font-medium">{t.title}</span><Badge variant="secondary" className="ml-auto shrink-0">{t.status}</Badge></div>
                          <div className="mt-1.5 flex items-center gap-1.5 text-muted-foreground text-xs"><HermesAvatar className="size-4" />{emp(t.who)?.name} · #{t.ch}</div>
                          <div className="mt-1 flex items-center gap-1.5 text-muted-foreground text-xs">
                            {t.branch
                              ? <><GitBranchIcon className="size-3.5 shrink-0" /><span className="truncate font-mono">{t.branch}</span><span className="ml-auto shrink-0 whitespace-nowrap">.lilos/wt/{t.id.toLowerCase()}</span></>
                              : <><FolderGit2Icon className="size-3.5 shrink-0" />no worktree · office work</>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </TabsContent>
              </Tabs>
            </aside>
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
          onClose={() => setAddFolderOpen(false)} onAdd={addFolder}
        />
      )}
      {hireOpen && <HireDialog initial={hireOpen} onClose={() => setHireOpen(null)} onHire={hire} usedProfiles={employees.map((e) => e.profile)} />}
      {toast && <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-foreground px-4 py-2 text-background text-sm shadow-lg">{toast}</div>}
    </div>
  )
}

function Who({ id, time, emp }: { id: string; time: string; emp: EmpFn }) {
  const e = emp(id)
  const h = HUMANS[id]
  return (
    <div className="flex flex-wrap items-baseline gap-1.5">
      <span className="font-semibold">{e?.name ?? h?.name}</span>
      {e && <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">EMPLOYEE</Badge>}
      {h?.guest && <Badge variant="outline" className="h-4 border-amber-300 px-1.5 text-[10px] text-amber-700">GUEST</Badge>}
      <span className="text-muted-foreground text-xs">{time}</span>
    </div>
  )
}

function Row({ from, emp, active, children }: { from: string; emp: EmpFn; active?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("group relative grid grid-cols-[36px_minmax(0,1fr)] gap-3 px-3 py-2 hover:bg-muted/40 sm:px-5", active && "bg-blue-50/70 hover:bg-blue-50/70")}>
      {emp(from) ? <HermesAvatar /> : <HumanAvatar id={from} />}
      <Message from="assistant" className="min-w-0 max-w-full gap-1">{children}</Message>
    </div>
  )
}

function ThreadSummary({ thread, work, emp, onOpen }: { thread: Thread; work: Work | null; emp: EmpFn; onOpen: () => void }) {
  const last = thread.replies[thread.replies.length - 1]
  if (!last) return null
  const workers = [...new Set(thread.replies.map((r) => r.from).filter((f) => emp(f)))]
  return (
    <button onClick={onOpen} className="mt-1 flex w-fit max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-background px-2 py-1.5 text-left text-xs hover:border-foreground/30 [&>*]:shrink-0 [&>*]:whitespace-nowrap">
      <span className="flex -space-x-1.5">{workers.map((w) => <HermesAvatar key={w} className="size-5 rounded-[28%] ring-2 ring-background" />)}</span>
      <span className="font-medium text-blue-600">{thread.replies.length} replies</span>
      {work?.ticket ? <span className="rounded bg-muted px-1 font-mono">{work.ticket}</span> : work ? null : <span className="flex items-center gap-1 text-muted-foreground"><EyeIcon className="size-3" />discussion</span>}
      {work?.branch && <span className="flex items-center gap-1 font-mono text-emerald-700"><GitBranchIcon className="size-3" />{work.branch}</span>}
      {thread.replies.some((r) => r.approval) && <span className="flex items-center gap-1 text-amber-700"><ShieldAlertIcon className="size-3" />approval</span>}
      {last.streaming || last.live
        ? <span className="flex items-center gap-1 text-muted-foreground"><CircleDotIcon className="size-3 animate-pulse text-amber-500" />{emp(last.from)?.name} {last.phase ? PHASE_LABEL[last.phase] : "working"}</span>
        : <span className="text-muted-foreground">last {last.time}</span>}
      <ChevronRightIcon className="size-3.5 text-muted-foreground" />
    </button>
  )
}

function HireCard({ draft, by, emp, done, onReview, onReject }: { draft: HireDraft; by: string; emp: EmpFn; done?: string; onReview: () => void; onReject: () => void }) {
  return (
    <div className="mt-1 w-full max-w-xl overflow-hidden rounded-lg border border-violet-300">
      <div className="flex items-center gap-2 bg-violet-50 px-3 py-2 font-medium text-violet-900 text-xs"><UserPlusIcon className="size-3.5" />{done ?? `${emp(by)?.name} proposes a hire · only Oscar can approve`}</div>
      {!done && (
        <div className="space-y-2 p-3">
          <div className="flex items-center gap-2"><HermesAvatar className="size-8" /><div><div className="font-semibold">{draft.name}</div><div className="text-muted-foreground text-xs">{draft.role} · {draft.model}</div></div></div>
          <p className="line-clamp-2 text-muted-foreground text-xs">{draft.instructions}</p>
          <div className="flex gap-1.5"><Button size="sm" onClick={onReview}>Review & hire</Button><Button size="sm" variant="ghost" onClick={onReject}>Decline</Button></div>
        </div>
      )}
    </div>
  )
}

function ThreadView({ root, thread, channelName, emp, resolved, setResolved, focus, onFocus, work, repo, onStart, running, onSend, onStop, onRetry, onUnqueue, steerCap, onSteerCap, pending }: {
  root: Extract<Msg, { kind: "msg" }>; thread: Thread; channelName: string; emp: EmpFn
  resolved: Record<string, string>; setResolved: (r: Record<string, string>) => void
  focus: boolean; onFocus: () => void
  work: Work | null; repo?: string; onStart: () => void
  running: boolean; onSend: (text: string) => void; onStop: () => void; onRetry: (empId: string) => void; onUnqueue: (i: number) => void
  steerCap: boolean; onSteerCap: (v: boolean) => void; pending: string[]
}) {
  const [openSteps, setOpenSteps] = useState<Record<number, boolean>>({})
  const lead = thread.replies.find((r) => emp(r.from))
  const leadEmp = lead ? emp(lead.from) : undefined
  const isDM = channelName.startsWith("DM")
  const status: ChatStatus = running ? (thread.replies.some((r) => r.live && r.phase === "submitted") ? "submitted" : "streaming") : "ready"
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-semibold">
            <span className="truncate">{isDM ? "Session" : "Thread"}</span>
            {work?.ticket && <span className="shrink-0 font-mono text-muted-foreground text-xs">· {work.ticket}</span>}
          </div>
          <div className="truncate text-muted-foreground text-xs">{channelName} · {leadEmp && !isDM && `${leadEmp.name} · `}Hermes <code className="rounded bg-muted px-1">{thread.session}</code></div>
          {thread.ws ? <WsBadge ws={thread.ws} /> : <WorkspaceBadge work={work} repo={repo} />}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {thread.usage && leadEmp && <SessionUsage usage={thread.usage} model={leadEmp.model} />}
          {!work && !isDM && <Button size="sm" className="ml-1" onClick={onStart}><PlayIcon />Start work</Button>}
          <Button variant="ghost" size="icon-sm" className="ml-0.5" title="Focus" aria-label="Focus" onClick={onFocus}><Maximize2Icon /></Button>
        </div>
      </div>
      <Conversation className="min-h-0">
        <ConversationContent className="gap-0 p-0 py-2">
          <Row from={root.from} emp={emp}>
            <Who id={root.from} time={root.time} emp={emp} />
            <Body text={root.text} />
            <div className="text-muted-foreground text-xs">opened session <code className="rounded bg-muted px-1">{thread.session}</code></div>
          </Row>
          <div className="my-1 flex items-center gap-2 px-3 text-muted-foreground text-xs sm:px-5"><span>{thread.replies.length} {thread.replies.length === 1 ? "reply" : "replies"}</span><span className="h-px flex-1 bg-border" /></div>
          {thread.replies.map((r, i) => {
            const isEmp = !!emp(r.from)
            const steps = r.steps ?? []
            return (
              <Row key={r.id ?? i} from={r.from} emp={emp}>
                <Who id={r.from} time={r.time} emp={emp} />
                {r.reasoning !== undefined && (
                  <Reasoning className="mb-1 w-full" isStreaming={r.live && r.phase === "thinking"} duration={r.thought ?? 0} defaultOpen={!!r.live}>
                    <ReasoningTrigger className="w-fit text-xs" getThinkingMessage={(s, d) => (s ? <Shimmer duration={1}>Thinking…</Shimmer> : <span>Thought for {d || 1}s</span>)} />
                    <ReasoningContent className="mt-2 border-l-2 pl-3 text-xs">{r.reasoning || "…"}</ReasoningContent>
                  </Reasoning>
                )}
                {steps.length > 0 && (
                  <Task className="mb-1" open={!!openSteps[i] || (!!r.live && r.phase === "tools")} onOpenChange={(o) => setOpenSteps({ ...openSteps, [i]: o })}>
                    <TaskTrigger title={plural(steps.length, "step")}>
                      <div className="flex w-fit cursor-pointer items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground">
                        {steps.some((s) => s.running) ? <CircleDotIcon className="size-3.5 animate-pulse text-amber-500" /> : <CheckIcon className="size-3.5 text-emerald-600" />}
                        <span>{steps.some((s) => s.running) ? `${steps[steps.length - 1].tool}…` : plural(steps.length, "step")}</span>
                        <LockIcon className="size-3" />
                        <ChevronDownIcon className="size-3.5 transition-transform group-data-[panel-open]:rotate-180" />
                      </div>
                    </TaskTrigger>
                    <TaskContent className="[&>div]:mt-2">
                      {steps.map((s, j) => (
                        <Tool key={j} className="mb-0 bg-background">
                          <ToolHeader title={s.tool} type={`tool-${s.tool}`} state={s.running ? "input-available" : "output-available"} />
                          <ToolContent><ToolInput input={s.input} /><ToolOutput output={s.output || undefined} errorText={undefined} /></ToolContent>
                        </Tool>
                      ))}
                    </TaskContent>
                  </Task>
                )}
                {r.live && r.phase === "submitted" && <Shimmer className="text-sm">Opening Hermes session…</Shimmer>}
                {r.streaming ? <Shimmer>{r.streaming}</Shimmer> : r.text ? <Body text={r.text} /> : null}
                {r.steers?.map((s, k) => (
                  <div key={k} className="flex w-fit max-w-full items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900 text-xs">
                    <span className="shrink-0 font-medium">Oscar steered</span><span className="min-w-0">{s}</span>
                  </div>
                ))}
                {r.live && pending.map((s, k) => (
                  <div key={`p${k}`} data-steerpending className="flex w-fit max-w-full items-start gap-1.5 rounded-md border border-dashed border-amber-300 bg-amber-50/40 px-2 py-1 text-amber-900/70 text-xs">
                    <span className="shrink-0 font-medium">Steer pending</span><span className="min-w-0">{plain(s)}</span>
                  </div>
                ))}
                {r.phase === "stopped" && <div className="w-fit rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">Stopped · session.interrupt</div>}
                {isEmp && !r.live && !r.streaming && r.text && (
                  <MessageActions className="absolute top-1 right-3 gap-0 rounded-md border bg-background p-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                    <MessageAction tooltip="Copy" label="Copy" onClick={() => navigator.clipboard?.writeText(r.text)}><CopyIcon className="size-3.5" /></MessageAction>
                    {i === thread.replies.length - 1 && <MessageAction tooltip="Retry turn" label="Retry" onClick={() => onRetry(r.from)}><RefreshCcwIcon className="size-3.5" /></MessageAction>}
                  </MessageActions>
                )}
                <ReplyCards r={r} work={work} repo={repo} emp={emp} resolved={resolved} setResolved={setResolved} onStart={onStart} />
              </Row>
            )
          })}
          {work?.by && (
            <div className="mx-3 my-2 rounded-lg border border-emerald-200 bg-emerald-50/40 p-3 text-xs sm:mx-5">
              <div className="flex items-center gap-1.5 font-medium text-emerald-900"><PlayIcon className="size-3.5" />{work.by} started work · {work.ticket}</div>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                <li className="flex gap-1.5"><CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />Ticket <span className="font-mono text-foreground">{work.ticket}</span> created from this thread</li>
                {work.branch && <li className="flex gap-1.5"><CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" /><span className="min-w-0 break-all font-mono">git worktree add .lilos/wt/{work.ticket.toLowerCase()} -b {work.branch}</span></li>}
                {work.branch && <li className="flex gap-1.5"><CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />Session <span className="font-mono">{thread.session}</span> moved to the worktree. Same session, no history lost.</li>}
              </ul>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <Composer
        placeholder={running ? (steerCap ? `${leadEmp?.name ?? "Employee"} is working. Enter steers this turn…` : `${leadEmp?.name ?? "Employee"} is working. Your message waits in the queue…`) : `Reply to ${leadEmp?.name ?? "the thread"} in this session…`} employees={[]}
        hint={running ? (steerCap ? "Enter steers · ■ = stop" : "Enter queues · ■ = stop") : work?.branch ? `Edits go to ⎇ ${work.branch}` : work ? "Ticket only. No repo on this channel." : repo ? "Read-only on main. Start work to edit code." : `session ${thread.session}`}
        onSend={onSend} status={status} onStop={onStop}
        tools={<SteerToggle cap={steerCap} setCap={onSteerCap} />}
        queued={<QueuedTray queue={thread.queue ?? []} onRemove={onUnqueue} />}
      />
    </div>
  )
}

function ReplyCards({ r, work, repo, emp, resolved, setResolved, onStart }: {
  r: Reply; work: Work | null; repo?: string; emp: EmpFn
  resolved: Record<string, string>; setResolved: (r: Record<string, string>) => void; onStart: () => void
}) {
  const done = r.approval && resolved[r.approval.id]
  return (
    <>
      {r.startProposal && (
        <div className={cn("mt-1 w-full max-w-md overflow-hidden rounded-lg border", work ? "border-emerald-200" : "border-violet-300")}>
          <div className={cn("flex items-center gap-2 px-3 py-2 font-medium text-xs", work ? "bg-emerald-50 text-emerald-900" : "bg-violet-50 text-violet-900")}>
            {work ? <><CheckIcon className="size-3.5" />Started as {work.ticket}</> : <><PlayIcon className="size-3.5" />{emp(r.from)?.name} asks to start work</>}
          </div>
          {!work && (
            <div className="space-y-2 p-3">
              <div className="font-medium">{r.startProposal.title}</div>
              <p className="text-muted-foreground text-xs">{repo ? `New ticket + worktree on ${repo}. This thread and its Hermes session move there.` : "New ticket. No repo on this channel, so no worktree."}</p>
              <div className="flex gap-1.5"><Button size="sm" onClick={onStart}>Review & start</Button><Button size="sm" variant="ghost">Not yet</Button></div>
            </div>
          )}
        </div>
      )}
      {r.approval && (() => {
        const a = r.approval
        const answer = (v: string) => setResolved({ ...resolved, [a.id]: v })
        return (
          <Confirmation
            className={cn("mt-1", done ? (done.startsWith("Denied") ? "border-red-200" : "border-emerald-200") : "border-amber-300 bg-amber-50/50")}
            state={done ? "approval-responded" : "approval-requested"}
            approval={done ? { id: a.id, approved: !done.startsWith("Denied"), reason: done } : { id: a.id }}
          >
            <ConfirmationTitle className="flex flex-wrap items-center gap-1.5 pr-2 font-medium text-foreground">
              <ConfirmationRequest><ShieldAlertIcon className="size-3.5 text-amber-600" />Approval needed · only Oscar can answer</ConfirmationRequest>
              <ConfirmationAccepted><CheckIcon className="size-3.5 text-emerald-600" />{done}</ConfirmationAccepted>
              <ConfirmationRejected><XIcon className="size-3.5 text-red-600" />{done}</ConfirmationRejected>
            </ConfirmationTitle>
            <ConfirmationRequest>
              <CodeBlock code={a.command} language="bash" className="text-xs [&_pre]:whitespace-pre-wrap [&_pre]:break-all" />
              <p className="text-muted-foreground text-xs">{a.note}</p>
            </ConfirmationRequest>
            <ConfirmationActions className="flex-wrap self-start">
              <ConfirmationAction onClick={() => answer("Allowed once by Oscar")}>Allow once</ConfirmationAction>
              <ConfirmationAction variant="outline" onClick={() => answer("Always allowed here")}>Always here</ConfirmationAction>
              <ConfirmationAction variant="ghost" onClick={() => answer("Denied by Oscar")}>Deny</ConfirmationAction>
            </ConfirmationActions>
          </Confirmation>
        )
      })()}
    </>
  )
}

/* ================= Focus mode: the thread becomes an agent workbench (Codex / Claude Code style) =================
   Left: transcript of the ONE Hermes session (turns, reasoning, tool rows, checkpoints, plan + queue, composer).
   Right: workbench derived only from that session's tool calls — Changes (inline_diff), Files, Terminal, Tests, Preview. */

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "")
const plain = (s: string) => s.replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim()
type WbTab = "changes" | "files" | "terminal" | "preview" | "pr"

const REPO_FILES = [
  "README.md", "package.json", "pnpm-workspace.yaml", "tsconfig.base.json",
  "apps/relay/package.json", "apps/relay/src/index.ts", "apps/web/package.json", "apps/web/src/main.tsx",
  "docs/decisions/0001-monorepo.md",
  "packages/client-runtime/package.json", "packages/client-runtime/src/reducer.ts", "packages/client-runtime/tsconfig.json",
  "packages/contracts/package.json", "packages/contracts/src/envelope.ts",
]

function sessionArtifacts(thread: Thread) {
  const steps = thread.replies.flatMap((r) => r.steps ?? [])
  const diffs = new Map<string, Diff>()
  for (const s of steps) {
    if (!s.diff) continue
    const p = diffs.get(s.diff.path)
    diffs.set(s.diff.path, p ? { ...s.diff, add: p.add + s.diff.add, del: p.del + s.diff.del, status: p.status === "added" ? "added" : s.diff.status, patch: `${p.patch}\n${s.diff.patch}` } : s.diff)
  }
  const term = steps.filter((s) => s.tool === "terminal")
  const termOut = term.map((s) => `\u001b[36m$ ${String(s.input.command ?? "")}\u001b[0m\n${s.output}${s.output ? "\n" : ""}`).join("\n")
  const commits = steps.filter((s) => s.commit).map((s) => s.commit!).reverse()
  const add = [...diffs.values()].reduce((n, d) => n + d.add, 0)
  const del = [...diffs.values()].reduce((n, d) => n + d.del, 0)
  return { diffs: [...diffs.values()], termOut, termRunning: term.some((s) => s.running), commits, add, del }
}

const STEP_VERB: Record<string, string> = { terminal: "Ran", read_file: "Read", write_file: "Wrote", patch: "Edited", search_files: "Searched", web_search: "Searched web" }

/* Unified diff with tinted rows + old/new gutters (GitHub / Devin style) instead of colour-only text. */
type DiffRow = { kind: "hunk" | "add" | "del" | "ctx"; text: string; a?: number; b?: number }
function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = []
  let a = 0, b = 0
  for (const line of patch.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (h) { a = Number(h[1]); b = Number(h[2]); rows.push({ kind: "hunk", text: line }); continue }
    if (line.startsWith("+")) rows.push({ kind: "add", text: line.slice(1), b: b++ })
    else if (line.startsWith("-")) rows.push({ kind: "del", text: line.slice(1), a: a++ })
    else rows.push({ kind: "ctx", text: line.slice(1), a: a++, b: b++ })
  }
  return rows
}
function DiffStat({ add, del }: { add: number; del: number }) {
  return <span className="inline-flex items-center gap-1 font-mono text-[12px] tabular-nums"><span className="text-emerald-600">+{add}</span><span className={del ? "text-red-600" : "text-muted-foreground/60"}>−{del}</span></span>
}
function DiffView({ d, collapsible = true }: { d: Diff; collapsible?: boolean }) {
  const [open, setOpen] = useState(true)
  const [viewed, setViewed] = useState(false)
  const slash = d.path.lastIndexOf("/")
  const name = d.path.slice(slash + 1)
  const dir = slash > 0 ? d.path.slice(0, slash) : ""
  const rows = parsePatch(d.patch)
  return (
    <div className="overflow-hidden rounded-lg border bg-background" data-diff={d.path}>
      <div className="flex h-9 items-center gap-2 bg-muted/40 px-2.5 text-[13px]">
        {collapsible && <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)} aria-label="Toggle file"><ChevronDownIcon className={cn("size-3.5 transition-transform", !open && "-rotate-90")} /></button>}
        <span className={cn("rounded px-1 font-mono font-semibold text-[10px]", d.status === "added" ? "bg-emerald-500/10 text-emerald-700" : d.status === "deleted" ? "bg-red-500/10 text-red-700" : "bg-amber-500/10 text-amber-700")}>{d.status === "added" ? "A" : d.status === "deleted" ? "D" : "M"}</span>
        <span className="min-w-0 truncate"><span className="font-medium">{name}</span>{dir && <span className="ml-1.5 text-muted-foreground">{dir}</span>}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          <DiffStat add={d.add} del={d.del} />
          {collapsible && (
            <label className="flex cursor-pointer items-center gap-1.5 border-l pl-2.5 text-muted-foreground text-xs">
              <input type="checkbox" className="size-3.5 accent-foreground" checked={viewed} onChange={(e) => { setViewed(e.target.checked); setOpen(!e.target.checked) }} />Viewed
            </label>
          )}
        </span>
      </div>
      {open && (
        <div className="overflow-x-auto border-t font-mono text-[12px] leading-5">
          <table className="w-full border-collapse">
            <tbody>
              {rows.map((r, i) => r.kind === "hunk" ? (
                <tr key={i} className="bg-blue-500/[0.06] text-blue-700/80"><td colSpan={3} className="px-3 py-0.5 text-[11px]">{r.text}</td></tr>
              ) : (
                <tr key={i} className={cn(r.kind === "add" && "bg-emerald-500/[0.09]", r.kind === "del" && "bg-red-500/[0.09]")}>
                  <td className={cn("w-9 select-none border-r px-1.5 text-right align-top text-[11px] text-muted-foreground/70 tabular-nums", r.kind === "add" && "border-l-2 border-l-emerald-500", r.kind === "del" && "border-l-2 border-l-red-500")}>{r.a ?? ""}</td>
                  <td className="w-9 select-none border-r px-1.5 text-right align-top text-[11px] text-muted-foreground/70 tabular-nums">{r.b ?? ""}</td>
                  <td className="whitespace-pre px-3 text-foreground/90"><span className={cn("mr-2 select-none", r.kind === "add" ? "text-emerald-600" : r.kind === "del" ? "text-red-600" : "text-transparent")}>{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>{r.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
function StepRow({ s }: { s: Step }) {
  const [open, setOpen] = useState(false)
  const arg = String(s.input.command ?? s.input.path ?? s.input.pattern ?? s.input.query ?? "")
  const verb = s.diff?.status === "added" ? "Created" : STEP_VERB[s.tool] ?? s.tool
  const hasBody = !s.running && (!!s.diff || !!s.output)
  return (
    <div className="relative pl-4 before:absolute before:top-0 before:bottom-0 before:left-[5px] before:w-px before:bg-border last:before:bottom-1/2">
      <span className={cn("absolute top-[11px] left-[2px] size-[7px] rounded-full", s.running ? "animate-pulse bg-amber-500" : "bg-emerald-500")} />
      <button type="button" disabled={!hasBody} onClick={() => setOpen(!open)} className="group/step flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-muted/60 disabled:hover:bg-transparent">
        {s.running ? <Shimmer as="span" duration={1} className="shrink-0 font-medium">{verb}</Shimmer> : <span className="shrink-0 font-medium text-foreground">{verb}</span>}
        <code className="min-w-0 truncate font-mono text-[12.5px] text-foreground/70">{arg}</code>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[12px]">
          {s.diff && <DiffStat add={s.diff.add} del={s.diff.del} />}
          {s.commit && <span className="text-muted-foreground">{s.commit.hash}</span>}
          {hasBody && <ChevronRightIcon className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />}
        </span>
      </button>
      {open && hasBody && (
        <div className="mt-1 mb-2 ml-1.5">
          {s.diff
            ? <DiffView d={s.diff} collapsible={false} />
            : <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-950 p-3 font-mono text-[12px] leading-5 text-zinc-100">{stripAnsi(s.output)}</pre>}
        </div>
      )}
    </div>
  )
}

/* Engine capability pill in the composer tools: fake-engine session.steer. ON = a message sent while
   the employee works is delivered into the running turn ("Oscar steered"). OFF = it queues, as before. */
function SteerToggle({ cap, setCap }: { cap: boolean; setCap: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={cap} data-steertoggle
      title={cap ? "Engine supports steer · click to disable (messages queue instead)" : "Engine without steer · click to enable (messages steer the running turn)"}
      onClick={() => setCap(!cap)}
      className={cn("flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs", cap ? "text-foreground hover:bg-muted" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
      <span className={cn("relative h-3.5 w-6 shrink-0 rounded-full transition-colors", cap ? "bg-emerald-500" : "bg-muted-foreground/30")}>
        <span className={cn("absolute top-0.5 size-2.5 rounded-full bg-white transition-all", cap ? "left-3" : "left-0.5")} />
      </span>
      steer
    </button>
  )
}

function ModelLogo({ model }: { model: string }) {
  const p = model.startsWith("qwen") ? "alibaba" : model.startsWith("claude") ? "anthropic" : model.startsWith("gpt") ? "openai" : null
  return p ? <ModelSelectorLogo provider={p} className="size-3.5" /> : <CpuIcon className="size-3.5 text-muted-foreground" />
}
// Session model. Real app: slash.exec "/model <id>" on this session (applies from the next turn).
function ModelPicker({ model, onModel }: { model: string; onModel: (m: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger render={<PromptInputButton size="sm" className="gap-1.5 text-xs" />}>
        <ModelLogo model={model} /><span className="max-w-36 truncate">{model.split(" ")[0]}</span><ChevronDownIcon className="size-3" />
      </ModelSelectorTrigger>
      <ModelSelectorContent title="Model for this session">
        <ModelSelectorInput placeholder="Search models…" />
        <ModelSelectorList>
          <ModelSelectorEmpty>No model found.</ModelSelectorEmpty>
          <ModelSelectorGroup heading="Hermes providers · applies from the next turn">
            {MODELS.map((m) => (
              <ModelSelectorItem key={m} value={m} onSelect={() => { onModel(m); setOpen(false) }}>
                <ModelLogo model={m} /><ModelSelectorName>{m}</ModelSelectorName>
                {m === model && <CheckIcon className="ml-auto size-4" />}
              </ModelSelectorItem>
            ))}
          </ModelSelectorGroup>
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  )
}

function FocusComposer({ running, status, placeholder, hint, model, onModel, onSend, onStop, steerCap, onSteerCap }: {
  running: boolean; status: ChatStatus; placeholder: string; hint: string
  model: string; onModel: (m: string) => void; onSend: (t: string) => void; onStop: () => void
  steerCap: boolean; onSteerCap: (v: boolean) => void
}) {
  const [draft, setDraft] = useState("")
  return (
    // While the employee works, Enter steers the turn if the engine supports session.steer (prototype
    // toggle); otherwise it queues (sent after the turn).
    <div>
      <PromptInput onSubmit={({ text }) => { const t = text.trim() || draft.trim(); if (t) onSend(t); setDraft("") }}>
        <PromptInputBody>
          <PromptInputTextarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder} className="min-h-14" />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools className="min-w-0">
            <PromptInputButton><PaperclipIcon /></PromptInputButton>
            <ModelPicker model={model} onModel={onModel} />
            <SteerToggle cap={steerCap} setCap={onSteerCap} />
            <span className="hidden truncate text-muted-foreground text-xs md:inline">{hint}</span>
          </PromptInputTools>
          <div className="flex shrink-0 items-center gap-1">
            {running && !draft.trim()
              ? <PromptInputSubmit status={status} type="button" onClick={onStop} aria-label="Stop"><SquareIcon className="size-3.5 fill-current" /></PromptInputSubmit>
              : <PromptInputSubmit disabled={!draft.trim()} />}
          </div>
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}

type TreeNode = { name: string; path: string; children: Map<string, TreeNode> }
function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() }
  for (const p of paths) {
    let n = root
    p.split("/").forEach((part, i, a) => {
      const path = a.slice(0, i + 1).join("/")
      if (!n.children.has(part)) n.children.set(part, { name: part, path, children: new Map() })
      n = n.children.get(part)!
    })
  }
  return root
}
function TreeNodes({ node, changed }: { node: TreeNode; changed: Map<string, Diff> }) {
  const kids = [...node.children.values()].sort((a, b) => Number(b.children.size > 0) - Number(a.children.size > 0) || a.name.localeCompare(b.name))
  return (
    <>
      {kids.map((k) => k.children.size > 0 ? (
        <FileTreeFolder key={k.path} path={k.path} name={k.name}><TreeNodes node={k} changed={changed} /></FileTreeFolder>
      ) : (
        <FileTreeFile key={k.path} path={k.path} name={k.name}>
          <span className="size-4 shrink-0" />
          <FileTreeIcon>{changed.has(k.path) ? <FilePenIcon className="size-4 text-amber-600" /> : <FileCodeIcon className="size-4 text-muted-foreground" />}</FileTreeIcon>
          <FileTreeName className={cn(changed.has(k.path) && "font-medium")}>{k.name}</FileTreeName>
          {changed.has(k.path) && <span className={cn("ml-auto pl-2 font-mono text-[10px]", changed.get(k.path)!.status === "added" ? "text-emerald-600" : "text-amber-600")}>{changed.get(k.path)!.status === "added" ? "A" : "M"}</span>}
        </FileTreeFile>
      ))}
    </>
  )
}

function Workbench({ thread, work, isDM, lead, tab, setTab, onClose, onStart, onSend, say, onPrComment, onPrMerge }: {
  thread: Thread; work: Work | null; isDM: boolean; lead?: Employee
  tab: WbTab; setTab: (t: WbTab) => void; onClose: () => void; onStart: () => void; onSend: (t: string) => void; say: (t: string) => void
  onPrComment: (t: string) => void; onPrMerge: () => void
}) {
  const a = sessionArtifacts(thread)
  const [sel, setSel] = useState<string | null>(null)
  const changed = new Map(a.diffs.map((d) => [d.path, d]))
  const tree = buildTree([...new Set([...REPO_FILES, ...changed.keys()])])
  const folders = new Set<string>()
  a.diffs.forEach((d) => d.path.split("/").slice(0, -1).forEach((_, i, arr) => folders.add(arr.slice(0, i + 1).join("/"))))
  const cwd = work?.path ?? (work?.branch ? `.lilos/wt/${work.ticket.toLowerCase()}` : "main")
  const shown = sel ? a.diffs.filter((d) => d.path === sel) : a.diffs
  const count = (n: number) => n > 0 && <span className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">{n}</span>
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as WbTab)} className="flex min-h-0 flex-1 flex-col gap-0">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <TabsList variant="line" className="no-scrollbar h-full min-w-0 overflow-x-auto">
          <TabsTrigger value="changes"><FileDiffIcon />Changes{count(a.diffs.length)}</TabsTrigger>
          <TabsTrigger value="files"><FolderGit2Icon />Files</TabsTrigger>
          <TabsTrigger value="terminal"><SquareTerminalIcon />Terminal{a.termRunning && <CircleDotIcon className="size-3 animate-pulse text-amber-500" />}</TabsTrigger>
          <TabsTrigger value="preview"><GlobeIcon />Preview</TabsTrigger>
          {thread.pr && <TabsTrigger value="pr"><GitPullRequestIcon className={thread.pr.status === "merged" ? "text-violet-600" : "text-emerald-600"} />PR #{thread.pr.number}</TabsTrigger>}
        </TabsList>
        <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={onClose} title="Hide workbench"><PanelRightCloseIcon /></Button>
      </div>

      <TabsContent value="changes" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          {a.diffs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-8 text-center text-muted-foreground text-xs">
              <EyeIcon className="size-5" />
              {work?.branch ? <p>No edits yet on <span className="font-mono">⎇ {work.branch}</span>.</p>
                : isDM ? <p>Read-only session. {lead?.name ?? "The employee"} reads code but can't edit here.<br />Edits happen on a ticket in a channel with a repo.</p>
                : <><p>Read-only on <span className="font-mono">main</span>. Start work gives {lead?.name ?? "the employee"} a ticket + worktree.</p><Button size="sm" onClick={onStart}><PlayIcon />Start work</Button></>}
            </div>
          ) : (
            <div className="space-y-3 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">{plural(a.diffs.length, "file")} changed</span>
                <span className="font-mono text-emerald-600">+{a.add}</span><span className="font-mono text-red-600">−{a.del}</span>
                {work?.branch && <span className="flex items-center gap-1 text-muted-foreground"><GitBranchIcon className="size-3" /><span className="font-mono">{work.branch}</span></span>}
                {sel && <Button variant="ghost" size="xs" onClick={() => setSel(null)}>Show all</Button>}
              </div>
              {shown.map((d) => <DiffView key={d.path} d={d} />)}
              {a.commits.length > 0 && (
                <div className="space-y-2 pt-2">
                  <div className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs"><GitCommitHorizontalIcon className="size-3.5" />Commits on this branch</div>
                  {a.commits.map((c) => (
                    <Commit key={c.hash}>
                      <CommitHeader nativeButton={false}>
                        <CommitInfo className="min-w-0">
                          <CommitMessage className="truncate">{c.message}</CommitMessage>
                          <CommitMetadata><CommitHash>{c.hash}</CommitHash><CommitSeparator />{lead?.name}<CommitSeparator />{plural(c.files.length, "file")}</CommitMetadata>
                        </CommitInfo>
                        <CommitActions><CommitCopyButton hash={c.hash} /></CommitActions>
                      </CommitHeader>
                      <CommitContent>
                        <CommitFiles>
                          {c.files.map((f) => (
                            <CommitFile key={f.path}>
                              <CommitFileInfo><CommitFileStatus status={f.status} /><CommitFileIcon /><CommitFilePath>{f.path}</CommitFilePath></CommitFileInfo>
                              <CommitFileChanges><CommitFileAdditions count={f.add} /><CommitFileDeletions count={f.del} /></CommitFileChanges>
                            </CommitFile>
                          ))}
                        </CommitFiles>
                      </CommitContent>
                    </Commit>
                  ))}
                </div>
              )}
            </div>
          )}
        </ScrollArea>
      </TabsContent>

      <TabsContent value="files" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="p-3">
            <div className="mb-2 flex items-center gap-1.5 text-muted-foreground text-xs"><FolderGit2Icon className="size-3.5" /><span className="font-mono">{cwd}</span>{a.diffs.length > 0 && <span>· {plural(a.diffs.length, "file")} touched by this session</span>}</div>
            <FileTree
              defaultExpanded={new Set(["packages", "apps", ...folders])}
              selectedPath={sel ?? undefined}
              onSelect={(p) => { if (changed.has(p)) { setSel(p); setTab("changes") } else say(`${p} · unchanged in this session`) }}
              className="border-0 text-xs"
            >
              <TreeNodes node={tree} changed={changed} />
            </FileTree>
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="terminal" className="flex min-h-0 flex-1 flex-col">
        <Terminal output={a.termOut || "\u001b[90mNo commands yet in this session.\u001b[0m"} isStreaming={a.termRunning} className="min-h-0 flex-1 rounded-none border-0">
          <TerminalHeader className="py-1.5">
            <TerminalTitle className="text-xs"><span className="font-mono">{cwd}</span>{!work?.branch && <span className="rounded bg-zinc-800 px-1 text-[10px]">read-only</span>}</TerminalTitle>
            <div className="flex items-center gap-1">
              <TerminalStatus><Shimmer as="span" duration={1}>running</Shimmer></TerminalStatus>
              <TerminalActions><TerminalCopyButton /></TerminalActions>
            </div>
          </TerminalHeader>
          <TerminalContent className="max-h-none min-h-0 flex-1 text-xs" />
        </Terminal>
      </TabsContent>

      <TabsContent value="preview" className="flex min-h-0 flex-1 flex-col">
        <WebPreview defaultUrl="http://localhost:5173" className="rounded-none border-0">
          <WebPreviewNavigation className="p-1.5">
            <WebPreviewNavigationButton tooltip="Reload" onClick={() => say("Reload (prototype)")}><RefreshCcwIcon className="size-4" /></WebPreviewNavigationButton>
            <WebPreviewUrl />
          </WebPreviewNavigation>
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground text-xs">
            <GlobeIcon className="size-5" />
            <p>No dev server running in <span className="font-mono">{cwd}</span>.</p>
            <Button size="sm" variant="outline" onClick={() => onSend("Start the dev server in the background and give me the URL")}>Ask {lead?.name ?? "employee"} to run pnpm dev</Button>
          </div>
        </WebPreview>
      </TabsContent>

      {thread.pr && (
        <TabsContent value="pr" className="min-h-0 flex-1">
          <PrPanel pr={thread.pr} diffs={a.diffs} commits={a.commits} lead={lead} session={thread.session} onComment={onPrComment} onMerge={onPrMerge} say={say} />
        </TabsContent>
      )}
    </Tabs>
  )
}

/* PR view modelled on Devin's PR tab: status pill + actions, repo/title/meta, merge box, sub-tabs. */
type PrTab = "changes" | "description" | "discussion" | "commits" | "checks"
const CHECK_ICON: Record<CheckRun["status"], React.ReactNode> = {
  pending: <CircleDashedIcon className="size-4 animate-spin text-amber-500 [animation-duration:3s]" />,
  passed: <CircleCheckIcon className="size-4 text-emerald-600" />,
  failed: <CircleXIcon className="size-4 text-red-600" />,
  skipped: <CircleMinusIcon className="size-4 text-muted-foreground" />,
}
function PrPanel({ pr, diffs, commits, lead, session, onComment, onMerge, say }: {
  pr: PullRequest; diffs: Diff[]; commits: GitCommit[]; lead?: Employee; session: string
  onComment: (t: string) => void; onMerge: () => void; say: (t: string) => void
}) {
  const [tab, setTab] = useState<PrTab>("description")
  const [draft, setDraft] = useState("")
  const [mergeOpen, setMergeOpen] = useState(false)
  const merged = pr.status === "merged"
  const n = (s: CheckRun["status"]) => pr.checks.filter((c) => c.status === s).length
  const pending = n("pending"), failed = n("failed")
  const add = diffs.reduce((x, d) => x + d.add, 0), del = diffs.reduce((x, d) => x + d.del, 0)
  const author = lead?.name ?? pr.author
  const url = `https://github.com/${pr.repo}/pull/${pr.number}`
  const tabs: { id: PrTab; label: string; count?: number }[] = [
    { id: "changes", label: "Changes", count: diffs.length }, { id: "description", label: "Description" },
    { id: "discussion", label: "Discussion", count: pr.comments.length }, { id: "commits", label: "Commits", count: commits.length },
    { id: "checks", label: "Checks", count: pr.checks.length },
  ]
  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-4 text-[14px]" data-pr={pr.number}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 font-medium text-[13px]", merged ? "bg-violet-500/12 text-violet-700" : "bg-emerald-500/12 text-emerald-700")}>
            {merged ? <GitMergeIcon className="size-3.5" /> : <GitPullRequestIcon className="size-3.5" />}{merged ? "Merged" : "Open"}
          </span>
          <div className="ml-auto flex items-center gap-1 text-[13px] text-muted-foreground">
            <Button variant="ghost" size="icon-sm" title="Copy PR link" onClick={() => { navigator.clipboard?.writeText(url); say("PR link copied") }}><CopyIcon /></Button>
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => say(`open ${url}`)}>GitHub<ArrowUpRightIcon /></Button>
            <Button variant="outline" size="sm" onClick={() => setTab("discussion")}><MessageSquareTextIcon />Comment</Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-[13px] text-muted-foreground">{pr.repo} · #{pr.number}</div>
          <h2 className="font-semibold text-[18px] leading-snug tracking-[-0.01em]">{pr.title}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-muted-foreground">
          <span className="flex items-center gap-1.5 text-foreground/80"><HermesAvatar className="size-4" />{author}</span>
          <span className="flex items-center gap-1.5">
            <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[12px]">{pr.base}</span>←<span className="max-w-48 truncate rounded-full bg-muted px-2 py-0.5 font-mono text-[12px]">{pr.head}</span>
          </span>
          <span>{pr.merged ? <>Merged by {pr.merged.by} at {pr.merged.at} · squash <code className="font-mono">{pr.merged.sha}</code></> : <>Opened {pr.opened} · {plural(diffs.length, "file")}</>}</span>
          <DiffStat add={add} del={del} />
        </div>

        {/* Merge box */}
        <div className="overflow-hidden rounded-xl border">
          <button type="button" className="flex h-11 w-full items-center gap-2.5 px-3.5 text-left font-medium hover:bg-muted/40" onClick={() => setMergeOpen(!mergeOpen)}>
            {merged ? <GitMergeIcon className="size-4 text-violet-600" /> : failed ? <CircleXIcon className="size-4 text-red-600" /> : pending ? <CircleDashedIcon className="size-4 animate-spin text-amber-500 [animation-duration:3s]" /> : <CircleCheckIcon className="size-4 text-emerald-600" />}
            <span>{merged ? `Merged into ${pr.base}` : failed ? `${failed} check${failed > 1 ? "s" : ""} failing` : pending ? `Checks running · ${pr.checks.length - pending}/${pr.checks.length} done` : "Ready to merge"}</span>
            {merged && pr.merged && <span className="font-normal text-[13px] text-muted-foreground">· {pr.merged.by} · {pr.merged.at} · branch {pr.head} deleted</span>}
            {!merged && !pending && !failed && <span className="font-normal text-[13px] text-muted-foreground">· {pr.checks.filter((c) => c.status === "passed").length} passed · review requested from Reviewer</span>}
            <ChevronDownIcon className={cn("ml-auto size-4 text-muted-foreground transition-transform", mergeOpen && "rotate-180")} />
          </button>
          {mergeOpen && (
            <div className="space-y-2 border-t px-3.5 py-3 text-[13px]">
              <div className="flex items-center gap-2"><CircleCheckIcon className="size-4 text-emerald-600" />No conflicts with <span className="font-mono">{pr.base}</span></div>
              <div className="flex items-center gap-2">{pending ? CHECK_ICON.pending : failed ? CHECK_ICON.failed : CHECK_ICON.passed}{pr.checks.length - pending - failed} of {pr.checks.length} checks finished{failed ? `, ${failed} failing` : ""}</div>
            </div>
          )}
          {!merged && (
            <div className="flex items-center gap-2 border-t bg-muted/30 px-3.5 py-2.5">
              <Button size="sm" disabled={pending > 0 || failed > 0} onClick={onMerge}><GitMergeIcon />Squash and merge</Button>
              <span className="text-muted-foreground text-xs">{pending ? "Waiting for checks" : failed ? `${author} is fixing CI in ${session}` : "You have write access on this repo."}</span>
            </div>
          )}
        </div>

        {/* Sub-tabs */}
        <div className="no-scrollbar flex items-center gap-4 overflow-x-auto border-b">
          {tabs.map((t) => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} data-prtab={t.id}
              className={cn("-mb-px shrink-0 border-b-2 py-2 text-[13px] transition-colors", tab === t.id ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
              {t.label}{t.count !== undefined && <span className="ml-1.5 text-muted-foreground tabular-nums">{t.count}</span>}
            </button>
          ))}
        </div>

        {tab === "description" && (
          <MessageResponse className="lilos-prose">{pr.body}</MessageResponse>
        )}
        {tab === "changes" && <div className="space-y-3">{diffs.map((d) => <DiffView key={d.path} d={d} />)}</div>}
        {tab === "commits" && (
          <div className="space-y-2">
            {commits.map((c, i) => (
              <div key={c.hash} className="flex items-center gap-3 rounded-lg border px-3.5 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{c.message}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    {i === 0 && <span className="text-emerald-600">Current</span>}{i === 0 && "·"}{author}·<code className="rounded bg-muted px-1 font-mono">{c.hash}</code>·{plural(c.files.length, "file")}
                  </div>
                </div>
                <Button variant="ghost" size="icon-sm" title="Copy hash" onClick={() => navigator.clipboard?.writeText(c.hash)}><CopyIcon /></Button>
              </div>
            ))}
          </div>
        )}
        {tab === "checks" && (
          <div className="space-y-3">
            <div className="grid grid-cols-4 text-center">
              {(["pending", "failed", "passed", "skipped"] as const).map((s) => (
                <div key={s}><div className="text-[20px] tabular-nums">{n(s)}</div><div className="text-[12px] text-muted-foreground">{s === "passed" ? "successful" : s}</div></div>
              ))}
            </div>
            <div className="flex h-1 overflow-hidden rounded-full bg-muted">
              <div className="bg-emerald-500 transition-all" style={{ width: `${(n("passed") / pr.checks.length) * 100}%` }} />
              <div className="bg-red-500" style={{ width: `${(failed / pr.checks.length) * 100}%` }} />
              <div className="bg-zinc-300" style={{ width: `${(n("skipped") / pr.checks.length) * 100}%` }} />
            </div>
            <div className="divide-y rounded-lg border">
              {pr.checks.map((c) => (
                <div key={c.name} className="flex items-center gap-2.5 px-3.5 py-2" data-check={c.status}>{CHECK_ICON[c.status]}<span>{c.name}</span><span className="ml-auto text-[12px] text-muted-foreground">{c.status}</span></div>
              ))}
            </div>
          </div>
        )}
        {tab === "discussion" && (
          <div className="space-y-4">
            {pr.comments.map((c, i) => (
              <div key={i} className="flex gap-3">
                {c.from === "oscar" ? <HumanAvatar id="oscar" /> : <HermesAvatar className="size-8" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2"><span className="font-medium">{c.from === "oscar" ? "Oscar" : author}</span><span className="text-[12px] text-muted-foreground">{c.time}</span></div>
                  <p className="mt-1 leading-6 text-foreground/90">{c.text}</p>
                  {c.monitor && (
                    <label className="mt-2 flex items-center gap-2 text-[13px] text-muted-foreground">
                      <input type="checkbox" className="size-3.5 accent-foreground" onChange={(e) => say(e.target.checked ? "PR monitoring off for this session" : "PR monitoring on")} />Disable automatic comment, CI and merge-conflict monitoring
                    </label>
                  )}
                </div>
              </div>
            ))}
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { onComment(draft.trim()); setDraft("") } }}>
              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a comment… (Builder picks it up in this session)" className="min-h-20 text-[14px]" />
              <div className="flex justify-end"><Button size="sm" type="submit" disabled={!draft.trim()}>Comment</Button></div>
            </form>
          </div>
        )}
      </div>
    </ScrollArea>
  )
}

function FocusView({ root, thread, channel, project, lead, emp, resolved, setResolved, work, onBack, onNav, onStart, running, onSend, onStop, onRetry, onUnqueue, onRewind, onModel, say, onPrComment, onPrMerge, steerCap, onSteerCap, pending }: {
  root: Extract<Msg, { kind: "msg" }>; thread: Thread; channel: Channel; project?: Project; lead?: Employee; emp: EmpFn
  resolved: Record<string, string>; setResolved: (r: Record<string, string>) => void; work: Work | null
  onBack: () => void; onNav: () => void; onStart: () => void; running: boolean
  onSend: (t: string) => void; onStop: () => void; onRetry: (empId: string) => void
  onUnqueue: (i: number) => void; onRewind: (replyIndex: number) => void; onModel: (m: string) => void; say: (t: string) => void
  onPrComment: (t: string) => void; onPrMerge: () => void
  steerCap: boolean; onSteerCap: (v: boolean) => void; pending: string[]
}) {
  const [wbOpen, setWbOpen] = useState(() => window.innerWidth >= 1024)
  const [tab, setTab] = useState<WbTab>(() => (sessionArtifacts(thread).diffs.length ? "changes" : "terminal"))
  const [follow, setFollow] = useState(true)
  const isDM = !!channel.dm
  const model = thread.model ?? lead?.model ?? MODELS[0]
  const live = thread.replies.find((r) => r.live)
  const lastStep = live?.steps?.[live.steps.length - 1]
  const status: ChatStatus = running ? (live?.phase === "submitted" ? "submitted" : "streaming") : "ready"
  const todos = thread.todos ?? []
  const queue = thread.queue ?? []
  const liveKey = live ? `${live.id}:${live.steps?.length}:${lastStep?.running}` : ""
  // Follow the agent: while a turn runs, the workbench jumps to what it is doing (until you pick a tab yourself).
  useEffect(() => { if (live) setFollow(true) }, [live?.id])
  // Turn finished with edits → land on Changes, like Codex's review pane.
  const lastDone = [...thread.replies].reverse().find((r) => emp(r.from) && !r.live)
  useEffect(() => { if (follow && !live && lastDone?.steps?.some((s) => s.diff)) setTab("changes") }, [lastDone?.id, !!live]) // eslint-disable-line react-hooks/exhaustive-deps
  // A PR appearing on the session opens its tab (Devin opens a PR tab per PR).
  useEffect(() => { if (thread.pr) { setTab("pr"); setWbOpen(true) } }, [thread.pr?.number]) // eslint-disable-line react-hooks/exhaustive-deps
  const pr = thread.pr
  const prPending = pr?.checks.some((c) => c.status === "pending")
  useEffect(() => {
    if (!follow || !lastStep) return
    if (lastStep.diff) setTab("changes")
    else if (lastStep.tool === "terminal") setTab("terminal")
  }, [liveKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const pickTab = (t: WbTab) => { setTab(t); setFollow(false); setWbOpen(true) }
  const doneTodos = todos.filter((t) => t.status === "completed").length
  // Plan tray opens while the agent works and folds away when the turn ends (user can still toggle).
  const [planOpen, setPlanOpen] = useState(running)
  useEffect(() => setPlanOpen(running), [running])
  const where = isDM ? "Direct" : project?.name ?? "Company"
  const chLabel = isDM ? channel.name : `#${channel.name}`

  return (
    <main className="flex min-h-0 min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-2 sm:px-3">
        <Button variant="ghost" size="icon-sm" onClick={onNav} title="Workspace"><MenuIcon /></Button>
        <Button variant="ghost" size="sm" className="shrink-0 px-2" onClick={onBack}><ArrowLeftIcon /><span className="hidden sm:inline">{chLabel}</span></Button>
        <span className="h-5 w-px shrink-0 bg-border" />
        {lead && <HermesAvatar status={lead.status} className="size-7" />}
        <div className="min-w-0">
          <div className="truncate font-semibold" title={plain(root.text)}>{plain(root.text)}</div>
          <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
            <span className="truncate">{where} / {chLabel}</span>
            <span>·</span><span className="shrink-0">{lead?.name}</span>
            <code className="hidden shrink-0 rounded bg-muted px-1 sm:inline">{thread.session}</code>
            {thread.ws && <span className="hidden shrink-0 items-center gap-1 md:flex" title={thread.ws.cwd}><FolderIcon className="size-3" />{thread.ws.project}</span>}
            {work?.branch
              ? <span className="hidden shrink-0 items-center gap-1 rounded bg-emerald-50 px-1 text-emerald-800 md:flex"><GitBranchIcon className="size-3" /><span className="font-mono">{work.branch}</span></span>
              : <span className="hidden shrink-0 items-center gap-1 rounded bg-muted px-1 md:flex"><EyeIcon className="size-3" />read-only</span>}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {running && <span className="hidden items-center gap-1 text-muted-foreground text-xs sm:flex"><CircleDotIcon className="size-3 animate-pulse text-amber-500" />{live?.phase ? PHASE_LABEL[live.phase] : "working"}</span>}
          {thread.usage && <SessionUsage usage={thread.usage} model={model} />}
          {!work && !isDM && <Button size="sm" onClick={onStart}><PlayIcon /><span className="hidden sm:inline">Start work</span></Button>}
          {pr ? (
            <Button variant="outline" size="sm" onClick={() => pickTab("pr")} data-prchip>
              {pr.status === "merged" ? <GitMergeIcon className="text-violet-600" /> : prPending ? <CircleDashedIcon className="animate-spin text-amber-500 [animation-duration:3s]" /> : <GitPullRequestIcon className="text-emerald-600" />}
              <span className="hidden sm:inline">#{pr.number} {pr.status === "merged" ? "merged" : prPending ? "checks" : "ready"}</span>
            </Button>
          ) : work?.branch && (
            <Button variant="outline" size="sm" disabled={running} onClick={() => onSend("Open a PR for this branch")}><GitPullRequestIcon /><span className="hidden sm:inline">Open PR</span></Button>
          )}
          <Button variant={wbOpen ? "secondary" : "ghost"} size="icon-sm" title="Workbench" onClick={() => setWbOpen(!wbOpen)}>{wbOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}</Button>
          <Button variant="ghost" size="icon-sm" title="Exit focus" onClick={onBack}><Minimize2Icon /></Button>
        </div>
      </header>

      <div className={cn("grid min-h-0 flex-1 grid-cols-1", wbOpen && "lg:grid-cols-[minmax(0,1fr)_minmax(400px,46%)]")}>
        <section className="flex min-h-0 min-w-0 flex-col">
          <Conversation className="min-h-0 [mask-image:linear-gradient(to_bottom,transparent,#000_28px)]">
            <ConversationContent className="mx-auto w-full max-w-[46rem] gap-7 px-5 py-8">
              <UserTurn from={root.from} time={root.time} text={root.text} note={`opened session ${thread.session}`} />
              {thread.replies.map((r, i) => emp(r.from) ? (
                <AgentTurn key={r.id ?? i} r={r} emp={emp} last={i === thread.replies.length - 1} onRetry={onRetry} onOpen={pickTab} pending={pending}
                  cards={<>
                    <ReplyCards r={r} work={work} repo={channel.repo} emp={emp} resolved={resolved} setResolved={setResolved} onStart={onStart} />
                    {pr && !r.live && r.steps?.some((s) => String(s.input.command ?? "").startsWith("gh pr create")) && <PrCard pr={pr} author={lead?.name ?? pr.author} onOpen={() => pickTab("pr")} />}
                  </>} />
              ) : (
                <Fragment key={r.id ?? i}>
                  {!running && (
                    <Checkpoint className="text-xs">
                      <CheckpointIcon className="size-3.5" />
                      <CheckpointTrigger size="xs" tooltip="session.undo + rollback.restore: drop this turn and everything after, files included" onClick={() => onRewind(i)}>
                        <Undo2Icon className="size-3" />Restore to here
                      </CheckpointTrigger>
                    </Checkpoint>
                  )}
                  <UserTurn from={r.from} time={r.time} text={r.text} />
                </Fragment>
              ))}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          <div className="mx-auto w-full max-w-[46rem] shrink-0 px-3 pb-3">
            {(todos.length > 0 || queue.length > 0) && (
              <Queue className="mb-2 gap-1 py-1.5 shadow-none">
                {todos.length > 0 && (
                  <QueueSection open={planOpen} onOpenChange={setPlanOpen}>
                    <QueueSectionTrigger className="py-1.5 text-xs">
                      <QueueSectionLabel label={`Plan · ${doneTodos}/${todos.length} done`} icon={<ListTodoIcon className="size-3.5" />} />
                      {todos.find((t) => t.status === "in_progress") && <span className="ml-2 min-w-0 truncate text-amber-700">{todos.find((t) => t.status === "in_progress")!.content}</span>}
                    </QueueSectionTrigger>
                    <QueueSectionContent>
                      <QueueList className="mt-1">
                        {todos.map((t) => {
                          const off = t.status === "completed" || t.status === "cancelled"
                          return (
                            <QueueItem key={t.content} className="py-0.5">
                              <div className="flex items-center gap-2">
                                {t.status === "in_progress" ? <CircleDotIcon className="size-2.5 shrink-0 animate-pulse text-amber-500" /> : off ? <CheckIcon className="size-2.5 shrink-0 text-emerald-600" /> : <QueueItemIndicator />}
                                <QueueItemContent className={cn("text-xs", off ? "text-muted-foreground line-through decoration-muted-foreground/40" : "text-foreground")}>{t.content}</QueueItemContent>
                              </div>
                            </QueueItem>
                          )
                        })}
                      </QueueList>
                    </QueueSectionContent>
                  </QueueSection>
                )}
                {queue.length > 0 && (
                  <QueueSection>
                    <QueueSectionTrigger className="bg-blue-50 py-1.5 text-blue-900 text-xs hover:bg-blue-100">
                      <QueueSectionLabel count={queue.length} label="queued · sent after this turn" icon={<ListTodoIcon className="size-3.5" />} />
                    </QueueSectionTrigger>
                    <QueueSectionContent>
                      <QueueList className="mt-1">
                        {queue.map((q, i) => (
                          <QueueItem key={i} className="py-0.5">
                            <div className="flex items-center gap-2">
                              <span className="shrink-0 font-mono text-[10px] text-blue-700">{i + 1}</span>
                              <QueueItemContent className="text-foreground text-xs">{plain(q)}</QueueItemContent>
                              <QueueItemActions>
                                <QueueItemAction title="Remove" onClick={() => onUnqueue(i)}><Trash2Icon className="size-3" /></QueueItemAction>
                              </QueueItemActions>
                            </div>
                          </QueueItem>
                        ))}
                      </QueueList>
                    </QueueSectionContent>
                  </QueueSection>
                )}
              </Queue>
            )}
            <FocusComposer
              running={running} status={status} model={model} onModel={onModel} onStop={onStop}
              steerCap={steerCap} onSteerCap={onSteerCap}
              placeholder={running ? (steerCap ? `${lead?.name ?? "Employee"} is working. Enter steers this turn…` : `${lead?.name ?? "Employee"} is working. Your message waits in the queue…`) : `Continue session ${thread.session} with ${lead?.name ?? "the employee"}…`}
              hint={running ? (steerCap ? "Enter steers · ■ stop" : "Enter queues · ■ stop") : pr?.status === "merged" ? `#${pr.number} merged, ⎇ ${pr.head} deleted · next edit starts a new branch from main` : work?.branch ? `Edits go to ⎇ ${work.branch}` : "Read-only on main"}
              onSend={(t) => onSend(t)}
            />
          </div>
        </section>

        {wbOpen && (
          <>
            <div className="fixed inset-0 z-20 bg-black/20 lg:hidden" onClick={() => setWbOpen(false)} />
            <aside className="flex min-h-0 flex-col border-l bg-background max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:w-[min(560px,100vw)] max-lg:shadow-2xl">
              <Workbench thread={thread} work={work} isDM={isDM} lead={lead} tab={tab} setTab={pickTab} onClose={() => setWbOpen(false)} onStart={onStart} onSend={(t) => onSend(t)} say={say} onPrComment={onPrComment} onPrMerge={onPrMerge} />
            </aside>
          </>
        )}
      </div>
    </main>
  )
}

function PrCard({ pr, author, onOpen }: { pr: PullRequest; author: string; onOpen: () => void }) {
  const pending = pr.checks.filter((c) => c.status === "pending").length
  const merged = pr.status === "merged"
  return (
    <button type="button" onClick={onOpen} data-prcard className="flex w-full max-w-lg items-center gap-3 rounded-xl border bg-background px-3.5 py-3 text-left transition-colors hover:border-foreground/25">
      <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", merged ? "bg-violet-500/10 text-violet-600" : "bg-emerald-500/10 text-emerald-600")}>{merged ? <GitMergeIcon className="size-4" /> : <GitPullRequestIcon className="size-4" />}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-[14px]">{pr.title}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <span>{pr.repo} #{pr.number}</span>·<span>{author}</span>·
          {merged ? <span className="text-violet-600">merged</span> : pending ? <span className="flex items-center gap-1 text-amber-600"><CircleDashedIcon className="size-3 animate-spin [animation-duration:3s]" />checks {pr.checks.length - pending}/{pr.checks.length}</span> : <span className="flex items-center gap-1 text-emerald-600"><CircleCheckIcon className="size-3" />checks passed</span>}
        </span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

/* Transcript typography (Claude / Cursor / Devin): 15px body on 1.65 leading, dark text, one muted tier,
   prose max ~70ch. Tool steps stay compact but at full contrast. */
function UserTurn({ from, time, text, note }: { from: string; time: string; text: string; note?: string }) {
  return (
    <Message from="user" className="max-w-[80%] gap-1">
      <MessageContent className="rounded-2xl px-4 py-2.5 text-[15px] leading-[1.6]"><MessageResponse className="lilos-prose break-words">{text}</MessageResponse></MessageContent>
      <div className="ml-auto text-[12px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">{HUMANS[from]?.name ?? from} · {time}{note && <> · {note}</>}</div>
    </Message>
  )
}

function AgentTurn({ r, emp, last, onRetry, onOpen, cards, pending }: {
  r: Reply; emp: EmpFn; last: boolean; onRetry: (empId: string) => void; onOpen: (t: WbTab) => void; cards: React.ReactNode; pending: string[]
}) {
  const e = emp(r.from)
  const steps = r.steps ?? []
  const files = new Set(steps.filter((s) => s.diff).map((s) => s.diff!.path)).size
  return (
    <Message from="assistant" className="max-w-full gap-2.5">
      <div className="flex items-center gap-2 text-[13px]"><HermesAvatar className="size-5" /><span className="font-semibold">{e?.name}</span><span className="text-muted-foreground">{r.time}</span></div>
      {r.reasoning !== undefined && (
        <Reasoning className="mb-0 w-full" isStreaming={r.live && r.phase === "thinking"} duration={r.thought ?? 0} defaultOpen={!!r.live}>
          <ReasoningTrigger className="w-fit text-[13px]" getThinkingMessage={(s, d) => (s ? <Shimmer duration={1}>Thinking…</Shimmer> : <span>Thought for {d || 1}s</span>)} />
          <ReasoningContent className="mt-2 border-l-2 pl-3 text-[13px] leading-relaxed text-muted-foreground">{r.reasoning || "…"}</ReasoningContent>
        </Reasoning>
      )}
      {steps.length > 0 && <div className="flex flex-col">{steps.map((s, j) => <StepRow key={j} s={s} />)}</div>}
      {r.live && r.phase === "tools" && !steps.some((s) => s.running) && <Shimmer as="span" duration={1} className="pl-4 text-[13px]">Working…</Shimmer>}
      {r.live && r.phase === "submitted" && <Shimmer className="text-[15px]">Opening Hermes session…</Shimmer>}
      {r.streaming ? <Shimmer>{r.streaming}</Shimmer> : r.text ? <MessageContent className="w-full"><MessageResponse className="lilos-prose break-words">{r.text}</MessageResponse></MessageContent> : null}
      {r.steers?.map((s, k) => (
        <div key={k} className="flex w-fit max-w-full items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900 text-xs">
          <span className="shrink-0 font-medium">Oscar steered</span><span className="min-w-0">{s}</span>
        </div>
      ))}
      {r.live && pending.map((s, k) => (
        <div key={`p${k}`} data-steerpending className="flex w-fit max-w-full items-start gap-1.5 rounded-md border border-dashed border-amber-300 bg-amber-50/40 px-2 py-1 text-amber-900/70 text-xs">
          <span className="shrink-0 font-medium">Steer pending</span><span className="min-w-0">{plain(s)}</span>
        </div>
      ))}
      {r.phase === "stopped" && <div className="w-fit rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">Stopped · session.interrupt</div>}
      {cards}
      {!r.live && !r.streaming && (r.text || steps.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-muted-foreground">
          {r.dur !== undefined && <span>Worked for {r.dur}s</span>}
          {steps.length > 0 && <span>· {plural(steps.length, "step")}</span>}
          {files > 0 && <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={() => onOpen("changes")}>· {plural(files, "file")} changed</button>}
          <MessageActions className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">
            {r.text && <MessageAction tooltip="Copy" label="Copy" onClick={() => navigator.clipboard?.writeText(r.text)}><CopyIcon className="size-3.5" /></MessageAction>}
            {last && <MessageAction tooltip="Retry turn" label="Retry" onClick={() => onRetry(r.from)}><RefreshCcwIcon className="size-3.5" /></MessageAction>}
          </MessageActions>
        </div>
      )}
    </Message>
  )
}

function SessionUsage({ usage, model }: { usage: Usage; model: string }) {
  const used = usage.input + usage.output
  const max = model.startsWith("qwen") ? 262_000 : 200_000
  const u: LanguageModelUsage = {
    inputTokens: usage.input, outputTokens: usage.output, totalTokens: used,
    inputTokenDetails: { noCacheTokens: usage.input - usage.cache, cacheReadTokens: usage.cache, cacheWriteTokens: undefined },
    outputTokenDetails: { textTokens: usage.output - usage.reasoning, reasoningTokens: usage.reasoning },
  }
  const n = (x: number) => new Intl.NumberFormat("en-US", { notation: "compact" }).format(Math.round(x))
  return (
    <Context usedTokens={used} maxTokens={max} usage={u}>
      <ContextTrigger size="sm" className="h-7 px-1.5 text-xs" />
      <ContextContent>
        <ContextContentHeader />
        <ContextContentBody className="space-y-1 text-xs">
          <div className="flex justify-between"><span className="text-muted-foreground">Input</span><span>{n(usage.input)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Output</span><span>{n(usage.output)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Reasoning</span><span>{n(usage.reasoning)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Cache read</span><span>{n(usage.cache)}</span></div>
        </ContextContentBody>
        <ContextContentFooter><span className="text-muted-foreground">Model</span><span className="truncate">{model}</span></ContextContentFooter>
      </ContextContent>
    </Context>
  )
}

/* Employee screen (DM). Left: the conversation list — each top-level message is ONE Hermes session.
   Right panel: the open session as a thread. Composer at the bottom always starts a NEW session. */
function EmployeeHome({ e, feed, threadId, emp, onNav, onProfile, onOpen, onSend, panelOpen, onPanel, folders, pick, setPick, onAddFolder }: {
  e: Employee; feed: Msg[]; threadId: string | null; emp: EmpFn
  onNav: () => void; onProfile: () => void; onOpen: (id: string) => void; onSend: (t: string, pick?: WsPick) => void
  panelOpen: boolean; onPanel: () => void; folders: Folder[]; say: (t: string) => void
  pick: WsPick; setPick: (p: WsPick) => void; onAddFolder: () => void
}) {
  const pickFolder = folders.find((x) => x.id === pick.folder)
  const roots = feed.filter((m): m is Extract<Msg, { kind: "msg" }> => m.kind === "msg" && !!m.thread)
  return (
    <main className="flex min-h-0 min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:gap-3 sm:px-5">
        <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={onNav}><MenuIcon /></Button>
        <HermesAvatar status={e.status} className="size-8" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-semibold text-base"><span className="truncate">{e.name}</span><Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px]">EMPLOYEE</Badge></div>
          <div className="truncate text-muted-foreground text-xs">{e.role} · now: {e.now}</div>
        </div>
        <div className="ml-auto flex shrink-0 gap-1">
          <Button variant="outline" size="sm" onClick={onProfile}><UserIcon /><span className="hidden sm:inline">Profile</span></Button>
          {!panelOpen && <Button variant="ghost" size="icon-sm" onClick={onPanel}><PanelRightIcon /></Button>}
        </div>
      </header>
      <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-muted-foreground text-xs sm:px-5">
        <LockIcon className="size-3 shrink-0" /><span className="min-w-0 truncate">Private to you. Each message you send here opens its own Hermes session; {e.name} replies in its thread.</span>
      </div>
      <Conversation className="min-h-0">
        <ConversationContent className="min-h-full justify-end gap-0 p-0 py-3">
          {roots.length === 0 ? (
            <ConversationEmptyState
              icon={<HermesAvatar className="size-12" />}
              title={`Start a session with ${e.name}`}
              description="Your first message opens a new Hermes session. Replies stay in its thread."
            />
          ) : roots.map((m) => {
            const t = m.thread!
            const last = t.replies[t.replies.length - 1]
            const running = t.replies.some((r) => r.live)
            const firstAnswer = t.replies.find((r) => emp(r.from) && r.text)
            return (
              <Row key={m.id} from={m.from} emp={emp} active={m.id === threadId}>
                <Who id={m.from} time={m.time} emp={emp} />
                <Body text={m.text} />
                {firstAnswer && <p className="line-clamp-2 border-l-2 pl-2.5 text-[13px] leading-5 text-muted-foreground">{preview(firstAnswer.text)}</p>}
                <button onClick={() => onOpen(m.id)} className="mt-1 flex w-fit max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-background px-2 py-1.5 text-left text-xs hover:border-foreground/30 [&>*]:shrink-0 [&>*]:whitespace-nowrap">
                  <HermesAvatar className="size-5" />
                  <span className="font-medium text-blue-600">{t.replies.length} {t.replies.length === 1 ? "reply" : "replies"}</span>
                  <code className="rounded bg-muted px-1 text-muted-foreground">{t.session}</code>
                  {t.ws && <span className="flex items-center gap-1 text-muted-foreground"><FolderIcon className="size-3" />{t.ws.project}<GitBranchIcon className="size-3" /><span className="font-mono text-emerald-700">{t.ws.branch}</span></span>}
                  {running
                    ? <span className="flex items-center gap-1 text-muted-foreground"><CircleDotIcon className="size-3 animate-pulse text-amber-500" />{last?.phase ? PHASE_LABEL[last.phase] : "working"}</span>
                    : last && <span className="text-muted-foreground">last {last.time}</span>}
                  <ChevronRightIcon className="size-3.5 text-muted-foreground" />
                </button>
              </Row>
            )
          })}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="shrink-0 px-2 sm:px-3">
        <Suggestions className="items-center py-1">
          <span className="text-muted-foreground text-xs">New session:</span>
          {(SUGGESTIONS[e.id] ?? SUGGESTIONS.builder).map((s) => <Suggestion key={s} suggestion={s} onClick={(t) => onSend(t, pick)} className="h-7 text-xs" />)}
        </Suggestions>
      </div>
      <Composer
        placeholder={pickFolder ? `New session with ${e.name} in ${pickFolder.project}…` : `New session with ${e.name}…`} employees={[]}
        hint={wsHint(pickFolder, pick)} onSend={(t) => onSend(t, pick)}
        tools={<WorkspacePicker folders={folders} pick={pick} setPick={setPick} onAddFolder={onAddFolder} />}
      />
    </main>
  )
}

function WsBadge({ ws }: { ws: Workspace }) {
  const f = { project: ws.project }
  return (
    <div className="mt-1 flex w-fit max-w-full items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-800 text-xs" title={ws.cwd} data-wsbadge>
      <FolderIcon className="size-3 shrink-0" /><span className="shrink-0">{f?.project}</span>
      {ws.mode === "direct" ? <PencilLineIcon className="size-3 shrink-0" /> : <GitBranchIcon className="size-3 shrink-0" />}
      <span className="truncate font-mono">{ws.branch}</span>
      <span className="shrink-0 text-emerald-700/80">· {ws.mode === "direct" ? "direct" : "worktree"}</span>
    </div>
  )
}

function WorkspaceBadge({ work, repo }: { work: Work | null; repo?: string }) {
  if (work?.branch) return <div className="mt-1 flex w-fit max-w-full items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-800 text-xs"><GitBranchIcon className="size-3 shrink-0" /><span className="truncate font-mono">{work.branch}</span><span className="shrink-0">· can edit</span></div>
  if (work) return <div className="mt-1 w-fit rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">ticket · no repo</div>
  return <div className="mt-1 flex w-fit items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs"><EyeIcon className="size-3" />{repo ? <span className="font-mono">main · read-only</span> : "discussion"}</div>
}

function StartWorkDialog({ root, thread, channel, ticket, emp, granted, onClose, onStart }: {
  root: Extract<Msg, { kind: "msg" }>; thread: Thread; channel: Channel; ticket: string; emp: EmpFn; granted: boolean
  onClose: () => void; onStart: (w: Work, lead: string, grant: boolean) => void
}) {
  const proposed = thread.replies.find((r) => r.startProposal)?.startProposal?.title
  const [title, setTitle] = useState(proposed ?? root.text.replace(/\*\*@\w+\*\*/g, "").replace(/[*`]/g, "").trim().slice(0, 60))
  const [branch, setBranch] = useState(`${ticket.toLowerCase()}-${slugOf(proposed ?? title)}`)
  const [grant, setGrant] = useState(granted)
  const workers = [...new Set(thread.replies.map((r) => r.from).filter((f) => emp(f)))]
  const [lead, setLead] = useState(workers[0] ?? "")
  const dir = `.lilos/wt/${ticket.toLowerCase()}`
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-4 sm:p-6" onClick={onClose}>
      <div className="flex max-h-[90dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b px-5 py-3">
          <PlayIcon className="size-4" /><div className="font-semibold">Start work</div>
          <span className="text-muted-foreground text-xs">from a thread in #{channel.name}</span>
          <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={onClose}><XIcon /></Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-5">
            <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-3">
              <Field label="Ticket title"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
              <Field label="ID"><Input value={ticket} readOnly className="bg-muted/40 font-mono" /></Field>
            </div>
            {channel.repo ? (
              <div className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center gap-1.5 font-medium text-xs"><GitBranchIcon className="size-3.5" />Worktree on {channel.repo}</div>
                <Field label="Branch"><Input value={branch} onChange={(e) => setBranch(e.target.value)} className="font-mono" /></Field>
                <p className="text-muted-foreground text-xs">From <span className="font-mono">main</span> into <span className="font-mono">{dir}</span>. Removed when the PR merges; the branch stays.</p>
              </div>
            ) : (
              <p className="rounded-lg border border-dashed p-3 text-muted-foreground text-xs">#{channel.name} has no repo, so this only creates a ticket. No worktree.</p>
            )}
            {workers.length > 0 && (
              <Field label="Lead employee">
                <div className="flex flex-wrap gap-1.5">
                  {workers.map((w) => (
                    <button key={w} onClick={() => setLead(w)} className={cn("flex items-center gap-1.5 rounded-full border py-1 pr-3 pl-1 text-xs", lead === w ? "border-foreground bg-muted font-medium" : "hover:border-foreground/30")}>
                      <HermesAvatar className="size-5" />{emp(w)?.name}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-muted-foreground text-xs">Any employee in the channel can still join and edit. Turns run one at a time.</p>
              </Field>
            )}
            <div className="space-y-1.5 rounded-lg bg-muted/40 p-3 text-xs">
              <div className="font-medium">Carries over</div>
              <div className="flex gap-1.5 text-muted-foreground"><CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />This thread ({thread.replies.length} replies). It becomes the ticket's thread.</div>
              <div className="flex gap-1.5 text-muted-foreground"><CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />Hermes session <span className="font-mono">{thread.session}</span>. It moves to the worktree; no new session, no summary.</div>
            </div>
            <label className="flex cursor-pointer items-start gap-2 text-xs">
              <input type="checkbox" checked={grant} onChange={(e) => setGrant(e.target.checked)} className="mt-0.5" />
              <span><span className="font-medium">Let employees in #{channel.name} start work themselves.</span><span className="block text-muted-foreground">Off: they ask, you press Start. Change it later in channel settings.</span></span>
            </label>
          </div>
        </ScrollArea>
        <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
          <code className="w-full min-w-0 break-all text-muted-foreground text-xs sm:w-auto sm:flex-1">{channel.repo ? `git worktree add ${dir} -b ${branch} → session.workspace.move` : `ticket ${ticket}`}</code>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={!title.trim()} onClick={() => onStart({ ticket, title: title.trim(), branch: channel.repo ? branch : undefined, by: "Oscar" }, lead, grant)}><PlayIcon />Start {ticket}</Button>
        </div>
      </div>
    </div>
  )
}

/* One-line preview of a markdown reply: drop markers, join blocks with " · ". */
const preview = (md: string) => md.split(/\n+/).map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").replace(/[*`#_]/g, "").trim()).filter(Boolean).join(" · ")

function Body({ text }: { text: string }) {
  return (
    <MessageContent className="w-full">
      <MessageResponse className="lilos-prose compact break-words">{text}</MessageResponse>
    </MessageContent>
  )
}

/* Folder → branch → workstream, picked before the first message (Codex / Claude Code "where does this run").
   Hermes: projects.list/for_cwd for folders + branch; the engine runs `git worktree add` for a new workstream,
   then session.create { cwd }. The session keeps that cwd; switching later = session.cwd.set while idle. */
function WorkspacePicker({ folders, pick, setPick, onAddFolder }: { folders: Folder[]; pick: WsPick; setPick: (p: WsPick) => void; onAddFolder: () => void }) {
  const f = folders.find((x) => x.id === pick.folder)
  const chip = "h-7 max-w-64 gap-1.5 rounded-md px-2 text-xs font-normal text-foreground/80 hover:text-foreground data-[popup-open]:bg-muted [&>span]:min-w-0"
  const modeLabel = pick.mode === "new" ? "new workstream" : pick.mode === "direct" ? "direct" : "workstream"
  return (
    <div className="flex min-w-0 items-center gap-0.5" data-wspicker>
      <DropdownMenu>
        <DropdownMenuTrigger render={<PromptInputButton size="sm" className={chip} data-ws="folder" />}>
          <FolderIcon className="size-3.5" /><span className={cn("shrink-0", !f && "text-muted-foreground")}>{f ? folderLabel(f, folders) : "No folder"}</span><ChevronDownIcon className="size-3 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-72" side="top">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Run this session in</DropdownMenuLabel>
            {folders.map((x) => (
              <DropdownMenuItem key={x.id} onClick={() => setPick({ folder: x.id, base: x.branches[0] ?? "", mode: x.branches.length ? "new" : "direct" })} className="items-start">
                <FolderIcon className="mt-0.5" />
                <span className="min-w-0 flex-1"><span className="block font-medium">{folderLabel(x, folders)}</span><span className="block truncate font-mono text-[11px] text-muted-foreground">{x.path}</span></span>
                {pick.folder === x.id && <CheckIcon className="mt-0.5" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setPick(NO_WS)}><MessageSquareIcon />No folder · just chat{!pick.folder && <CheckIcon className="ml-auto" />}</DropdownMenuItem>
          <DropdownMenuItem onClick={onAddFolder}><FolderPlusIcon />Add a folder…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {f && !f.branches.length && (
        <span className="flex h-7 items-center gap-1.5 px-2 text-muted-foreground text-xs" data-ws="nogit" title="Not a git repo: no branches or worktrees, edits land in the folder">
          <PencilLineIcon className="size-3.5" />direct · no git
        </span>
      )}
      {f && f.branches.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<PromptInputButton size="sm" className={chip} data-ws="branch" />}>
            {pick.mode === "existing" ? <GitBranchIcon className="size-3.5" /> : pick.mode === "direct" ? <PencilLineIcon className="size-3.5" /> : <GitBranchPlusIcon className="size-3.5" />}
            <span className="shrink-0 font-mono">{pick.mode === "existing" ? pick.existing : pick.base}</span>
            <span className="hidden shrink-0 text-muted-foreground lg:inline">· {modeLabel}</span>
            <ChevronDownIcon className="size-3 opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-80" side="top">
            <DropdownMenuGroup>
              <DropdownMenuLabel>New workstream from</DropdownMenuLabel>
              {f.branches.map((b) => (
                <DropdownMenuItem key={`n-${b}`} onClick={() => setPick({ ...pick, mode: "new", base: b, existing: undefined })}>
                  <GitBranchPlusIcon /><span className="font-mono">{b}</span><span className="text-muted-foreground text-xs">new branch + worktree</span>
                  {pick.mode === "new" && pick.base === b && <CheckIcon className="ml-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            {f.workstreams.length > 0 && <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Continue a workstream</DropdownMenuLabel>
                {f.workstreams.map((w) => (
                  <DropdownMenuItem key={`w-${w.branch}`} onClick={() => setPick({ ...pick, mode: "existing", existing: w.branch, base: w.from })}>
                    <GitBranchIcon /><span className="min-w-0 flex-1"><span className="block truncate font-mono">{w.branch}</span><span className="block truncate font-mono text-[11px] text-muted-foreground">{w.path} · from {w.from}</span></span>
                    {pick.mode === "existing" && pick.existing === w.branch && <CheckIcon />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </>}
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>No worktree</DropdownMenuLabel>
              {f.branches.map((b) => (
                <DropdownMenuItem key={`d-${b}`} onClick={() => setPick({ ...pick, mode: "direct", base: b, existing: undefined })}>
                  <PencilLineIcon /><span>Edit <span className="font-mono">{b}</span> directly</span>
                  {pick.mode === "direct" && pick.base === b && <CheckIcon className="ml-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
const wsHint = (f: Folder | undefined, p: WsPick) =>
  !f ? "Chat only · no folder. Enter opens a new session"
    : !f.branches.length ? `Enter opens a session in ${f.path} · edits land there directly`
    : p.mode === "new" ? `Enter opens a session in a new worktree off ${p.base}`
    : p.mode === "existing" ? `Enter opens a session in ${f.workstreams.find((w) => w.branch === p.existing)?.path ?? "the worktree"}`
    : `Enter opens a session in ${f.path} · edits land on ${p.base} directly`

/* Add a local folder to a project. Browse or type a path (complete.path), see whether it is a repo and on which
   branch (projects.for_cwd), then attach it: projects.add_folder { id, path } or projects.create { name, folders }. */
function AddFolderDialog({ folders, projects, defaultProject, onClose, onAdd }: {
  folders: Folder[]; projects: string[]; defaultProject?: string
  onClose: () => void; onAdd: (path: string, project: { existing?: string; name: string }) => void
}) {
  const [path, setPath] = useState("~/Desktop/Oscar")
  const [target, setTarget] = useState<string>(defaultProject ?? "__new")
  const [newName, setNewName] = useState("")
  const clean = path.trim().replace(/\/+$/, "") || "~"
  const exact = FS[clean]
  // complete.path: list the typed dir, or the parent filtered by the partial last segment
  const listDir = exact ? clean : parentOf(clean)
  const prefix = exact ? "" : baseName(clean).toLowerCase()
  const entries = (FS[listDir]?.children ?? []).filter((c) => c.toLowerCase().startsWith(prefix)).map((c) => `${listDir}/${c}`)
  const attached = folders.find((f) => f.path === clean)
  const git = exact?.git
  const suggestedName = baseName(clean)
  const projName = target === "__new" ? (newName.trim() || suggestedName) : target
  const crumbs = clean.split("/").map((_, i, a) => a.slice(0, i + 1).join("/"))
  const canAdd = !!exact && clean !== "~" && !attached
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-4 sm:p-6" onClick={onClose}>
      <div className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl" onClick={(e) => e.stopPropagation()} data-addfolder>
        <div className="flex items-center gap-2 border-b px-5 py-3">
          <FolderPlusIcon className="size-4" /><div className="font-semibold">Add a folder</div>
          <span className="text-muted-foreground text-xs">sessions can run in it</span>
          <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={onClose}><XIcon /></Button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <div>
            <div className="mb-1.5 text-muted-foreground text-xs">Found on this Mac</div>
            <div className="flex flex-wrap gap-1.5">
              {DISCOVERED.filter((d) => !folders.some((f) => f.path === d)).map((d) => (
                <button key={d} type="button" onClick={() => setPath(d)} data-discovered={d}
                  className={cn("flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:border-foreground/30", clean === d && "border-foreground bg-muted ring-1 ring-foreground")}>
                  <FolderGit2Icon className="size-3.5 text-muted-foreground" /><span className="font-medium">{baseName(d)}</span><span className="font-mono text-muted-foreground">{FS[d]?.git?.branches[0]}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border">
            <div className="flex items-center gap-1 border-b bg-muted/30 px-2 py-1.5">
              <Button variant="ghost" size="icon-xs" title="Up" disabled={clean === "~"} onClick={() => setPath(parentOf(exact ? clean : listDir))}><ArrowLeftIcon /></Button>
              <Input value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} data-pathinput
                onKeyDown={(e) => { if ((e.key === "Tab" || e.key === "Enter") && !exact && entries[0]) { e.preventDefault(); setPath(entries[0]) } }}
                placeholder="Type a path… Tab completes" className="h-7 border-0 bg-transparent px-1 font-mono text-xs shadow-none focus-visible:ring-0" />
            </div>
            <div className="flex flex-wrap items-center gap-0.5 border-b px-3 py-1 font-mono text-[11px] text-muted-foreground">
              {crumbs.map((c, i) => <Fragment key={c}>{i > 0 && <span>/</span>}<button type="button" className="rounded px-0.5 hover:bg-muted hover:text-foreground" onClick={() => setPath(c)}>{baseName(c)}</button></Fragment>)}
            </div>
            <div className="max-h-56 overflow-y-auto p-1" data-fslist>
              {entries.length === 0 && <p className="px-2 py-3 text-center text-muted-foreground text-xs">{FS[listDir] ? "No subfolders" : "No such folder"}</p>}
              {entries.map((e) => {
                const d = FS[e]
                const on = folders.find((f) => f.path === e)
                return (
                  <button key={e} type="button" onClick={() => setPath(e)} data-fsrow={baseName(e)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted">
                    {d?.git ? <FolderGit2Icon className="size-4 shrink-0 text-emerald-600" /> : <FolderIcon className="size-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate">{baseName(e)}</span>
                    {d?.git && <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground"><GitBranchIcon className="size-3" />{d.git.branches[0]}</span>}
                    {on && <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">{on.project}</Badge>}
                    {(d?.children?.length ?? 0) > 0 && <ChevronRightIcon className="size-3.5 text-muted-foreground" />}
                  </button>
                )
              })}
            </div>
          </div>

          {exact && clean !== "~" && (
            <div className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] leading-5", attached ? "border-amber-300 bg-amber-50 text-amber-900" : "bg-muted/40")} data-folderinfo>
              {git ? <FolderGit2Icon className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <FolderIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
              <div className="min-w-0">
                <div className="truncate font-medium">{baseName(clean)}</div>
                {attached ? <div>Already in {attached.project}.</div>
                  : git ? <div>Git repo{git.remote ? <> · <span className="font-mono">{git.remote}</span></> : null} · {plural(git.branches.length, "branch").replace("branchs", "branches")}: <span className="font-mono">{git.branches.join(", ")}</span>. Sessions can open a workstream (worktree) or edit a branch directly.</div>
                  : <div>Not a git repo. Sessions edit files here directly; no branches, worktrees or PRs.</div>}
              </div>
            </div>
          )}

          <div>
            <div className="mb-1.5 text-muted-foreground text-xs">Project</div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {projects.map((p) => (
                <button key={p} type="button" onClick={() => setTarget(p)} data-project={p}
                  className={cn("flex items-center gap-2 rounded-lg border px-3 py-2 text-left", target === p ? "border-foreground bg-muted/50" : "hover:border-foreground/30")}>
                  <FolderGit2Icon className="size-4 text-muted-foreground" /><span className="font-medium">{p}</span>
                  <span className="ml-auto text-muted-foreground text-xs">{plural(folders.filter((f) => f.project === p).length, "folder")}</span>
                  {target === p && <CheckIcon className="size-4" />}
                </button>
              ))}
              <div className={cn("flex items-center gap-2 rounded-lg border px-3 py-1 sm:col-span-2", target === "__new" ? "border-foreground bg-muted/50 [&_input]:bg-transparent dark:[&_input]:bg-transparent" : "hover:border-foreground/30")} onClick={() => setTarget("__new")} data-project="__new">
                <FolderPlusIcon className="size-4 shrink-0 text-muted-foreground" />
                <Input value={newName} onChange={(e) => setNewName(e.target.value)} onFocus={() => setTarget("__new")} placeholder={`New project · ${suggestedName}`}
                  className="h-7 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" />
              </div>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
          <span className="min-w-0 flex-1 basis-60 truncate font-mono text-[11px] text-muted-foreground" title="Hermes call">
            {target === "__new" ? `projects.create { name: "${projName}", folders: ["${clean}"] }` : `projects.add_folder { id: "${slugOf(projName)}", path: "${clean}" }`}
          </span>
          <Button variant="outline" size="sm" className="ml-auto" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={!canAdd} onClick={() => onAdd(clean, target === "__new" ? { name: projName } : { existing: target, name: target })} data-addbtn>
            {target === "__new" ? `Create ${projName}` : `Add to ${projName}`}
          </Button>
        </div>
      </div>
    </div>
  )
}

/* Queued follow-ups shown above a composer: sent in order when the running turn ends. */
function QueuedTray({ queue, onRemove }: { queue: string[]; onRemove: (i: number) => void }) {
  if (!queue.length) return null
  return (
    <div className="mb-1.5 rounded-lg border border-blue-200 bg-blue-50/60 px-2.5 py-1.5 text-xs" data-queued>
      <div className="mb-0.5 flex items-center gap-1.5 font-medium text-blue-900"><ListTodoIcon className="size-3.5" />{queue.length} queued · sent after this turn</div>
      {queue.map((q, i) => (
        <div key={i} className="group/q flex items-center gap-2 py-0.5">
          <span className="font-mono text-[10px] text-blue-700">{i + 1}</span><span className="min-w-0 flex-1 truncate">{plain(q)}</span>
          <button type="button" title="Remove" onClick={() => onRemove(i)} className="text-muted-foreground opacity-0 hover:text-foreground group-hover/q:opacity-100"><Trash2Icon className="size-3" /></button>
        </div>
      ))}
    </div>
  )
}

function Composer({ placeholder, employees, hint, onSend, status = "ready", onStop, tools, queued }: {
  placeholder: string; employees: Employee[]; hint: string
  onSend?: (text: string) => void; status?: ChatStatus; onStop?: () => void
  tools?: React.ReactNode; queued?: React.ReactNode
}) {
  const [draft, setDraft] = useState("")
  const mentionOpen = employees.length > 0 && /@\w*$/.test(draft)
  const busy = status === "submitted" || status === "streaming"
  return (
    <div className="relative m-2 mt-1 shrink-0 sm:m-3 sm:mt-2">
      {queued}
      {mentionOpen && (
        <div className="absolute bottom-full left-2 z-10 mb-2 w-80 max-w-[calc(100%-1rem)] rounded-lg border bg-popover p-1 shadow-lg">
          {employees.map((e) => (
            <button key={e.id} type="button" onClick={() => setDraft(draft.replace(/@\w*$/, `@${e.name} `))} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted">
              <HermesAvatar status={e.status} className="size-5" /><span className="font-medium">{e.name}</span>
              <span className="ml-auto text-muted-foreground text-xs">{e.role} · new session</span>
            </button>
          ))}
        </div>
      )}
      <PromptInput onSubmit={({ text }) => { const t = text.trim() || draft.trim(); if (t) onSend?.(t); setDraft("") }}>
        <PromptInputBody>
          <PromptInputTextarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder} className="min-h-12" />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools className="min-w-0">
            <PromptInputButton><PaperclipIcon /></PromptInputButton>
            {tools}
            <span className="hidden truncate text-muted-foreground text-xs sm:inline">{hint}</span>
          </PromptInputTools>
          {busy && !draft.trim()
            ? <PromptInputSubmit status={status} type="button" onClick={onStop} aria-label="Stop"><SquareIcon className="size-3.5 fill-current" /></PromptInputSubmit>
            : <PromptInputSubmit disabled={!draft.trim()} status={busy ? undefined : status} />}
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}

function EmployeeCard({ e, onDM }: { e: Employee; onDM: () => void }) {
  return (
    <div className="space-y-3 p-3">
      <div className="rounded-xl border bg-background p-4">
        <div className="flex items-center gap-3">
          <HermesAvatar status={e.status} className="size-12" />
          <div><div className="font-semibold text-base">{e.name}</div><div className="text-muted-foreground text-xs">{e.role} · owned by Oscar</div></div>
          <Button size="sm" variant="outline" className="ml-auto" onClick={onDM}><MessageSquareIcon />Message</Button>
        </div>
        <dl className="mt-4 grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-muted-foreground">Engine</dt><dd>Hermes</dd>
          <dt className="text-muted-foreground">Profile</dt><dd className="font-mono text-xs">{e.profile}</dd>
          <dt className="text-muted-foreground">Model</dt><dd>{e.model}</dd>
          <dt className="text-muted-foreground">Responds to</dt><dd>{RESPOND[e.respondTo]}</dd>
          <dt className="text-muted-foreground">Now</dt><dd>{e.now}</dd>
        </dl>
      </div>
      <div className="rounded-xl border bg-background p-4">
        <div className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">Instructions (SOUL.md)</div>
        <p>{e.instructions}</p>
      </div>
      <p className="text-muted-foreground text-xs">Persona, memory and skills live in the Hermes profile. LilOS stores only the company record: role, channels, who may direct it.</p>
    </div>
  )
}

function HireDialog({ initial, onClose, onHire, usedProfiles }: { initial: HireDraft; onClose: () => void; onHire: (d: HireDraft, r: RespondTo, chs: string[]) => void; usedProfiles: string[] }) {
  const [d, setD] = useState<HireDraft>(initial)
  const [mode, setMode] = useState<"existing" | "new">(initial.instructions && !TEMPLATES.some((t) => t.name === initial.name) ? "new" : "existing")
  const [picked, setPicked] = useState<HermesProfile | null>(null)
  const pick = (p: HermesProfile) => { setPicked(p); setD({ name: p.id[0].toUpperCase() + p.id.slice(1), role: d.role, model: p.model, instructions: p.soul }) }
  const [respondTo, setRespondTo] = useState<RespondTo>("me")
  const [chs, setChs] = useState<string[]>(["engineering"])
  const drafted = !TEMPLATES.some((t) => t.name === initial.name)
  const slug = d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "employee"
  const allChannels = PROJECTS.flatMap((p) => p.channels.map((c) => ({ id: c.id, label: `${p.name} / #${c.name}` })))
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-6" onClick={onClose}>
      <div className="grid max-h-[90dvh] w-full max-w-3xl grid-cols-1 overflow-hidden rounded-2xl border bg-background shadow-2xl md:grid-cols-[220px_minmax(0,1fr)]" onClick={(e) => e.stopPropagation()}>
        <div className="hidden space-y-1 border-r bg-muted/30 p-3 md:block">
          <div className="px-2 pb-2 font-semibold">Hire an employee</div>
          <div className="mb-3 grid grid-cols-2 rounded-lg bg-muted p-0.5 text-xs">
            {(["existing", "new"] as const).map((m) => (
              <button key={m} onClick={() => { setMode(m); setPicked(null) }} className={cn("rounded-md px-2 py-1", mode === m ? "bg-background font-medium shadow-sm" : "text-muted-foreground")}>{m === "existing" ? "Use profile" : "New profile"}</button>
            ))}
          </div>
          {mode === "existing" ? (
            <>
              <div className="px-2 pb-1 text-muted-foreground text-xs uppercase tracking-wide">Hermes profiles</div>
              {HERMES_PROFILES.map((p) => {
                const used = usedProfiles.includes(p.id)
                return (
                  <button key={p.id} disabled={used} onClick={() => pick(p)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50", picked?.id === p.id && "bg-muted font-medium")}>
                    <HermesAvatar className="size-5" /><span className="font-mono text-xs">{p.id}</span>
                    <span className="ml-auto text-muted-foreground text-[11px]">{used ? "hired" : `${p.skills} skills`}</span>
                  </button>
                )
              })}
            </>
          ) : (<>
          <div className="px-2 pb-1 text-muted-foreground text-xs uppercase tracking-wide">Start from</div>
          {TEMPLATES.map((t) => (
            <button key={t.name} onClick={() => setD(t)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted", d.role === t.role && "bg-muted font-medium")}>
              <HermesAvatar className="size-5" />{t.name}<span className="ml-auto text-muted-foreground text-xs">{t.role}</span>
            </button>
          ))}
          <button onClick={() => setD({ name: "", role: "", model: MODELS[0], instructions: "" })} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"><PlusIcon className="size-4" />Blank</button>
          </>)}
          <div className="mt-3 rounded-lg border border-dashed p-2 text-muted-foreground text-xs">
            <SparklesIcon className="mb-1 size-3.5" />Or ask an employee in chat: <i>"draft an employee that triages flaky tests"</i>. It posts a hire card for your approval.
          </div>
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="flex items-center gap-3 border-b p-4">
            <HermesAvatar className="size-10" />
            <div className="flex-1">
              <div className="font-semibold">{d.name || "New employee"}</div>
              <div className="text-muted-foreground text-xs">{mode === "existing" ? (picked ? <>Uses profile <code>{picked.id}</code> as-is</> : "Pick a Hermes profile on the left") : drafted ? "Drafted by Builder · review before hiring" : "Creates a new Hermes profile"}</div>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={onClose}><XIcon /></Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-4 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name (the @handle)"><Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Tester" /></Field>
                <Field label="Role"><Input value={d.role} onChange={(e) => setD({ ...d, role: e.target.value })} placeholder="QA automation" /></Field>
              </div>
              {mode === "existing" ? (
                <Field label="From the profile (edit in Hermes)">
                  {picked ? (
                    <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border bg-muted/30 p-3 text-xs">
                      <dt className="text-muted-foreground">Profile</dt><dd className="font-mono">{picked.id}</dd>
                      <dt className="text-muted-foreground">Model</dt><dd>{picked.model}</dd>
                      <dt className="text-muted-foreground">Skills</dt><dd>{picked.skills}</dd>
                      <dt className="text-muted-foreground">SOUL.md</dt><dd className="line-clamp-2">{picked.soul}</dd>
                    </dl>
                  ) : <p className="rounded-lg border border-dashed p-3 text-muted-foreground text-xs">No profile picked. Memory, skills and model stay in the profile; LilOS only adds the company record.</p>}
                </Field>
              ) : (<>
              <Field label="Instructions (becomes the profile's SOUL.md)">
                <Textarea value={d.instructions} onChange={(e) => setD({ ...d, instructions: e.target.value })} className="min-h-24" />
              </Field>
              <Field label="Model">
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {MODELS.map((m) => <button key={m} onClick={() => setD({ ...d, model: m })} className={cn("rounded-md border px-2.5 py-1.5 text-left text-xs", d.model === m ? "border-foreground bg-muted font-medium" : "hover:bg-muted/50")}>{m}</button>)}
                </div>
              </Field>
              </>)}
              <Field label="Who can direct this employee">
                <div className="flex flex-wrap gap-1.5">
                  {(Object.keys(RESPOND) as RespondTo[]).map((r) => <button key={r} onClick={() => setRespondTo(r)} className={cn("rounded-md border px-2.5 py-1.5 text-xs", respondTo === r ? "border-foreground bg-muted font-medium" : "hover:bg-muted/50")}>{RESPOND[r]}</button>)}
                </div>
                <p className="mt-1 text-muted-foreground text-xs">Everyone can read its replies. Other people's @mentions become requests you approve.</p>
              </Field>
              <Field label="Join channels">
                <div className="flex flex-wrap gap-1.5">
                  {allChannels.map((c) => {
                    const on = chs.includes(c.id)
                    return <button key={c.id} onClick={() => setChs(on ? chs.filter((x) => x !== c.id) : [...chs, c.id])} className={cn("rounded-full border px-2.5 py-1 text-xs", on ? "border-blue-500 bg-blue-50 text-blue-700" : "hover:bg-muted/50")}>{on && "✓ "}{c.label}</button>
                  })}
                </div>
              </Field>
            </div>
          </ScrollArea>
          <div className="flex items-center gap-2 border-t bg-muted/30 p-3">
            <code className="hidden min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs sm:block">{mode === "existing" ? `link profile ${picked?.id ?? "…"} → employee @${slug}` : `hermes profile create ${slug} → SOUL.md → model`}</code>
            <Button variant="ghost" className="ml-auto" onClick={onClose}>Cancel</Button>
            <Button disabled={!d.name || (mode === "existing" && !picked)} onClick={() => onHire(d, respondTo, chs)}><UserPlusIcon />Hire {d.name}</Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="mb-1.5 font-medium text-xs">{label}</div>{children}</div>
}

function Section({ title, onAdd }: { title: string; onAdd?: () => void }) {
  return (
    <div className="flex items-center px-4 pt-4 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
      {title}
      {onAdd && <button onClick={onAdd} className="ml-auto hover:text-foreground"><PlusIcon className="size-3.5" /></button>}
    </div>
  )
}

function NavItem({ icon, label, count, tone, onClick }: { icon: React.ReactNode; label: string; count?: number; tone?: "amber"; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent [&_svg]:size-4 [&_svg]:text-muted-foreground">
      {icon}{label}
      {count != null && <span className={cn("ml-auto rounded-full px-1.5 text-[11px] text-white", tone === "amber" ? "bg-amber-500" : "bg-blue-600")}>{count}</span>}
    </button>
  )
}

function ChannelItem({ c, active, onClick }: { c: Channel; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cn("flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-sidebar-accent", active && "bg-sidebar-accent font-medium", c.unread && !active && "font-semibold")}>
      <HashIcon className="size-3.5 text-muted-foreground" />
      {c.name}
      {c.repo && <FolderGit2Icon className="ml-auto size-3 text-muted-foreground" />}
      {c.unread && !active ? <span className={cn("rounded-full bg-blue-600 px-1.5 text-[11px] text-white", !c.repo && "ml-auto")}>{c.unread}</span> : null}
    </button>
  )
}
