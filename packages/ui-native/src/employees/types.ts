import type { OrbState, OrbTone } from "../components/orb";

/* View models for the employee screens — shaped for display, not a wire
   contract (the relay's real types land in packages/contracts later). */

export type EmployeeRow = {
  id: string;
  name: string;
  role: string;
  tone: OrbTone;
  state: OrbState;
  /** What they're doing now, e.g. "Sorting inbox" or "Waiting on you · ac-80 flake". */
  now: string;
  /** Ticket key shown before `now`, e.g. "LIL-7". */
  ticket?: string;
  /** Right-hand time: "now", "6m", "10:12". */
  when: string;
};

export type ChannelRow = {
  id: string;
  name: string;
  unread?: number;
  /** Someone working in it right now (shows their orb + dots). */
  activeTone?: OrbTone;
};

export type ProjectGroup = {
  id: string;
  name: string;
  /** Short key, e.g. "LIL". */
  key: string;
  channels: ChannelRow[];
};

/** Something an employee is blocked on until you choose. */
export type Approval = {
  id: string;
  employeeId: string;
  employee: string;
  tone: OrbTone;
  session: string;
  /** The wire ask's kind; a question can't be approved (it needs free text)
      so surfaces hide its Approve pill. Absent = approval (prototype rows). */
  kind?: "approval" | "plan" | "question";
  /** Why, in one sentence. */
  reason: string;
  /** A shell command it wants to run… */
  command?: string;
  /** …or a file it wants to post. */
  file?: { name: string; detail: string };
  /** "2m" */
  age: string;
};

export type SessionState =
  | "done"
  | "needs-you"
  | "working"
  | "failed"
  | "stopped";

/** One DM row: your message and the session it opened, summarised. */
/** A pull request a session opened (web: PullRequest, trimmed to what the
    phone shows). A session can open several; newest last. */
export type PullRequestRef = {
  number: number;
  title: string;
  status: "draft" | "open" | "merged" | "closed";
  /** CI on an open PR. */
  checks?: "pending" | "passing" | "failing";
};

export type SessionTurn = {
  id: string;
  prompt: string;
  title: string;
  state: SessionState;
  when: string;
  /** Project the session runs in ("LilOS"); absent = just chat. */
  folder?: string;
  branch?: string;
  added?: number;
  removed?: number;
  replies?: number;
  /** The employee's latest words, shown as the card's body. */
  preview?: string;
  /** What it's doing right now (working sessions). */
  live?: string;
  steps?: number;
  model?: string;
  approval?: Approval;
  prs?: PullRequestRef[];
};

/** A helper a turn spun off (web: Subagent): its own subagent, with its
    steps + report, or another employee working in their own session —
    then only a link to that thread. */
export type SubagentRow = {
  id: string;
  name: string;
  /** The brief the parent handed it. */
  task: string;
  status: "running" | "done" | "failed" | "stopped";
  steps: ToolStep[];
  result?: string;
  /** Seconds it ran. */
  dur?: number;
  employee?: { id: string; name: string; tone: OrbTone; threadId?: string };
};

/** A plan an employee proposes before editing (web: Plan). Approved, its
    steps are the live checklist; replaced = a newer version took over. */
export type PlanRow = {
  id: string;
  /** tasks = the employee's own working list: no OK asked, it just ticks. */
  kind?: "plan" | "tasks";
  version: number;
  goal?: string;
  steps: {
    text: string;
    files?: string[];
    status: "pending" | "in_progress" | "completed" | "cancelled";
  }[];
  risks?: string[];
  status: "proposed" | "approved" | "replaced" | "rejected";
};

/** Tokens in a session's context window. */
export type ContextUsage = {
  input: number;
  output: number;
  reasoning: number;
  cache: number;
  /** The model's window size. */
  max: number;
};

/** A process left running for the session (web: BackgroundJob). */
export type BackgroundJobRow = {
  id: string;
  command: string;
  status: "running" | "exited" | "failed" | "stopped";
  started: string;
  uptime: string;
  url?: string;
  exitCode?: number;
  /** Output tail. */
  log: string;
  by?: string;
};

/** One tool call inside an agent turn (web: Step). */
export type ToolStep = {
  id: string;
  /** Engine tool id: terminal, read_file, write_file, patch, search_files, web_search… */
  tool: string;
  /** The one argument worth showing: a path, a command, a query. */
  arg?: string;
  output?: string;
  running?: boolean;
  add?: number;
  del?: number;
  /** Unified diff of an edit (web: Diff.patch) — shown when the step opens. */
  patch?: string;
};

