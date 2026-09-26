/* Domain types for the LilOS UI surfaces. Presentational props speak these; the prototype's mock data
   (and, later, the relay wire types in packages/contracts) produce them. Wire types are NOT defined here —
   this file is the UI contract only (issue #12; wire schemas live in packages/contracts). */

export type Status = "online" | "busy" | "offline";
export type RespondTo = "me" | "selected" | "anyone";
export type Employee = {
  id: string;
  name: string;
  role: string;
  status: Status;
  profile: string;
  model: string;
  now: string;
  instructions: string;
  respondTo: RespondTo;
};
export type Channel = {
  id: string;
  name: string;
  repo?: string;
  unread?: number;
  employees: string[];
  dm?: boolean;
};
export type Project = {
  id: string;
  name: string;
  key: string;
  channels: Channel[];
};
export type Diff = {
  path: string;
  status: "added" | "modified" | "deleted";
  add: number;
  del: number;
  patch: string;
};
export type GitCommit = {
  hash: string;
  message: string;
  files: { path: string; status: Diff["status"]; add: number; del: number }[];
};
/* A step = one Hermes tool call (tool.start → tool.complete). The workbench is derived only from steps:
   inline_diff → Changes, terminal output → Terminal, git commit → Commits. */
export type Step = {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  running?: boolean;
  diff?: Diff;
  commit?: GitCommit;
};
/* Hermes todo tool (todo.updated) statuses */
export type Todo = {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
};
/* phase mirrors the Hermes turn events: message.start → submitted, reasoning.delta → thinking,
   tool.start/complete → tools, message.delta → typing, message.complete → done, session.interrupt → stopped */
export type Phase =
  | "submitted"
  | "thinking"
  | "tools"
  | "typing"
  | "done"
  | "stopped";
/* One file attached in the composer (image, etc.). The chip shows name; mediaType drives previews. */
export type AttachedFile = { name: string; mediaType: string };
export type Reply = {
  from: string;
  time: string;
  text: string;
  steps?: Step[];
  streaming?: string;
  approval?: { id: string; command: string; note: string };
  startProposal?: { title: string };
  reasoning?: string;
  thought?: number;
  phase?: Phase;
  live?: boolean;
  id?: string;
  steers?: string[];
  dur?: number;
  attachments?: AttachedFile[];
};
export type Usage = {
  input: number;
  output: number;
  reasoning: number;
  cache: number;
};
export type CheckRun = {
  name: string;
  status: "pending" | "passed" | "failed" | "skipped";
  /** CI detail link when the forge reports one. */
  url?: string;
};
export type PrComment = {
  from: string;
  time: string;
  text: string;
  monitor?: boolean;
};
/** gh merge methods offered by the PR tab's confirmation (issue #37). */
export type MergeMethod = "squash" | "merge" | "rebase";
/* A pull request an employee opened from its worktree. Read back from the
   forge by the host API (`forge.pr` → `gh pr view`), never by an engine. */
export type PullRequest = {
  number: number;
  repo: string;
  title: string;
  body: string;
  status: "open" | "merged" | "closed";
  /** GitHub mergeability when the forge reports it (issue #37). */
  mergeable?: "mergeable" | "conflicting" | "unknown";
  merged?: { by: string; at: string; sha: string };
  author: string;
  base: string;
  head: string;
  opened: string;
  checks: CheckRun[];
  comments: PrComment[];
};
/* A designed failure/notice attached to a session (model error, sleep interrupt, …).
   retry:true means the session can be re-prompted in place. */
export type SessionAlert = {
  kind: "model" | "sleep" | "generic";
  text: string;
  retry?: boolean;
};
export type Thread = {
  session: string;
  ticket?: string;
  branch?: string;
  /* User-visible session title (renamed by the user; unset = first message is the name). */
  title?: string;
  /* Archived sessions hide from the DM list until the Archived disclosure is opened. */
  archived?: boolean;
  alert?: SessionAlert;
  replies: Reply[];
  usage?: Usage;
  todos?: Todo[];
  queue?: string[];
  model?: string;
  pr?: PullRequest;
  ws?: Workspace;
};
export type Work = {
  ticket: string;
  branch?: string;
  title: string;
  by?: string;
  path?: string;
};

