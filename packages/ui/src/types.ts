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
  | "waiting"
  | "typing"
  | "done"
  | "stopped";
/**
 * A file the composer attaches to a send (issue #31). `url` carries the
 * image's data URL out of PromptInput — the app decodes the base64 payload
 * from it to ship bytes over the wire, and the chip preview renders it.
 */
export type AttachedFile = {
  name: string;
  mediaType: string;
  url?: string;
};
export type Reply = {
  from: string;
  time: string;
  /** Model that produced this turn (engine `turn.started.model`). */
  model?: string;
  /** Reasoning effort / fast mode the turn ran with, when the engine reports them. */
  effort?: string;
  fast?: boolean;
  text: string;
  steps?: Step[];
  streaming?: string;
  approval?: { id: string; command: string; note: string };
  startProposal?: { title: string };
  reasoning?: string;
  thought?: number;
  phase?: Phase;
  live?: boolean;
  /** Engine request kind the turn waits on (phase === "waiting"), e.g. approval. */
  waitingOn?: "approval" | "question";
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
  /* The rest of the session's pick (model provider, effort, fast) — next turn uses it. */
  provider?: string;
  effort?: string;
  fast?: boolean;
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
  /* The path is gone from disk (#113): shows in recents, can't be picked. */
  missing?: boolean;
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

/* One row of the `@` menu's Files section (#105): a file or dir inside the
   session's folder, relative to it. The mention sent is the plain `@path`
   text — contents are never inlined (the issue's "Path only" decision). */
export type FileMention = { path: string; kind: "file" | "dir" };
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
  /** Engine model id — opaque, may contain `/` (#92 AC-8). */
  model: string;
  /** The model's provider — ids are unique only per provider. */
  provider?: string;
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
   health checks later — this shape is the contract. `blocked` (#53) means the leg is
   down only because an upstream leg is down — neutral, and it does not count as an
   issue. `hint` is the plain next step; `detail` the raw technical line shown collapsed. */
export type ComponentState =
  | "ok"
  | "connecting"
  | "degraded"
  | "blocked"
  | "down";
export type StatusComponent = {
  id: "relay" | "harness" | "engine" | "model";
  label: string;
  state: ComponentState;
  reason: string;
  hint?: string;
  detail?: string;
};

/* Sidebar badge per employee: running turns (blue) / turns waiting on the user (amber). */
export type EmpBadge = { running?: number; approvals?: number };

/* People (non-employee) as display metadata for avatars/names. Passed IN from the app.
   `image` is an optional avatar image URL; without it the avatar falls back to
   the initial on `color` (a Tailwind bg-* class). */
export type Human = {
  name: string;
  color: string;
  guest?: boolean;
  image?: string;
};
/* Lookup used across surfaces: employee by id. */
export type EmpFn = (id: string) => Employee | undefined;
/* Lookup used across surfaces: human (non-employee) by id. */
export type HumanFn = (id: string) => Human | undefined;
/* The signed-in human's author id — surfaces resolve the viewer's display
   name via `human(VIEWER_ID)` so it always reads the live identity (#118). */
export const VIEWER_ID = "user";

/* Theme: light / dark / follow the OS. State lives in the app; ThemeToggle is presentational. */
export type Theme = "light" | "dark" | "system";

/* One selectable model, as the engine reports it via `models.list` (issue #30):
   the picker groups rows by `provider`; `name` is the friendlier label when present.
   `provider` is set only by multi-provider harnesses (Hermes); single-vendor engines
   (Codex, Claude Code) leave it unset — the pick is never a "provider/model" string.
   `efforts` is the engine's ordered (low → high) list for THIS model; absent = no
   reasoning control. When an engine can't say per model, its adapter passes its full
   ladder (Hermes behaviour) — the UI never probes or guesses. `fast` = the model has a
   fast/priority tier (billing is the harness's concern). */
export type ModelOption = {
  id: string;
  name?: string;
  provider?: string;
  efforts?: string[];
  defaultEffort?: string;
  fast?: boolean;
};

/* A provider's display row (multi-provider engines only). `logo` is a
   models.dev slug when the engine knows the vendor (e.g. "anthropic"). */
export type ModelProvider = { id: string; name: string; logo?: string };

/* What the picker reports: model (+ its provider when the engine has several),
   reasoning effort and fast mode. Applies from the next turn. */
export type ModelChoice = {
  model: string;
  provider?: string;
  effort?: string;
  fast?: boolean;
};

/* Models the user hid from the picker — one list for every employee, owned by
   the app (Hermes keeps no such setting). Hidden providers hide their future
   models too; a model new since the last edit is visible by default. */
export type ModelVisibility = { providers: string[]; models: string[] };

/* Optional picker extras; each control renders only when its handler is passed (D-#19). */
export type ModelPickerExtras = {
  providers?: ModelProvider[];
  visibility?: ModelVisibility;
  onVisibility?: (v: ModelVisibility) => void;
  /* Engine caches its catalog (Hermes): re-fetch it. */
  onRefresh?: () => Promise<void>;
};

/* Workbench tab ids (Focus). */
export type WbTab = "changes" | "files" | "terminal" | "preview" | "pr";

/* Open-in-editor / Reveal-in-Finder targets (issue #110): the apps os.open
   knows. Editors arrive from os.editors, already in preference order —
   [0] is the default until the settings picker lands (#132). */
export type OsApp = "vscode" | "cursor" | "zed" | "xcode" | "finder";
export type OsEditor = { id: Exclude<OsApp, "finder">; name: string };

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
  /** os.editors (issue #110): editors detected on the session machine, in
     preference order; [] when none. */
  osEditors?: () => Promise<OsEditor[]>;
  /** os.open (issue #110): open `path` (or cwd itself) in an editor, at `line`
     when the editor takes one, or reveal it in Finder; throws on failure. */
  osOpen?: (
    cwd: string,
    path: string,
    app: OsApp,
    line?: number,
  ) => Promise<void>;
};