export type AgentEntry = {
  kind: "agent";
  id: string;
  time: string;
  reasoning?: string;
  /** Seconds spent thinking. */
  thought?: number;
  steps?: ToolStep[];
  text?: string;
  /** Still running: reasoning shimmers, the last step is live. */
  live?: boolean;
  /** You pressed Stop mid-turn. */
  stopped?: boolean;
  /** The reply is streaming (steps are over for now). */
  writing?: boolean;
  /** What you decided on this turn's approval — kept as a receipt. */
  decided?: { approved: boolean; what: string };
  approval?: Approval;
  /** The plan this turn proposed (issue #175; web: Plan). */
  plan?: PlanRow;
  /** Helpers this turn spun off (issue #170; web: Subagent). */
  subagents?: SubagentRow[];
  /** The PR this turn opened — card under the reply (#159; web: PrCard). */
  pr?: PullRequestRef;
  /** Worked for 21s · Opus 5.5 · High · 5 steps · 2 files changed */
  footer?: { dur?: number; model?: string; effort?: string; files?: number };
};

export type ThreadEntry =
  | {
      kind: "user";
      id: string;
      time: string;
      text: string;
      /** Sent while the employee was mid-turn; runs when it finishes. */
      queued?: boolean;
    }
  | AgentEntry;

/** A session opened as a thread (web: ThreadView). */
export type ThreadDetail = {
  id: string;
  title: string;
  state: SessionState;
  employee: { id: string; name: string; tone: OrbTone };
  /** DM list time: "Mon", "Yesterday", "4m", "now". */
  when: string;
  /** Thread info: "Yesterday 17:02". */
  started: string;
  /** "LilOS" + "~/Desktop/Oscar/LilOS"; absent = just chat. */
  folder?: { name: string; path: string };
  /** feat/relay-reconnect, off main in .lilos/wt/lil-9 */
  branch?: { name: string; detail: string };
  model: string;
  session: string;
  usage?: string;
  /** PRs this session opened, oldest first. */
  prs?: PullRequestRef[];
  /** Token breakdown of the context window (web: Usage + window size). */
  context?: ContextUsage;
  /** Background processes of this session, newest last. */
  jobs?: BackgroundJobRow[];
  entries: ThreadEntry[];
};

/* ── Pickers (web: WorkspacePicker + ModelPicker) ─────────────────────────── */

export type FolderOption = {
  id: string;
  project: string;
  path: string;
  /** The git probe is still in flight — mode rows wait on it. */
  probing?: boolean;
  /** The path is gone from the Mac — picking it can't open a session. */
  missing?: boolean;
  /** [] = not a git repo (or probe unanswered): edits land in the folder directly. */
  branches: string[];
  workstreams: { branch: string; path: string; from?: string }[];
};

/** new = worktree + branch off `base` · existing = continue a workstream · direct = edit `base` in place. */
export type WorkspacePick = {
  folder: string | null;
  base: string;
  mode: "new" | "existing" | "direct";
  existing?: string;
};

export type ModelRow = {
  id: string;
  name: string;
  provider: string;
  efforts?: string[];
  defaultEffort?: string;
  fast?: boolean;
  /** The session runs a model the catalog omits (web `notInList`): the row
      carries the hint instead of offering a pick the engine can't honour. */
  notInList?: boolean;
};

export type ModelPick = {
  model: string;
  /** Model ids are unique only per provider on multi-provider engines —
      the pick pins the provider when it knows one (web ModelChoice). */
  provider?: string;
  effort?: string;
  fast?: boolean;
};

/** The shared "Edit models" hide list (web `ModelVisibility`): provider
    ids plus `${provider}::${id}` model keys — relay-persisted, one list
    for the whole company. */
export type ModelVisibility = { providers: string[]; models: string[] };

/** An engine's model provider; `logo` = models.dev slug (web: ModelProvider). */
export type ModelProviderRow = { id: string; name: string; logo?: string };

/** One folder level on the paired Mac, as the relay lists it (web: FsDir). */
export type MacDir = {
  /** Current branch when this folder is a git repo. */
  branch?: string;
  folders: { name: string; path: string; branch?: string }[];
};