/* Local folders a project owns (Hermes: projects.add_folder / projects.for_cwd). A session's cwd is either the
   folder itself or a worktree inside it: a "workstream" = one branch + one worktree. */
export type Workstream = { branch: string; path: string; from: string };
export type Folder = {
  id: string;
  project: string;
  path: string;
  repo?: string;
  branches: string[];
  workstreams: Workstream[];
}; // branches [] = not a git repo
/* The machine's folders as the gateway sees them (complete.path / projects.for_cwd). Passed IN to AddFolderDialog. */
export type FsDir = {
  git?: { branches: string[]; remote?: string };
  children?: string[];
};

/* Picked in the composer before the first message of a session.
   new = git worktree add -b <branch> <base> · existing = reuse a workstream's worktree · direct = edit the folder checkout on <base>. */
export type WsMode = "new" | "existing" | "direct";
export type WsPick = {
  folder: string | null;
  base: string;
  mode: WsMode;
  existing?: string;
};
export type Workspace = {
  folder: string;
  project: string;
  label?: string;
  repo?: string;
  mode: WsMode;
  base: string;
  branch: string;
  cwd: string;
  worktree?: string;
};
export type HireDraft = {
  name: string;
  role: string;
  instructions: string;
  model: string;
};
export type TicketRow = {
  id: string;
  title: string;
  status: string;
  who: string;
  ch: string;
  branch?: string;
};
/**
 * An engine profile as the engine reports it (`agents.list`/`agents.describe`).
 * Engine-agnostic: the id is the profile handle the engine starts sessions
 * with; `name` is its display name when the engine sets one.
 */
export type EngineProfile = {
  id: string;
  name?: string;
  model: string;
  soul: string;
  skills: number;
};
export type Msg =
  | {
      kind: "msg";
      id: string;
      from: string;
      time: string;
      text: string;
      thread?: Thread;
      hire?: HireDraft;
      attachments?: AttachedFile[];
    }
  | { kind: "event"; id: string; text: string; ticket: string };

/* The chain a session needs: relay → harness → engine → model. One line each for the
   status surface; the app builds the rows (and the Copy diagnostics text) from real
   health checks later — this shape is the contract. */
export type ComponentState = "ok" | "connecting" | "degraded" | "down";
export type StatusComponent = {
  id: "relay" | "harness" | "engine" | "model";
  label: string;
  state: ComponentState;
  reason: string;
};

/* Sidebar badge per employee: running turns (blue) / turns waiting on Oscar (amber). */
export type EmpBadge = { running?: number; approvals?: number };

/* People (non-employee) as display metadata for avatars/names. Passed IN from the app. */
export type Human = { name: string; color: string; guest?: boolean };
/* Lookup used across surfaces: employee by id. */
export type EmpFn = (id: string) => Employee | undefined;
/* Lookup used across surfaces: human (non-employee) by id. */
export type HumanFn = (id: string) => Human | undefined;

/* Theme: light / dark / follow the OS. State lives in the app; ThemeToggle is presentational. */
export type Theme = "light" | "dark" | "system";

/* Model id shown in pickers/hire dialog (the list itself is app data, passed in). */
export type ModelOption = string;

/* Workbench tab ids (Focus). */
export type WbTab = "changes" | "files" | "terminal" | "preview" | "pr";

/* Live host accessors for a session's real cwd (fs/git issue #11, forge #37).
   An accessor resolves null when the host is unreachable → the caller falls
   back to mock data; `forge.pr` resolving `{ pr: null }` is the host's real
   answer "this checkout has no PR" (controls render only when handlers exist,
   D-#19). */
export type HostAccessors = {
  tree: (cwd: string) => Promise<string[] | null>;
  diff: (cwd: string) => Promise<Diff[] | null>;
  read: (
    cwd: string,
    path: string,
  ) => Promise<{
    content: string;
    binary: boolean;
    truncated: boolean;
  } | null>;
  pr?: (cwd: string) => Promise<{ pr: PullRequest | null } | null>;
  /** Posts a comment via `gh`; resolves the comment URL; throws on failure. */
  prComment?: (cwd: string, body: string) => Promise<string>;
  /** Merges via `gh`; resolves the re-read PR; throws on failure. */
  prMerge?: (cwd: string, method: MergeMethod) => Promise<PullRequest>;
};
