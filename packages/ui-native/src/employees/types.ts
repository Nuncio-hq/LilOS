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
  entries: ThreadEntry[];
};

/* ── Pickers (web: WorkspacePicker + ModelPicker) ─────────────────────────── */

export type FolderOption = {
  id: string;
  project: string;
  path: string;
  /** [] = not a git repo: edits land in the folder directly. */
  branches: string[];
  workstreams: { branch: string; path: string; from: string }[];
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
};

export type ModelPick = { model: string; effort?: string; fast?: boolean };

/** An engine's model provider; `logo` = models.dev slug (web: ModelProvider). */
export type ModelProviderRow = { id: string; name: string; logo?: string };
